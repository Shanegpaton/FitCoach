import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ServerWorkoutProposal } from '../coach';
import { cacheApprovedWorkout, db, syncRootId } from '../db';
import { formatLoad, type Profile, type Session } from '../domain';
import { backendRequest } from '../chatgptVm';
import { ProposalReadiness } from '../ui';

function WorkoutSnapshot({ value, unit }: { value: Session; unit: Profile['unit'] }) {
  const load = (kg: number | null) => kg == null ? '—' : `${formatLoad(kg, unit)} ${unit}`;
  return <div className="workout-proposal-snapshot">
    <h4>{value.name}</h4><p>{value.date}</p>
    <p>Started: {new Date(value.startedAt).toLocaleString()}<br />Finished: {value.completedAt ? new Date(value.completedAt).toLocaleString() : '—'}</p>
    {value.notes && <p className="workout-proposal-notes">Notes: {value.notes}</p>}
    {value.blocks.map((block, index) => <section key={block.id}>
      <h5>{index + 1}. {block.name}</h5>
      <p>{block.loadMode === 'bodyweight' ? 'Bodyweight · added load' : 'External load'} · {block.restSeconds}s rest</p>
      {block.supersetId && <p>Superset: {value.blocks.filter(b => b.supersetId === block.supersetId).map(b => b.name).join(' + ')}</p>}
      {block.notes && <p className="workout-proposal-notes">{block.notes}</p>}
      <div className="workout-proposal-table" role="region" aria-label={`${block.name} sets`} tabIndex={0}><table>
        <thead><tr><th>Set</th><th>Type</th><th>Reps</th><th>Load</th><th>Effort</th><th>Target</th><th>Done</th></tr></thead>
        <tbody>{block.sets.map((set, i) => <tr key={set.id}><td>{i + 1}</td><td>{set.kind}{set.chainId ? ' · linked' : ''}</td><td>{set.reps ?? '—'}</td><td>{load(set.kg)}</td><td>{set.effort ?? '—'}</td><td>{set.targetReps} reps · {load(set.targetKg)}</td><td>{set.done ? 'Yes' : 'No'}</td></tr>)}</tbody>
      </table></div>
    </section>)}
  </div>;
}

export function WorkoutProposal({ proposal, userId, ready, unit, onStatus, run }: {
  proposal: ServerWorkoutProposal; userId: string; ready: boolean; unit: Profile['unit'];
  onStatus: (status: ServerWorkoutProposal['status']) => void;
  run: (action: () => Promise<void>, success?: string) => Promise<unknown>;
}) {
  const starting = proposal.type === 'session_create';
  const active = proposal.session.status === 'active';
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const update = (status: ServerWorkoutProposal['status']) => { if (alive.current) onStatus(status); };
  const decide = async (accept: boolean) => {
    if (busy) return;
    setBusy(true);
    const database = db;
    try {
      await run(async () => {
        if (!navigator.onLine || database.ownerId !== userId) throw new Error('Sign in online to review workout edits.');
        if (accept) {
          if (!ready) throw new Error('Finish syncing before accepting a workout edit.');
          const [pending, conflicts, root] = await Promise.all([
            database.outbox.where('userId').equals(userId).count(),
            database.sync.where('userId').equals(userId).filter(item => item.kind === 'conflict').count(),
            database.sync.get(syncRootId(userId, starting ? 'plans' : 'sessions', starting ? proposal.targetPlanId! : proposal.targetSessionId)),
          ]);
          const expected = starting ? proposal.sourcePlanEtag : proposal.sourceEtag;
          if (starting && await database.sessions.where('status').equals('active').count())
            throw new Error('A workout is already active on this device. Resume or edit it instead.');
          if (pending || conflicts || (root?.etag && root.etag !== expected))
            throw new Error('Sync changes and resolve conflicts before accepting. If the workout changed, ask Coach for a fresh edit.');
        }
        try {
          if (accept) {
            const result = await backendRequest<{ session: Session; etag: string }>(userId, `coach/proposals/${proposal.id}/approve`, { method: 'POST' });
            update('approved');
            await cacheApprovedWorkout(result.session, proposal.sourceEtag, result.etag, database);
            window.dispatchEvent(new Event('fitcoach:sync-now'));
          } else {
            const result = await backendRequest<ServerWorkoutProposal>(userId, `coach/proposals/${proposal.id}/reject`, { method: 'POST' });
            update(result.status);
          }
        } catch (error) {
          // Approval can succeed even when its response is lost. Read its durable
          // status instead of inviting a second write with uncertain results.
          const latest = await backendRequest<ServerWorkoutProposal>(userId, `coach/proposals/${proposal.id}`).catch(() => undefined);
          if (latest) update(latest.status);
          window.dispatchEvent(new Event('fitcoach:sync-now'));
          throw error;
        }
      }, accept ? (starting ? 'Workout started' : 'Workout changes accepted') : 'Workout changes rejected');
    } finally { if (alive.current) setBusy(false); }
  };
  return <div className="proposal-card workout-proposal" aria-label={starting ? 'Workout start proposal' : 'Workout edit proposal'}>
    <span className="eyebrow">{starting ? 'START WORKOUT PROPOSAL' : active ? 'ACTIVE WORKOUT EDIT PROPOSAL' : 'WORKOUT EDIT PROPOSAL'}</span><h3>{proposal.session.name}</h3>
    <p>{starting ? 'Review this workout. It starts only when you accept.' : 'Review the recorded workout and proposed changes. Nothing changes until you accept.'}</p>
    <details open><summary>Proposed workout</summary><WorkoutSnapshot value={proposal.session} unit={unit} /></details>
    {proposal.beforeSession && <details><summary>Original workout</summary><WorkoutSnapshot value={proposal.beforeSession} unit={unit} /></details>}
    <small>{proposal.beforeSession ? 'The original snapshot stays in this proposal. ' : ''}Expires {new Date(proposal.expiresAt).toLocaleString()}.</small>
    {proposal.status === 'pending' && <ProposalReadiness ready={ready} />}
    {proposal.status === 'pending' ? <div className="proposal-actions">
      <button className="button primary" disabled={busy || !ready || !navigator.onLine} onClick={() => void decide(true)}>{busy ? 'Saving decision…' : starting ? 'Start workout' : 'Accept changes'}</button>
      <button className="button" disabled={busy || !navigator.onLine} onClick={() => void decide(false)}>Reject changes</button>
    </div> : <p role="status">{proposal.status === 'approved' ? (starting ? 'Workout started' : active ? 'Applied to active workout' : 'Applied to workout history') : `Workout edit ${proposal.status}`}</p>}
    {proposal.status === 'approved' && active && <Link className="button secondary" to={`/workout/${proposal.targetSessionId}`}>Open workout</Link>}
  </div>;
}

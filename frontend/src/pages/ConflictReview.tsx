import { useEffect, useState } from 'react';
import type { Plan, Session } from '../domain';
import type { SyncRecord } from '../db';
import { db } from '../db';
import { conflictSnapshot, resolveConflict, type ConflictSnapshot } from '../sync';
import { Modal } from '../ui';
import { PlanEditor } from './Plans';

const copy = <T,>(value: T): T => structuredClone(value);
const label = (key: string) => key.replace(/([A-Z])/g, ' $1').replace(/^./, first => first.toUpperCase());
const preview = (value: unknown) => Array.isArray(value) ? `${value.length} item${value.length === 1 ? '' : 's'}`
  : typeof value === 'object' && value !== null ? 'Details' : String(value ?? '—');

export function ConflictReview({ conflict, onClose, onResolved }: {
  conflict: SyncRecord; onClose: () => void; onResolved: (message: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<ConflictSnapshot | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [editing, setEditing] = useState(false);
  const [planEditor, setPlanEditor] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void conflictSnapshot(db, conflict.id).then(value => {
      if (!alive) return;
      setSnapshot(value);
      setDraft(copy((value.local ?? value.remotePayload ?? {}) as Record<string, unknown>));
    }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : 'Could not load conflict.'); });
    return () => { alive = false; };
  }, [conflict.id]);
  const local = snapshot?.local as Record<string, unknown> | null;
  const cloud = snapshot?.remotePayload as Record<string, unknown> | null;
  const change = (key: string, value: unknown) => {
    if (raw !== null) {
      try {
        const next = { ...JSON.parse(raw), [key]: value } as Record<string, unknown>;
        setDraft(next); setRaw(JSON.stringify(next, null, 2)); setError('');
      } catch { setError('Fix the full record JSON before changing another field.'); }
    } else setDraft(current => current ? { ...current, [key]: value } : current);
  };
  const resolve = async (choice: 'use-cloud' | 'use-device' | 'edit-merge') => {
    if (!snapshot || busy) return;
    setBusy(true); setError('');
    try {
      const result = choice === 'edit-merge' ? raw === null ? draft : JSON.parse(raw) : undefined;
      await resolveConflict(db, conflict.id, choice, snapshot, result);
      onResolved(choice === 'use-cloud' ? 'Cloud version saved here. Your local copy is in recovery.'
        : 'Resolution saved here and pending upload. The other version is in recovery.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not resolve this conflict.');
    } finally { setBusy(false); }
  };
  const keys = Array.from(new Set([...Object.keys(local ?? {}), ...Object.keys(cloud ?? {})]))
    .filter(key => key !== 'id' && JSON.stringify(local?.[key]) !== JSON.stringify(cloud?.[key]));
  const setSession = (update: (session: Session) => void) => {
    try {
      const next = copy(raw === null ? draft : JSON.parse(raw)) as Session;
      update(next); setDraft(next as unknown as Record<string, unknown>);
      if (raw !== null) setRaw(JSON.stringify(next, null, 2));
      setError('');
    } catch { setError('Fix the full record JSON before changing another field.'); }
  };
  return <Modal title="Resolve sync conflict" onClose={() => { if (!busy) onClose(); }} wide>
    <p className="field-hint">{conflict.entity} · {conflict.entityId}</p>
    <p>Review both versions before choosing. The version you replace is kept as a recovery copy.</p>
    {!snapshot ? <p role="status">Loading both versions…</p> : <>
      <div className="conflict-versions">
        <details><summary>This device</summary><pre>{local ? JSON.stringify(local, null, 2) : 'Deleted on this device'}</pre></details>
        <details><summary>Cloud</summary><pre>{cloud ? JSON.stringify(cloud, null, 2) : 'Deleted in the cloud'}</pre></details>
      </div>
      {snapshot.remoteDeleted && <p className="field-hint">The cloud record was deleted. Its ID cannot be reused. Use cloud keeps your device’s version in recovery.</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <div className="action-row"><button className="button secondary" disabled={busy} onClick={() => void resolve('use-cloud')}>Use cloud</button><button className="button secondary" disabled={busy || snapshot.remoteDeleted} onClick={() => void resolve('use-device')}>Use this device</button><button className="button primary" disabled={busy || snapshot.remoteDeleted} onClick={() => { setEditing(true); setRaw(null); }}>Edit and merge</button></div>
      {editing && !snapshot.remoteDeleted && draft && <section className="conflict-edit">
        <h3>Choose the final version</h3>
        <p className="field-hint">Pick values from either version, then edit any field you want. The record keeps its original ID.</p>
        <div className="action-row"><button className="button secondary" onClick={() => { if (local) { setDraft(copy(local)); setRaw(null); } }}>Start with this device</button><button className="button secondary" onClick={() => { if (cloud) { setDraft(copy(cloud)); setRaw(null); } }}>Start with cloud</button></div>
        {keys.map(key => <div className="conflict-field" key={key}><strong>{label(key)}</strong><span>Final: {preview(draft[key])}</span><small>Device: {preview(local?.[key])} · Cloud: {preview(cloud?.[key])}</small><div className="action-row"><button className="text-button" disabled={!local || !(key in local)} onClick={() => change(key, copy(local?.[key]))}>Use device value</button><button className="text-button" disabled={!cloud || !(key in cloud)} onClick={() => change(key, copy(cloud?.[key]))}>Use cloud value</button></div></div>)}
        {conflict.entity === 'profile' && <><label>Goals<textarea value={String(draft.goals ?? '')} onChange={event => change('goals', event.target.value)} /></label><div className="form-grid"><label>Experience<input value={String(draft.experience ?? '')} onChange={event => change('experience', event.target.value)} /></label><label>Session minutes<input type="number" min={10} max={180} value={Number(draft.sessionMinutes ?? 45)} onChange={event => change('sessionMinutes', Number(event.target.value))} /></label></div><label>Equipment, separated by commas<input value={Array.isArray(draft.equipment) ? draft.equipment.join(', ') : ''} onChange={event => change('equipment', event.target.value.split(',').map(item => item.trim()).filter(Boolean))} /></label><label>Training days (0 Sunday to 6 Saturday), separated by commas<input value={Array.isArray(draft.trainingDays) ? draft.trainingDays.join(', ') : ''} onChange={event => change('trainingDays', event.target.value.split(',').filter(Boolean).map(Number))} /></label><label>Weight unit<select value={String(draft.unit ?? 'lb')} onChange={event => change('unit', event.target.value)}><option value="lb">Pounds</option><option value="kg">Kilograms</option></select></label></>}
        {conflict.entity === 'exercises' && <><label>Name<input value={String(draft.name ?? '')} onChange={event => change('name', event.target.value)} /></label><div className="form-grid"><label>Muscle group<input value={String(draft.muscle ?? '')} onChange={event => change('muscle', event.target.value)} /></label><label>Equipment<input value={String(draft.equipment ?? '')} onChange={event => change('equipment', event.target.value)} /></label></div><label>Load type<select value={String(draft.loadMode ?? 'external')} onChange={event => change('loadMode', event.target.value)}><option value="external">External weight</option><option value="bodyweight">Bodyweight</option></select></label></>}
        {conflict.entity === 'plans' && <><p className="field-hint">Choose a workout list above, then edit the plan in the familiar plan editor.</p><button className="button secondary" disabled={raw !== null} onClick={() => setPlanEditor(true)}>Edit plan details</button></>}
        {conflict.entity === 'sessions' && <><label>Workout name<input value={String(draft.name ?? '')} onChange={event => change('name', event.target.value)} /></label><label>Notes<textarea value={String(draft.notes ?? '')} onChange={event => change('notes', event.target.value)} /></label>{(draft as Session).blocks?.map((block, bi) => <section className="conflict-block" key={block.id}><strong>{block.name}</strong><label>Exercise notes<textarea value={block.notes} onChange={event => setSession(session => { session.blocks[bi].notes = event.target.value; })} /></label>{block.sets.map((set, si) => <div className="form-grid compact" key={set.id}><label>Set {si + 1} weight (kg)<input type="number" min={0} step="any" value={set.kg ?? ''} onChange={event => setSession(session => { session.blocks[bi].sets[si].kg = event.target.value === '' ? null : Number(event.target.value); })} /></label><label>Set {si + 1} reps<input type="number" min={1} max={100} value={set.reps ?? ''} onChange={event => setSession(session => { session.blocks[bi].sets[si].reps = event.target.value === '' ? null : Number(event.target.value); })} /></label><label>Set {si + 1} RPE<input type="number" min={1} max={10} step="0.5" value={set.effort ?? ''} onChange={event => setSession(session => { session.blocks[bi].sets[si].effort = event.target.value === '' ? null : Number(event.target.value); })} /></label><label className="conflict-check"><input type="checkbox" checked={set.done} onChange={event => setSession(session => { session.blocks[bi].sets[si].done = event.target.checked; })} />Set {si + 1} completed</label></div>)}</section>)}</>}
        {conflict.entity === 'schedule-overrides' && <div className="form-grid"><label>Original date<input type="date" value={String(draft.originalDate ?? '')} onChange={event => change('originalDate', event.target.value)} /></label><label>Scheduled date<input type="date" value={String(draft.date ?? '')} onChange={event => change('date', event.target.value)} /></label></div>}
        <details className="conflict-advanced" onToggle={event => {
          if (event.currentTarget.open) setRaw(current => current ?? JSON.stringify(draft, null, 2));
          else if (raw !== null) {
            try { setDraft(JSON.parse(raw)); setRaw(null); setError(''); }
            catch { setError('The full record JSON is invalid. Reopen it to fix the text.'); }
          }
        }}><summary>Edit full record data</summary><p className="field-hint">For changes to sets, exercises, or IDs inside a plan, edit the JSON below. The record ID must stay the same. Closing this section applies valid JSON to the fields above.</p><textarea aria-label="Final record JSON" rows={12} value={raw ?? JSON.stringify(draft, null, 2)} onChange={event => setRaw(event.target.value)} /></details>
        <button className="button primary" disabled={busy} onClick={() => void resolve('edit-merge')}>{busy ? 'Saving…' : 'Save and upload final version'}</button>
      </section>}
      {planEditor && conflict.entity === 'plans' && <PlanEditor initial={draft as Plan} title="Edit final plan" saveLabel="Use edited plan" onClose={() => setPlanEditor(false)} onSave={async plan => { setDraft(plan as unknown as Record<string, unknown>); setRaw(null); setPlanEditor(false); }} />}
    </>}
  </Modal>;
}

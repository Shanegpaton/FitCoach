import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, MessageCircle, Plus, Send, Sparkles, X } from 'lucide-react';
import { db, applyProposal, cacheApprovedProposal, enqueueChange, putLocalChange, syncRootId } from '../db';
import { assistantMessage, sampleCoach } from '../coach';
import { backendChatGPTRequest, backendRequest, liveCoach, type ChatGPTConnection } from '../chatgptVm';
import { useAuth } from '../auth';
import { formatLoad, uid, type Exercise, type Message, type Plan, type Profile, type Proposal } from '../domain';
import { useApp } from '../state';
import { PlanEditor } from './Plans';

function ProposalOperation({ operation, before, after, exercises, unit }: {
  operation: Record<string, unknown>; before?: Plan; after: Plan; exercises: Exercise[]; unit: Profile['unit'];
}) {
  const type = String(operation.type ?? '');
  const workoutId = String(operation.workoutId ?? '');
  const blockId = String(operation.blockId ?? '');
  const oldWorkout = before?.workouts.find(w => w.id === workoutId);
  const newWorkout = after.workouts.find(w => w.id === workoutId);
  const oldBlock = oldWorkout?.blocks.find(b => b.id === blockId);
  const newBlock = newWorkout?.blocks.find(b => b.id === blockId);
  const exerciseName = (id: string) => exercises.find(ex => ex.id === id)?.name ?? id;
  const details = (block: { sets: Array<{ targetReps: number; targetKg: number | null }>; restSeconds: number }) =>
    `${block.sets.length} sets · ${block.sets.map(set => `${set.targetReps} reps${set.targetKg == null ? '' : ` at ${formatLoad(set.targetKg, unit)} ${unit}`}`).join(', ')} · ${block.restSeconds}s rest`;
  let title = 'Plan change'; let detail = '';
  if (type === 'update_prescription' && newBlock) {
    title = exerciseName(newBlock.exerciseId);
    detail = `Before: ${oldBlock ? details(oldBlock) : 'Unavailable'} · After: ${details(newBlock)}`;
  } else if (type === 'replace_exercise') {
    title = 'Exercise replacement'; detail = `${oldBlock ? exerciseName(oldBlock.exerciseId) : 'Exercise'} → ${exerciseName(String(operation.exerciseId))}`;
  } else if (type === 'add_exercise') {
    title = 'Exercise added'; detail = `${newWorkout?.name ?? 'Workout'}: ${newBlock ? exerciseName(newBlock.exerciseId) : 'Added exercise'}`;
  } else if (type === 'remove_exercise') {
    title = 'Exercise removed'; detail = `${oldWorkout?.name ?? 'Workout'}: ${oldBlock ? exerciseName(oldBlock.exerciseId) : 'Removed exercise'}`;
  } else if (type === 'reorder_exercises') {
    title = newWorkout?.name ?? 'Exercise order';
    detail = `Before: ${oldWorkout?.blocks.map(block => exerciseName(block.exerciseId)).join(' → ') ?? ''} · After: ${newWorkout?.blocks.map(block => exerciseName(block.exerciseId)).join(' → ') ?? ''}`;
  } else if (type === 'rename_workout') {
    title = 'Workout renamed'; detail = `${oldWorkout?.name ?? ''} → ${String(operation.name ?? '')}`;
  } else if (type === 'add_workout') {
    title = 'Workout added'; detail = (operation.workout as { name?: string } | undefined)?.name ?? 'New workout';
  } else if (type === 'remove_workout') {
    title = 'Workout removed'; detail = before?.workouts.find(w => w.id === workoutId)?.name ?? workoutId;
  } else if (type === 'reorder_workouts') {
    title = 'Workout order changed'; detail = `Before: ${before?.workouts.map(w => w.name).join(' → ') ?? ''} · After: ${after.workouts.map(w => w.name).join(' → ')}`;
  } else if (type === 'rename_plan') {
    title = 'Plan renamed'; detail = `${before?.name ?? ''} → ${String(operation.name ?? '')}`;
  } else if (type === 'update_plan_metadata') {
    title = 'Plan settings changed';
    detail = `${operation.description == null ? '' : `Description: ${before?.description ?? ''} → ${String(operation.description)}. `}${operation.schedule == null ? '' : `Schedule: ${before?.schedule ?? ''} → ${String(operation.schedule)}. `}${operation.cursor == null ? '' : `Rotation position: ${before?.cursor ?? 0} → ${String(operation.cursor)}. `}${operation.active == null ? '' : `Active: ${before?.active ? 'yes' : 'no'} → ${operation.active ? 'yes' : 'no'}`}`;
  }
  return <div className="proposal-change"><strong>{title}</strong><span>{detail}</span></div>;
}

export function Coach() {
  const { userId, session, offlineAccess } = useAuth();
  const { profile, plans, messages, proposals, sessions, exercises, trainingDataReady, run } = useApp();
  const [text, setText] = useState(''); const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<'checking' | 'sample' | 'chatgpt'>('checking');
  const [review, setReview] = useState<Proposal | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, sending]);
  useEffect(() => {
    let active = true;
    if (!userId || !session || offlineAccess || !navigator.onLine) { setMode('sample'); return; }
    setMode('checking');
    void backendChatGPTRequest<ChatGPTConnection>(userId, 'connection')
      .then(connection => { if (active) setMode(connection.connected && connection.planUsageGranted ? 'chatgpt' : 'sample'); })
      .catch(() => { if (active) setMode('sample'); });
    return () => { active = false; };
  }, [userId, session, offlineAccess]);
  useEffect(() => {
    if (!userId || !navigator.onLine) return;
    let current = true;
    const refreshStatuses = async () => {
      const pending = await db.proposals.filter(item => item.status === 'pending' && Boolean(item.serverProposalId)).toArray();
      for (const item of pending) {
        try {
          const status = await backendRequest<{ status: 'pending' | 'approved' | 'rejected' | 'expired' | 'invalidated' }>(userId, `coach/proposals/${item.serverProposalId}`);
          if (!current || status.status === 'pending') continue;
          await db.proposals.put({ ...item, status: status.status === 'approved' ? 'applied' : status.status });
          if (status.status === 'approved') window.dispatchEvent(new Event('fitcoach:sync-now'));
        } catch { /* The saved proposal remains visible while offline or temporarily unavailable. */ }
      }
    };
    const visible = () => { if (document.visibilityState === 'visible' && navigator.onLine) void refreshStatuses(); };
    void refreshStatuses();
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    return () => { current = false; window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); };
  }, [userId]);
  const send = async (value = text) => {
    const content = value.trim(); if (!content || sending || mode === 'checking') return;
    setSending(true); setText('');
    const user: Message = { id: uid(), role: 'user', text: content, createdAt: new Date().toISOString() };
    const saved = await run(async () => {
      const adapter = mode === 'chatgpt' && userId && navigator.onLine ? liveCoach(userId, trainingDataReady) : sampleCoach;
      const reply = await adapter.respond({ messages: [...messages, user], profile, plan: plans.find(p => p.active), recentWorkouts: sessions.filter(s => s.status === 'completed').slice(-5) });
      const assistant = assistantMessage(reply.text, adapter === sampleCoach ? 'sample' : 'chatgpt');
      const server = reply.serverProposal;
      const proposal: Proposal | null = server ? {
        id: uid(), messageId: assistant.id, plan: server.plan, status: 'pending',
        baseRevision: server.type === 'modify' ? Math.max(0, server.plan.revision - 1) : null,
        serverProposalId: server.id, type: server.type, targetPlanId: server.targetPlanId, beforePlan: server.beforePlan,
        sourceEtag: server.sourceEtag, operations: server.operations, assumptions: server.assumptions,
        summary: server.summary, expiresAt: server.expiresAt,
      } : reply.proposal ? { id: uid(), messageId: assistant.id, plan: reply.proposal, status: 'pending', baseRevision: reply.baseRevision ?? null } : null;
      await db.transaction('rw', [db.messages, db.proposals, db.outbox], async () => {
        await db.messages.bulkPut([user, assistant]);
        if (proposal) await db.proposals.add(proposal);
        await enqueueChange('messages', user.id, 'upsert', user); await enqueueChange('messages', assistant.id, 'upsert', assistant);
        if (proposal) await enqueueChange('proposals', proposal.id, 'upsert', proposal);
      });
    });
    if (!saved) setText(content);
    setSending(false);
  };
  return <div className="page coach-page"><div className="coach-top"><div><span className="eyebrow">A LITTLE DIRECTION</span><h1>Your corner.</h1></div><button className="icon-button" aria-label="New conversation" disabled={sending} onClick={() => {
    if (messages.length && window.confirm('Clear this conversation? Your plans and workouts stay saved.')) void run(async () => {
      await db.transaction('rw', [db.messages, db.proposals, db.outbox], async () => {
        await db.messages.clear(); await db.proposals.clear();
        for (const message of messages) await enqueueChange('messages', message.id, 'delete', null);
        for (const proposal of proposals) await enqueueChange('proposals', proposal.id, 'delete', null);
      });
    });
  }}><Plus size={21} /></button></div>
    <div className="demo-banner"><span className="pill accent"><Sparkles size={13} />{mode === 'chatgpt' ? 'ChatGPT Coach' : 'Sample Coach'}</span><p>{mode === 'chatgpt' ? `Using your connected ChatGPT plan. Replies are saved on this device. ${trainingDataReady ? 'Your synced training data is available to Coach.' : 'Your training data is still syncing; general questions are available.'}` : mode === 'checking' ? 'Checking your ChatGPT connection…' : 'Sample responses are available offline or without ChatGPT plan permission.'}</p></div>
    {messages.length === 0 && <div className="coach-welcome"><div className="orb"><Sparkles size={34} strokeWidth={1.5} /></div><h2>Training with<br />a little more intention.</h2><p>Build a routine. Understand the details.<br />Make the plan your own.</p><div className="conversation-starters">{(mode === 'chatgpt'
      ? [['How should I start training?', 'Get practical first steps'], ['Explain my plan', 'Understand your routine'], ['How should I recover?', 'Talk through rest and recovery']]
      : [['Build a sample plan', 'An editable starting point'], ['Explain my plan', 'Get to know your routine'], ['Change my rest periods', 'Preview a plan adjustment']]
    ).map(([title, description]) => <button key={title} onClick={() => send(title)}><div><strong>{title}</strong><small>{description}</small></div><ArrowRight size={18} /></button>)}</div></div>}
    <div className="messages">{messages.map(message => {
      const proposal = proposals.find(p => p.messageId === message.id);
      return <article className={`message ${message.role}`} key={message.id}>{message.role === 'assistant' && <span className="message-avatar"><Sparkles size={17} /></span>}<div className="message-content">{message.role === 'assistant' && <span className="eyebrow">COACH · {message.source === 'chatgpt' ? 'CHATGPT' : 'SAMPLE RESPONSE'}</span>}<p>{message.text}</p>
        {proposal && <div className="proposal-card"><span className="eyebrow">{proposal.serverProposalId ? (proposal.type === 'create' ? 'NEW PLAN PROPOSAL' : 'PLAN CHANGE PROPOSAL') : 'SAMPLE PLAN PROPOSAL'}</span><h3>{proposal.plan.name}</h3>{proposal.type === 'modify' && <p>Modifying: {proposal.beforePlan?.name ?? plans.find(p => p.id === proposal.targetPlanId)?.name ?? proposal.targetPlanId}</p>}{proposal.plan.description && <p>{proposal.plan.description}</p>}{proposal.summary && <p>{proposal.summary}</p>}{proposal.type === 'modify' && proposal.operations?.map((operation, i) => <ProposalOperation key={i} operation={operation} before={proposal.beforePlan ?? plans.find(p => p.id === proposal.targetPlanId)} after={proposal.plan} exercises={exercises} unit={profile.unit} />)}<div>{proposal.plan.workouts.map(w => <section key={w.id}><p><strong>{w.name}</strong><span>{w.blocks.length} exercises · {w.days.map(day => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', ')}</span></p><ul>{w.blocks.map(b => <li key={b.id}>{exercises.find(ex => ex.id === b.exerciseId)?.name ?? b.exerciseId}: {b.sets.map(s => `${s.targetReps} reps${s.targetKg == null ? '' : ` at ${formatLoad(s.targetKg, profile.unit)} ${profile.unit}`}`).join(', ')} · {b.restSeconds}s rest</li>)}</ul></section>)}</div>{proposal.assumptions?.length ? <div><strong>Assumptions</strong><ul>{proposal.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></div> : null}<small>{proposal.expiresAt ? `Expires ${new Date(proposal.expiresAt).toLocaleString()}. ` : ''}Review the stored exercise selections, sets, reps, and rest periods.</small>{proposal.status === 'pending' ? <div className="proposal-actions">{proposal.serverProposalId ? <><button className="button primary" disabled={!trainingDataReady || !navigator.onLine} onClick={() => void run(async () => {
          if (!session || !trainingDataReady || !navigator.onLine) throw new Error('Connect and finish syncing before approving a plan proposal.');
          const pending = await db.outbox.where('userId').equals(session.user.id).count();
          const conflicts = await db.sync.where('userId').equals(session.user.id).filter(item => item.kind === 'conflict').count();
          const root = proposal.targetPlanId ? await db.sync.get(syncRootId(session.user.id, 'plans', proposal.targetPlanId)) : undefined;
          if (pending || conflicts || (proposal.sourceEtag && root?.etag !== proposal.sourceEtag)) throw new Error('Sync all training changes and resolve conflicts before approving. If the plan changed, ask Coach for a fresh proposal.');
          let applied: { plan: import('../domain').Plan; etag: string; proposal: { status: string } };
          try {
            applied = await backendRequest(session.user.id, `coach/proposals/${proposal.serverProposalId}/approve`, { method: 'POST' });
          } catch (error) {
            const latest = await backendRequest<{ status: 'pending' | 'approved' | 'rejected' | 'expired' | 'invalidated' }>(session.user.id, `coach/proposals/${proposal.serverProposalId}`).catch(() => undefined);
            if (latest && latest.status !== 'pending') await db.proposals.put({ ...proposal, status: latest.status === 'approved' ? 'applied' : latest.status });
            throw error;
          }
          await cacheApprovedProposal(proposal, applied.plan, applied.etag);
          window.dispatchEvent(new Event('fitcoach:sync-now'));
        }, 'Proposal approved and synchronized')}><Check size={16} />Approve changes</button><button className="button" onClick={() => void run(async () => {
          if (!session) throw new Error('Sign in to reject this proposal.');
          await backendRequest(session.user.id, `coach/proposals/${proposal.serverProposalId}/reject`, { method: 'POST' });
          await putLocalChange('proposals', { ...proposal, status: 'rejected' as const }, db.proposals);
        })}>Reject changes</button></> : <><button className="button primary" onClick={() => setReview(proposal)}>Review & edit<ArrowRight size={16} /></button><button className="icon-button" aria-label="Reject proposal" onClick={() => run(() => putLocalChange('proposals', { ...proposal, status: 'rejected' as const }, db.proposals))}><X size={18} /></button></>}</div> : <span className="proposal-status">{proposal.status === 'applied' ? <><Check size={15} />Applied to your plan</> : 'Proposal dismissed or no longer valid'}</span>}</div>}
      </div></article>;
    })}{sending && <div className="message assistant"><span className="message-avatar"><Sparkles size={17} /></span><div className="typing" aria-label="Preparing Coach response"><i /><i /><i /></div></div>}<div ref={bottom} /></div>
    <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}><label className="sr-only" htmlFor="chat-input">Message Coach</label><textarea id="chat-input" value={text} maxLength={5000} onChange={e => setText(e.target.value)} placeholder="Let’s talk about your training…" rows={1} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><button aria-label="Send message" className="send-button" disabled={sending || mode === 'checking' || !text.trim()} type="submit"><Send size={18} /></button></form><p className="composer-caption"><MessageCircle size={12} />{mode === 'chatgpt' ? 'Using your ChatGPT plan' : 'Sample conversation'} · saved on this device</p>
    {review && <PlanEditor initial={review.plan} saveLabel="Apply reviewed plan" onClose={() => setReview(null)} onSave={async plan => {
      if (await run(() => applyProposal({ ...review, plan }), 'Reviewed plan applied')) setReview(null);
    }} />}
  </div>;
}

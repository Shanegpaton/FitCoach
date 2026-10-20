import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, MessageCircle, Plus, Send, Sparkles, X } from 'lucide-react';
import { db, applyProposal, enqueueChange, putLocalChange } from '../db';
import { assistantMessage, sampleCoach } from '../coach';
import { backendChatGPTRequest, liveCoach, type ChatGPTConnection } from '../chatgptVm';
import { useAuth } from '../auth';
import { uid, type Message, type Proposal } from '../domain';
import { useApp } from '../state';
import { PlanEditor } from './Plans';

export function Coach() {
  const { userId, session, offlineAccess } = useAuth();
  const { profile, plans, messages, proposals, sessions, trainingDataReady, run } = useApp();
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
  const send = async (value = text) => {
    const content = value.trim(); if (!content || sending || mode === 'checking') return;
    setSending(true); setText('');
    const user: Message = { id: uid(), role: 'user', text: content, createdAt: new Date().toISOString() };
    const saved = await run(async () => {
      const adapter = mode === 'chatgpt' && userId && navigator.onLine ? liveCoach(userId, trainingDataReady) : sampleCoach;
      const reply = await adapter.respond({ messages: [...messages, user], profile, plan: plans.find(p => p.active), recentWorkouts: sessions.filter(s => s.status === 'completed').slice(-5) });
      const assistant = assistantMessage(reply.text, adapter === sampleCoach ? 'sample' : 'chatgpt');
      const proposal: Proposal | null = reply.proposal ? { id: uid(), messageId: assistant.id, plan: reply.proposal, status: 'pending', baseRevision: reply.baseRevision ?? null } : null;
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
        {proposal && <div className="proposal-card"><span className="eyebrow">{proposal.baseRevision === null ? 'SAMPLE PLAN PROPOSAL' : 'PLAN CHANGE PROPOSAL'}</span><h3>{proposal.plan.name}</h3><div>{proposal.plan.workouts.map(w => <p key={w.id}><strong>{w.name}</strong><span>{w.blocks.length} exercises</span></p>)}</div><small>Starting weights and future progression are your choice.</small>{proposal.status === 'pending' ? <div className="proposal-actions"><button className="button primary" onClick={() => setReview(proposal)}>Review & edit<ArrowRight size={16} /></button><button className="icon-button" aria-label="Reject proposal" onClick={() => run(() => putLocalChange('proposals', { ...proposal, status: 'rejected' as const }, db.proposals))}><X size={18} /></button></div> : <span className="proposal-status">{proposal.status === 'applied' ? <><Check size={15} />Applied to your plan</> : 'Proposal dismissed'}</span>}</div>}
      </div></article>;
    })}{sending && <div className="message assistant"><span className="message-avatar"><Sparkles size={17} /></span><div className="typing" aria-label="Preparing Coach response"><i /><i /><i /></div></div>}<div ref={bottom} /></div>
    <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}><label className="sr-only" htmlFor="chat-input">Message Coach</label><textarea id="chat-input" value={text} maxLength={5000} onChange={e => setText(e.target.value)} placeholder="Let’s talk about your training…" rows={1} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><button aria-label="Send message" className="send-button" disabled={sending || mode === 'checking' || !text.trim()} type="submit"><Send size={18} /></button></form><p className="composer-caption"><MessageCircle size={12} />{mode === 'chatgpt' ? 'Using your ChatGPT plan' : 'Sample conversation'} · saved on this device</p>
    {review && <PlanEditor initial={review.plan} saveLabel="Apply reviewed plan" onClose={() => setReview(null)} onSave={async plan => {
      if (await run(() => applyProposal({ ...review, plan }), 'Reviewed plan applied')) setReview(null);
    }} />}
  </div>;
}

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, MessageCircle, Plus, Send, Sparkles, X } from 'lucide-react';
import { db, applyProposal } from '../db';
import { assistantMessage, sampleCoach } from '../coach';
import { uid, type Message, type Proposal } from '../domain';
import { useApp } from '../state';
import { PlanEditor } from './Plans';

export function Coach() {
  const { profile, plans, messages, proposals, sessions, run } = useApp();
  const [text, setText] = useState(''); const [sending, setSending] = useState(false);
  const [review, setReview] = useState<Proposal | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, sending]);
  const send = async (value = text) => {
    const content = value.trim(); if (!content || sending) return;
    setSending(true); setText('');
    const user: Message = { id: uid(), role: 'user', text: content, createdAt: new Date().toISOString() };
    const saved = await run(async () => {
      const reply = await sampleCoach.respond({ messages: [...messages, user], profile, plan: plans.find(p => p.active), recentWorkouts: sessions.filter(s => s.status === 'completed').slice(-5) });
      const assistant = assistantMessage(reply.text);
      await db.transaction('rw', [db.messages, db.proposals], async () => {
        await db.messages.bulkPut([user, assistant]);
        if (reply.proposal) await db.proposals.add({ id: uid(), messageId: assistant.id, plan: reply.proposal, status: 'pending', baseRevision: reply.baseRevision ?? null });
      });
    });
    if (!saved) setText(content);
    setSending(false);
  };
  return <div className="page coach-page"><div className="coach-top"><div><span className="eyebrow">A LITTLE DIRECTION</span><h1>Your corner.</h1></div><button className="icon-button" aria-label="New conversation" disabled={sending} onClick={() => {
    if (messages.length && window.confirm('Clear this sample conversation? Your plans and workouts stay saved.')) void run(() => db.transaction('rw', [db.messages, db.proposals], async () => { await db.messages.clear(); await db.proposals.clear(); }));
  }}><Plus size={21} /></button></div>
    <div className="demo-banner"><span className="pill accent"><Sparkles size={13} />Sample Coach</span><p>Explore the coaching experience. Responses are examples; a live AI connection comes later.</p></div>
    {messages.length === 0 && <div className="coach-welcome"><div className="orb"><Sparkles size={34} strokeWidth={1.5} /></div><h2>Training with<br />a little more intention.</h2><p>Build a routine. Understand the details.<br />Make the plan your own.</p><div className="conversation-starters">{[['Build a sample plan', 'An editable starting point'], ['Explain my plan', 'Get to know your routine'], ['Change my rest periods', 'Preview a plan adjustment']].map(([title, description]) => <button key={title} onClick={() => send(title)}><div><strong>{title}</strong><small>{description}</small></div><ArrowRight size={18} /></button>)}</div></div>}
    <div className="messages">{messages.map(message => {
      const proposal = proposals.find(p => p.messageId === message.id);
      return <article className={`message ${message.role}`} key={message.id}>{message.role === 'assistant' && <span className="message-avatar"><Sparkles size={17} /></span>}<div className="message-content">{message.role === 'assistant' && <span className="eyebrow">COACH · SAMPLE RESPONSE</span>}<p>{message.text}</p>
        {proposal && <div className="proposal-card"><span className="eyebrow">{proposal.baseRevision === null ? 'SAMPLE PLAN PROPOSAL' : 'PLAN CHANGE PROPOSAL'}</span><h3>{proposal.plan.name}</h3><div>{proposal.plan.workouts.map(w => <p key={w.id}><strong>{w.name}</strong><span>{w.blocks.length} exercises</span></p>)}</div><small>Starting weights and future progression are your choice.</small>{proposal.status === 'pending' ? <div className="proposal-actions"><button className="button primary" onClick={() => setReview(proposal)}>Review & edit<ArrowRight size={16} /></button><button className="icon-button" aria-label="Reject proposal" onClick={() => run(() => db.proposals.put({ ...proposal, status: 'rejected' }))}><X size={18} /></button></div> : <span className="proposal-status">{proposal.status === 'applied' ? <><Check size={15} />Applied to your plan</> : 'Proposal dismissed'}</span>}</div>}
      </div></article>;
    })}{sending && <div className="message assistant"><span className="message-avatar"><Sparkles size={17} /></span><div className="typing" aria-label="Preparing sample response"><i /><i /><i /></div></div>}<div ref={bottom} /></div>
    <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}><label className="sr-only" htmlFor="chat-input">Message Coach</label><textarea id="chat-input" value={text} maxLength={5000} onChange={e => setText(e.target.value)} placeholder="Let’s talk about your training…" rows={1} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><button aria-label="Send message" className="send-button" disabled={sending || !text.trim()} type="submit"><Send size={18} /></button></form><p className="composer-caption"><MessageCircle size={12} />Sample conversation · saved on this device</p>
    {review && <PlanEditor initial={review.plan} saveLabel="Apply reviewed plan" onClose={() => setReview(null)} onSave={async plan => {
      if (await run(() => applyProposal({ ...review, plan }), 'Reviewed plan applied')) setReview(null);
    }} />}
  </div>;
}

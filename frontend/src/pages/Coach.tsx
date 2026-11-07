import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { CoachContextStatus } from '../coachContext';
import Markdown from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';
import { ArrowRight, Check, MessageCircle, Plus, Send, Sparkles, X, Pencil, Trash2 } from 'lucide-react';
import { db, applyProposal, cacheApprovedProposal, enqueueChange, putLocalChange, syncRootId } from '../db';
import { assistantMessage, sampleCoach, isWorkoutProposal } from '../coach';
import { BackendError, backendChatGPTRequest, backendRequest, liveCoach, type ChatGPTConnection } from '../chatgptVm';
import { useAuth } from '../auth';
import { formatLoad, uid, type Exercise, type Message, type Plan, type Profile, type Proposal } from '../domain';
import { useApp } from '../state';
import { PlanEditor } from './Plans';
import { WorkoutProposal } from './WorkoutProposal';
import type { ServerProposal, ServerWorkoutProposal } from '../coach';

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

type WorkoutProposalMessage = ServerWorkoutProposal & { messageId: string };

interface CoachContextValue {
  workoutProposals: WorkoutProposalMessage[];
  setWorkoutProposals: React.Dispatch<React.SetStateAction<WorkoutProposalMessage[]>>;
  mode: 'checking' | 'sample' | 'chatgpt';
  messages: Message[];
  allProposals: Proposal[];
  conversations: Array<{ id: string; title: string; updatedAt: string }>;
  activeConversationId: string;
  text: string;
  setText: React.Dispatch<React.SetStateAction<string>>;
  sending: boolean;
  recovery: 'checking' | 'started' | 'failed' | 'unknown' | null;
  review: Proposal | null;
  setReview: React.Dispatch<React.SetStateAction<Proposal | null>>;
  initCoach: () => void;
  send: (value?: string) => Promise<void>;
  createConversation: () => Promise<void>;
  selectConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  setServerProposals: React.Dispatch<React.SetStateAction<Proposal[]>>;
}

const CoachContext = createContext<CoachContextValue | null>(null);

export function CoachProvider({ children }: { children: ReactNode }) {
  const { userId, session, offlineAccess } = useAuth();
  const { profile, plans, messages: sampleMessages, proposals, sessions, trainingDataReady, run } = useApp();

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState<'checking' | 'sample' | 'chatgpt'>(() => {
    if (!userId || !session || offlineAccess || !navigator.onLine) return 'sample';
    const cached = localStorage.getItem(`fitcoach:${userId}:coach-mode`);
    return (cached === 'chatgpt' || cached === 'sample') ? cached : 'checking';
  });
  const [review, setReview] = useState<Proposal | null>(null);
  const [conversations, setConversations] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);
  const [activeConversationId, setActiveConversationId] = useState('');
  const [serverMessages, setServerMessages] = useState<Message[]>([]);
  const [serverProposals, setServerProposals] = useState<Proposal[]>([]);
  const [workoutProposals, setWorkoutProposals] = useState<WorkoutProposalMessage[]>([]);
  const [recovery, setRecovery] = useState<'checking' | 'started' | 'failed' | 'unknown' | null>(null);
  const [recoveryVersion, setRecoveryVersion] = useState(0);

  const [visitedCoach, setVisitedCoach] = useState(false);
  const sendLock = useRef(false);
  const scope = useRef('');
  scope.current = `${userId}:${activeConversationId}`;
  const pendingTurn = useRef<{ conversationId: string; requestId: string; text: string } | null>(null);
  const lastUserId = useRef(userId);

  // Clear coach memory if authenticated user changes
  useEffect(() => {
    if (lastUserId.current !== userId) {
      lastUserId.current = userId;
      setMode((!userId || !session || offlineAccess || !navigator.onLine) ? 'sample' : 'checking');
      setConversations([]);
      setActiveConversationId('');
      setServerMessages([]);
      setServerProposals([]); setWorkoutProposals([]);
      setText('');
      setSending(false);
      setRecovery(null);
      setReview(null);
      setVisitedCoach(false);
    }
  }, [userId, session, offlineAccess]);

  const initCoach = useCallback(() => {
    setVisitedCoach(true);
  }, []);

  // Connection check when status changes or coach is opened
  useEffect(() => {
    let active = true;
    if (!userId || !session || offlineAccess || !navigator.onLine) {
      setMode('sample');
      return;
    }
    if (!visitedCoach) return;
    void backendChatGPTRequest<ChatGPTConnection>(userId, 'connection')
      .then(connection => {
        if (!active) return;
        const resolved = connection.connected && connection.planUsageGranted ? 'chatgpt' : 'sample';
        setMode(resolved);
        localStorage.setItem(`fitcoach:${userId}:coach-mode`, resolved);
      })
      .catch(() => {
        if (!active) return;
        setMode('sample');
        localStorage.setItem(`fitcoach:${userId}:coach-mode`, 'sample');
      });
    return () => { active = false; };
  }, [userId, session, offlineAccess, visitedCoach]);

  // Fetch conversations when in chatgpt mode
  useEffect(() => {
    if (mode !== 'chatgpt' || !userId || !visitedCoach) return;
    let current = true;
    void (async () => {
      let list = await backendRequest<{ items: Array<{ id: string; title: string; updatedAt: string }> }>(userId, 'coach/conversations');
      if (!list.items.length) {
        await backendRequest(userId, 'coach/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        list = await backendRequest(userId, 'coach/conversations');
      }
      if (!current) return;
      setConversations(list.items);
      const savedId = localStorage.getItem(`fitcoach:${userId}:coach-active-conversation`);
      setActiveConversationId(prev => prev || (list.items.find(item => item.id === savedId)?.id ?? list.items[0]?.id ?? ''));
    })().catch(error => { if (current) void run(async () => { throw error; }); });
    return () => { current = false; };
  }, [mode, userId, visitedCoach]);

  // Messages and turn recovery for active conversation
  useEffect(() => {
    if (mode !== 'chatgpt' || !userId || !activeConversationId) {
      setRecovery(null);
      return;
    }
    let current = true;
    localStorage.setItem(`fitcoach:${userId}:coach-active-conversation`, activeConversationId);
    const pendingKey = `fitcoach:${userId}:coach-pending-turn:${activeConversationId}`;
    const pendingText = localStorage.getItem(pendingKey);
    setRecovery(pendingText ? 'checking' : null);
    if (pendingText) {
      try {
        const restored = (JSON.parse(pendingText) as { text: string }).text;
        setText(draft => draft || restored);
      } catch {
        setRecovery('unknown');
      }
    }
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || sendLock.current || !navigator.onLine) return;
      refreshing = true;
      try {
        const pending = localStorage.getItem(pendingKey);
        if (pending) {
          try {
            const turn = JSON.parse(pending) as { requestId: string; text: string };
            const status = await backendRequest<{ status: string }>(userId, `coach/conversations/${activeConversationId}/turns/${turn.requestId}`);
            if (!current) return;
            if (status.status === 'completed') {
              if (localStorage.getItem(pendingKey) === pending) {
                localStorage.removeItem(pendingKey);
                setText(draft => draft === turn.text ? '' : draft);
                setRecovery(null);
              }
            } else setRecovery(status.status === 'started' ? 'started' : 'failed');
          } catch (error) {
            if (current) setRecovery(error instanceof BackendError && error.status === 404 ? 'failed' : 'unknown');
          }
        } else if (current) setRecovery(null);

        const conversation = await backendRequest<{
          messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: string; metadata?: { artifacts?: Array<{ id: string; type: string }> } }>
        }>(userId, `coach/conversations/${activeConversationId}?limit=100`);

        if (!current || sendLock.current) return;
        setServerMessages(conversation.messages.map(message => ({
          id: message.id, role: message.role, text: message.text,
          createdAt: message.createdAt, source: message.role === 'assistant' ? 'chatgpt' : undefined,
        })));

        const refs = conversation.messages.flatMap(message => (message.metadata?.artifacts ?? []).map(artifact => ({ messageId: message.id, artifact })));
        const results = await Promise.allSettled(refs.filter(ref => ['training_plan_proposal', 'workout_edit_proposal'].includes(ref.artifact.type)).map(async (ref): Promise<Proposal | WorkoutProposalMessage> => {
          const item = await backendRequest<ServerProposal>(userId, `coach/proposals/${ref.artifact.id}`);
          if (isWorkoutProposal(item)) return { ...item, messageId: ref.messageId };
          return {
            id: item.id, messageId: ref.messageId, plan: item.plan, status: item.status === 'approved' ? 'applied' as const : item.status,
            baseRevision: null, serverProposalId: item.id, type: item.type, targetPlanId: item.targetPlanId,
            beforePlan: item.beforePlan, sourceEtag: item.sourceEtag, operations: item.operations,
            assumptions: item.assumptions, summary: item.summary, expiresAt: item.expiresAt,
          } satisfies Proposal;
        }));
        if (current) {
          const loaded = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
          setServerProposals(loaded.filter((item): item is Proposal => !('session' in item)));
          setWorkoutProposals(loaded.filter((item): item is WorkoutProposalMessage => 'session' in item));
        }
      } catch (error) {
        if (current) void run(async () => { throw error; });
      } finally {
        refreshing = false;
      }
    };

    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    const timer = window.setInterval(() => { if (localStorage.getItem(pendingKey)) visible(); }, 5000);
    window.addEventListener('online', visible);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      current = false;
      clearInterval(timer);
      window.removeEventListener('online', visible);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [mode, userId, activeConversationId, recoveryVersion]);

  // Refresh proposal statuses periodically
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
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => { current = false; window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); };
  }, [userId]);

  const activeMessages = mode === 'chatgpt' ? serverMessages : sampleMessages;
  const allProposals = [...proposals, ...serverProposals];

  const send = async (value = text) => {
    const content = value.trim();
    if (!content || sendLock.current || mode === 'checking' || (recovery && recovery !== 'failed')) return;
    const turnConversationId = activeConversationId;
    const turnMessages = activeMessages;
    const turnScope = scope.current;
    const turnDatabase = db;
    let needsRecovery = false;
    sendLock.current = true;
    setSending(true);
    setText('');
    try {
      const user: Message = { id: uid(), role: 'user', text: content, createdAt: new Date().toISOString() };
      const saved = await run(async () => {
        const isLive = mode === 'chatgpt' && userId && navigator.onLine;
        const adapter = isLive ? liveCoach(userId!, trainingDataReady) : sampleCoach;
        const pendingKey = userId && turnConversationId ? `fitcoach:${userId}:coach-pending-turn:${turnConversationId}` : '';
        if (isLive) {
          const stored = pendingKey ? localStorage.getItem(pendingKey) : null;
          const parsed = stored ? JSON.parse(stored) as { conversationId: string; requestId: string; text: string } : null;
          pendingTurn.current = parsed?.conversationId === turnConversationId && parsed.text === content ? parsed
            : { conversationId: turnConversationId, requestId: uid(), text: content };
          localStorage.setItem(pendingKey, JSON.stringify(pendingTurn.current));
        }
        const reply = await adapter.respond({
          messages: [...turnMessages, user],
          profile,
          plan: plans.find(p => p.active),
          recentWorkouts: sessions.filter(s => s.status === 'completed').slice(-5),
          conversationId: isLive ? turnConversationId : undefined,
          requestId: isLive ? pendingTurn.current?.requestId : undefined,
        });
        const assistant = { ...assistantMessage(reply.text, isLive ? 'chatgpt' : 'sample'), id: reply.persistedMessageId ?? uid() };
        const persistedUser = reply.persistedUserMessageId ? { ...user, id: reply.persistedUserMessageId } : user;

        if (isLive) {
          if (reply.replayed && userId) {
            const conversation = await backendRequest<{ messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: string }> }>(userId, `coach/conversations/${turnConversationId}?limit=100`);
            if (scope.current === turnScope) {
              setServerMessages(conversation.messages.map(message => ({
                id: message.id, role: message.role, text: message.text,
                createdAt: message.createdAt, source: message.role === 'assistant' ? 'chatgpt' : undefined,
              })));
            }
          } else if (scope.current === turnScope) {
            setServerMessages(existing => [...existing, persistedUser, assistant]);
          }
          if (pendingKey && localStorage.getItem(pendingKey) === JSON.stringify(pendingTurn.current)) localStorage.removeItem(pendingKey);
          pendingTurn.current = null;
        }

        const server = reply.serverProposal && !isWorkoutProposal(reply.serverProposal) ? reply.serverProposal : null;
        const proposal: Proposal | null = server ? {
          id: uid(), messageId: assistant.id, plan: server.plan, status: 'pending',
          baseRevision: server.type === 'modify' ? Math.max(0, server.plan.revision - 1) : null,
          serverProposalId: server.id, type: server.type, targetPlanId: server.targetPlanId, beforePlan: server.beforePlan,
          sourceEtag: server.sourceEtag, operations: server.operations, assumptions: server.assumptions,
          summary: server.summary, expiresAt: server.expiresAt,
        } : reply.proposal ? { id: uid(), messageId: assistant.id, plan: reply.proposal, status: 'pending', baseRevision: reply.baseRevision ?? null } : null;

        if (isLive) {
          if (reply.serverProposal && isWorkoutProposal(reply.serverProposal) && scope.current === turnScope) {
            const workout = reply.serverProposal;
            setWorkoutProposals(existing => [...existing.filter(item => item.id !== workout.id), { ...workout, messageId: assistant.id }]);
          }
          if (proposal && scope.current === turnScope) {
            await turnDatabase.proposals.put(proposal);
            if (scope.current === turnScope) setServerProposals(existing => [...existing.filter(p => p.id !== proposal.id), proposal]);
          }
          if (scope.current === turnScope) {
            setConversations(existing => existing.map(item => item.id === turnConversationId ? {
              ...item,
              title: item.title === 'New conversation' ? content.slice(0, 160) : item.title,
              updatedAt: new Date().toISOString(),
            } : item));
          }
        } else {
          await turnDatabase.transaction('rw', [turnDatabase.messages, turnDatabase.proposals, turnDatabase.outbox], async () => {
            await turnDatabase.messages.bulkPut([user, assistant]);
            if (proposal) await turnDatabase.proposals.add(proposal);
            await enqueueChange('messages', user.id, 'upsert', user, turnDatabase);
            await enqueueChange('messages', assistant.id, 'upsert', assistant, turnDatabase);
            if (proposal) await enqueueChange('proposals', proposal.id, 'upsert', proposal, turnDatabase);
          });
        }
      });
      if (!saved) {
        needsRecovery = mode === 'chatgpt';
        if (scope.current === turnScope) setText(draft => draft || content);
      } else if (scope.current === turnScope) {
        setRecovery(null);
      }
    } finally {
      sendLock.current = false;
      setSending(false);
      if (needsRecovery || scope.current !== turnScope) setRecoveryVersion(version => version + 1);
    }
  };

  const createConversation = async () => {
    if (!userId) throw new Error('Sign in online to create a Coach conversation.');
    await run(async () => {
      const created = await backendRequest<{ id: string; title: string; updatedAt: string }>(userId, 'coach/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setConversations(existing => [created, ...existing]);
      setActiveConversationId(created.id);
      setServerMessages([]);
      setServerProposals([]); setWorkoutProposals([]);
    });
  };

  const selectConversation = (id: string) => {
    setActiveConversationId(id);
  };

  const renameConversation = async (id: string, title: string) => {
    if (!userId) return;
    await run(async () => {
      const updated = await backendRequest<{ id: string; title: string; updatedAt: string }>(userId, `coach/conversations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
      setConversations(items => items.map(item => item.id === updated.id ? updated : item));
    });
  };

  const deleteConversation = async (id: string) => {
    if (!userId) return;
    await run(async () => {
      await backendRequest(userId, `coach/conversations/${id}`, { method: 'DELETE' });
      const remaining = conversations.filter(item => item.id !== id);
      setConversations(remaining);
      if (activeConversationId === id) {
        if (remaining.length) {
          setActiveConversationId(remaining[0].id);
        } else {
          const created = await backendRequest<{ id: string; title: string; updatedAt: string }>(userId, 'coach/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          setConversations([created]);
          setActiveConversationId(created.id);
        }
        setServerMessages([]);
        setServerProposals([]); setWorkoutProposals([]);
      }
    });
  };

  return (
    <CoachContext.Provider
      value={{
        mode,
        workoutProposals,
        setWorkoutProposals,
        messages: activeMessages,
        allProposals,
        conversations,
        activeConversationId,
        text,
        setText,
        sending,
        recovery,
        review,
        setReview,
        initCoach,
        send,
        createConversation,
        selectConversation,
        renameConversation,
        deleteConversation,
        setServerProposals,
      }}
    >
      {children}
    </CoachContext.Provider>
  );
}

export function useCoach() {
  const context = useContext(CoachContext);
  if (!context) throw new Error('useCoach must be used within a CoachProvider');
  return context;
}

export function Coach() {
  const { userId, session } = useAuth();
  const { profile, plans, exercises, trainingDataReady, run } = useApp();
  const {
    mode,
    messages,
    allProposals,
    workoutProposals,
    setWorkoutProposals,
    conversations,
    activeConversationId,
    text,
    setText,
    sending,
    recovery,
    review,
    setReview,
    initCoach,
    send,
    createConversation,
    selectConversation,
    renameConversation,
    deleteConversation,
    setServerProposals,
  } = useCoach();

  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initCoach();
  }, [initCoach]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'end' });
  }, [messages.length, sending]);

  return (
    <div className="page coach-page">
      <div className="coach-top">
        <div>
          <h1>Coach</h1>
        </div>
        {mode === 'sample' ? <Link to="/settings#coach-connection" className="button secondary">Connect ChatGPT</Link> : <button
          className="button secondary"
          aria-label="New conversation"
          title={mode !== 'chatgpt' ? 'Connect ChatGPT in Settings to create conversations' : 'Start a new conversation'}
          disabled={sending || mode !== 'chatgpt' || !userId || !navigator.onLine}
          onClick={() => void createConversation()}
        >
          <Plus size={18} />New chat
        </button>}
      </div>

      {mode === 'chatgpt' && conversations.length > 0 && (
        <nav className="coach-conversations" aria-label="Coach conversations">
          {conversations.map(conversation => (
            <div className={`coach-conversation ${conversation.id === activeConversationId ? 'active' : ''}`} key={conversation.id}>
              <button
                className="coach-conversation-select"
                aria-current={conversation.id === activeConversationId ? 'page' : undefined}
                onClick={() => selectConversation(conversation.id)}
              >
                <span>{conversation.title}</span>
                <small>{new Date(conversation.updatedAt).toLocaleDateString()}</small>
              </button>
              <button
                className="icon-button"
                aria-label={`Rename ${conversation.title}`}
                onClick={() => {
                  const title = window.prompt('Conversation name', conversation.title)?.trim();
                  if (title && userId) void renameConversation(conversation.id, title);
                }}
              >
                <Pencil size={15} />
              </button>
              <button
                className="icon-button"
                aria-label={`Delete ${conversation.title}`}
                onClick={() => {
                  if (!window.confirm(`Delete “${conversation.title}” and its conversation history?`)) return;
                  if (userId) void deleteConversation(conversation.id);
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </nav>
      )}

      <div className="demo-banner">
        <span className="pill accent"><Sparkles size={13} />{mode === 'chatgpt' ? 'ChatGPT Coach' : 'Sample Coach'}</span>
        <p>
          {mode === 'chatgpt'
            ? `Using your connected ChatGPT plan. Conversations are saved to your account. ${trainingDataReady ? 'Your synced training data is available to Coach.' : 'Your training data is still syncing; general questions are available.'}`
            : mode === 'checking'
              ? 'Checking your ChatGPT connection…'
              : 'Sample responses are available offline or without ChatGPT plan permission.'}
        </p>
      </div>
    {mode === 'chatgpt' && <CoachContextStatus key={`${userId}:${activeConversationId}`} conversationId={activeConversationId} sending={sending} />}

      {messages.length === 0 && (
        <div className="coach-welcome">
          <h2>What would help today?</h2>
          <div className="conversation-starters">
            {(mode === 'chatgpt'
              ? [['How should I start training?', 'Get practical first steps'], ['Explain my plan', 'Understand your routine'], ['How should I recover?', 'Talk through rest and recovery']]
              : [['Build a sample plan', 'An editable starting point'], ['Explain my plan', 'Get to know your routine'], ['Change my rest periods', 'Preview a plan adjustment']]
            ).map(([title, description]) => (
              <button key={title} onClick={() => void send(title)}>
                <div><strong>{title}</strong><small>{description}</small></div>
                <ArrowRight size={18} />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="messages">
        {messages.map(message => {
          const proposal = allProposals.find(p => p.messageId === message.id);
          const workoutProposal = workoutProposals.find(p => p.messageId === message.id);
          return (
            <article className={`message ${message.role}`} key={message.id}>
              {message.role === 'assistant' && <span className="message-avatar"><Sparkles size={17} /></span>}
              <div className="message-content">
                {message.role === 'assistant' && (
                  <span className="eyebrow">Coach · {message.source === 'chatgpt' ? 'ChatGPT' : 'Sample response'}</span>
                )}
                <div className="message-markdown">
                  <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
                </div>
                {workoutProposal && userId && <WorkoutProposal key={`${userId}:${activeConversationId}:${workoutProposal.id}`} proposal={workoutProposal} userId={userId} ready={trainingDataReady} unit={profile.unit} run={run} onStatus={status => setWorkoutProposals(items => items.map(item => item.id === workoutProposal.id ? { ...item, status } : item))} />}
                {proposal && (
                  <div className="proposal-card">
                    <span className="eyebrow">
                      {proposal.serverProposalId ? (proposal.type === 'create' ? 'NEW PLAN PROPOSAL' : 'PLAN CHANGE PROPOSAL') : 'SAMPLE PLAN PROPOSAL'}
                    </span>
                    <h3>{proposal.plan.name}</h3>
                    {proposal.type === 'modify' && (
                      <p>Modifying: {proposal.beforePlan?.name ?? plans.find(p => p.id === proposal.targetPlanId)?.name ?? proposal.targetPlanId}</p>
                    )}
                    {proposal.plan.description && <p>{proposal.plan.description}</p>}
                    {proposal.summary && <p>{proposal.summary}</p>}
                    {proposal.type === 'modify' && proposal.operations?.map((operation, i) => (
                      <ProposalOperation key={i} operation={operation} before={proposal.beforePlan ?? plans.find(p => p.id === proposal.targetPlanId)} after={proposal.plan} exercises={exercises} unit={profile.unit} />
                    ))}
                    <div>
                      {proposal.plan.workouts.map(w => (
                        <section key={w.id}>
                          <p><strong>{w.name}</strong><span>{w.blocks.length} exercises · {w.days.map(day => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', ')}</span></p>
                          <ul>
                            {w.blocks.map(b => (
                              <li key={b.id}>
                                {exercises.find(ex => ex.id === b.exerciseId)?.name ?? b.exerciseId}: {b.sets.map(s => `${s.targetReps} reps${s.targetKg == null ? '' : ` at ${formatLoad(s.targetKg, profile.unit)} ${profile.unit}`}`).join(', ')} · {b.restSeconds}s rest
                              </li>
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                    {proposal.assumptions?.length ? (
                      <div><strong>Assumptions</strong><ul>{proposal.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>
                    ) : null}
                    <small>
                      {proposal.expiresAt ? `Expires ${new Date(proposal.expiresAt).toLocaleString()}. ` : ''}
                      Review the stored exercise selections, sets, reps, and rest periods.
                    </small>
                    {proposal.status === 'pending' ? (
                      <div className="proposal-actions">
                        {proposal.serverProposalId ? (
                          <>
                            <button
                              className="button primary"
                              disabled={!trainingDataReady || !navigator.onLine}
                              onClick={() => void run(async () => {
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
                                setServerProposals(items => items.map(item => item.id === proposal.id ? { ...item, status: 'applied' } : item));
                                window.dispatchEvent(new Event('fitcoach:sync-now'));
                              }, 'Proposal approved and synchronized')}
                            >
                              <Check size={16} />Approve changes
                            </button>
                            <button
                              className="button"
                              onClick={() => void run(async () => {
                                if (!session) throw new Error('Sign in to reject this proposal.');
                                await backendRequest(session.user.id, `coach/proposals/${proposal.serverProposalId}/reject`, { method: 'POST' });
                                await putLocalChange('proposals', { ...proposal, status: 'rejected' as const }, db.proposals);
                                setServerProposals(items => items.map(item => item.id === proposal.id ? { ...item, status: 'rejected' } : item));
                              })}
                            >
                              Reject changes
                            </button>
                          </>
                        ) : (
                          <>
                            <button className="button primary" onClick={() => setReview(proposal)}>
                              Review & edit<ArrowRight size={16} />
                            </button>
                            <button
                              className="icon-button"
                              aria-label="Reject proposal"
                              onClick={() => run(() => putLocalChange('proposals', { ...proposal, status: 'rejected' as const }, db.proposals))}
                            >
                              <X size={18} />
                            </button>
                          </>
                        )}
                      </div>
                    ) : (
                      <span className="proposal-status">
                        {proposal.status === 'applied' ? <><Check size={15} />Applied to your plan</> : 'Proposal dismissed or no longer valid'}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </article>
          );
        })}
        {sending && (
          <div className="message assistant">
            <span className="message-avatar"><Sparkles size={17} /></span>
            <div className="typing" aria-label="Preparing Coach response"><i /><i /><i /></div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      {recovery && (
        <p role="status">
          {recovery === 'started' ? 'Coach is still processing your saved message. Checking for a reply…'
            : recovery === 'failed' ? 'Your message is saved. Retry it with Send, or edit it to send a new message.'
            : recovery === 'checking' ? 'Checking your saved message…'
            : 'Your message is kept. Waiting to check its status before sending again.'}
        </p>
      )}

      <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor="chat-input">Message Coach</label>
        <textarea
          id="chat-input"
          value={text}
          maxLength={5000}
          onChange={e => setText(e.target.value)}
          placeholder="Ask about your training"
          rows={1}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          aria-label="Send message"
          className="send-button"
          disabled={sending || (recovery !== null && recovery !== 'failed') || mode === 'checking' || (mode === 'chatgpt' && !activeConversationId) || !text.trim()}
          type="submit"
        >
          <Send size={18} />
        </button>
      </form>

      <p className="composer-caption">
        <MessageCircle size={12} />
        {mode === 'chatgpt' ? 'Using your ChatGPT plan · saved to your account' : 'Sample conversation · saved on this device'}
      </p>

      {review && (
        <PlanEditor
          initial={review.plan}
          saveLabel="Apply reviewed plan"
          onClose={() => setReview(null)}
          onSave={async plan => {
            if (await run(() => applyProposal({ ...review, plan }), 'Reviewed plan applied')) setReview(null);
          }}
        />
      )}
    </div>
  );
}

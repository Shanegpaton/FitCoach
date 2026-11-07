import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from './auth';
import { backendRequest } from './chatgptVm';
import { useApp } from './state';
import { Modal, SectionTitle } from './ui';

const updatedEvent = 'fitcoach:coach-context-updated';
const maintenanceEvent = 'fitcoach:coach-maintenance';

/** Remains mounted across routes. Server leases also coordinate other devices. */
export function CoachMaintenance() {
  const { userId, session, offlineAccess } = useAuth();
  const [changedFor, setChangedFor] = useState('');
  useEffect(() => {
    if (!userId || !session || offlineAccess) return;
    let stopped = false; let busy = false; let wantedConversation = '';
    const controller = new AbortController();
    const tick = async (event?: Event) => {
      if (event instanceof CustomEvent) wantedConversation = (event.detail as { conversationId?: string } | undefined)?.conversationId ?? wantedConversation;
      if (stopped || busy || !navigator.onLine || document.visibilityState !== 'visible') return;
      busy = true; let ran = false;
      const conversationId = wantedConversation || undefined;
      const work = async () => {
        if (stopped) return;
        ran = true;
        if (wantedConversation === conversationId) wantedConversation = '';
        try {
          const result = await backendRequest<{ processed: boolean; memoryChanged?: boolean }>(userId, 'coach/maintenance', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId }), signal: controller.signal,
          });
          if (!stopped) {
            window.dispatchEvent(new CustomEvent(updatedEvent, { detail: { userId } }));
            if (result.memoryChanged) setChangedFor(userId);
          }
        } catch { /* Durable jobs and leases recover on the next foreground visit. */ }
      };
      try {
        if (navigator.locks) await navigator.locks.request(`fitcoach:${userId}:coach-maintenance`, { ifAvailable: true }, lock => lock ? work() : undefined);
        else await work();
      } finally {
        busy = false;
        if (ran && wantedConversation && !stopped) setTimeout(() => void tick(), 0);
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), 30_000);
    window.addEventListener(maintenanceEvent, tick); window.addEventListener('online', tick); window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      stopped = true; controller.abort(); clearInterval(interval);
      window.removeEventListener(maintenanceEvent, tick); window.removeEventListener('online', tick); window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [userId, session?.access_token, offlineAccess]);
  return changedFor === userId ? <div className="connection-banner" role="status"><Link to="/settings">Coach memory updated · Review in Settings</Link><button onClick={() => setChangedFor('')}>Dismiss</button></div> : null;
}

interface ContextStatus { enabled?: boolean; summary: string; summaryAvailable: boolean; maintenancePending: boolean; compactionWaiting: boolean }
export function CoachContextStatus({ conversationId, sending }: { conversationId: string; sending: boolean }) {
  const { userId } = useAuth();
  const [value, setValue] = useState<ContextStatus | null>(null);
  useEffect(() => {
    if (!userId || !conversationId) return;
    let active = true; let busy = false;
    setValue(null);
    const controller = new AbortController();
    const refresh = async () => {
      if (busy || !navigator.onLine) return;
      busy = true;
      try {
        const result = await backendRequest<ContextStatus>(userId, `coach/conversations/${conversationId}/context`, { signal: controller.signal });
        if (active) setValue(result);
      } catch { /* Context status must not interrupt composing or workout entry. */ }
      finally { busy = false; }
    };
    void refresh();
    // Opening an older conversation also schedules model-specific threshold checks.
    window.dispatchEvent(new CustomEvent(maintenanceEvent, { detail: { conversationId } }));
    const interval = setInterval(() => void refresh(), sending ? 1500 : 15_000);
    window.addEventListener(updatedEvent, refresh);
    return () => { active = false; controller.abort(); clearInterval(interval); window.removeEventListener(updatedEvent, refresh); };
  }, [userId, conversationId, sending]);
  if (!value?.enabled) return null;
  return <aside className="coach-context-status">
    <p className="field-hint" role="status">{value.compactionWaiting ? 'Updating conversation context before replying…' : value.summaryAvailable ? 'Using earlier-chat summary.' : value.maintenancePending ? 'Updating Coach context in the background…' : ''}</p>
    {value.summary && <details><summary>View earlier-chat summary</summary><p className="context-summary">{value.summary}</p></details>}
  </aside>;
}

interface MemoryItem { id: string; content: string; category: string; edited: boolean; updatedAt: string; etag: string; sources: Array<{ conversationId: string; messageId: string }> }
interface Memories { enabled: boolean; automatic: boolean; etag: string; capacityReached: boolean; items: MemoryItem[] }

export function CoachMemorySettings() {
  const { userId, offlineAccess } = useAuth();
  const { run } = useApp();
  const [data, setData] = useState<Memories | null>(null);
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [clear, setClear] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!userId || offlineAccess) return;
    let active = true;
    const load = async () => {
      try {
        const result = await backendRequest<Memories>(userId, 'coach/memories');
        if (active) { setData(result); setError(''); }
      } catch { if (active) setError('Connect online to load Coach memory.'); }
    };
    void load(); window.addEventListener(updatedEvent, load); window.addEventListener('online', load);
    return () => { active = false; window.removeEventListener(updatedEvent, load); window.removeEventListener('online', load); };
  }, [userId, offlineAccess]);
  const change = async (path: string, method: string, etag: string, body?: unknown) => {
    if (!userId || busy) return;
    setBusy(true);
    await run(async () => {
      try {
        await backendRequest(userId, path, { method, headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: body ? JSON.stringify(body) : undefined });
        setEditing(''); setClear(false);
      } finally {
        try { setData(await backendRequest<Memories>(userId, 'coach/memories')); }
        catch { setError('Connect online to reload Coach memory.'); }
      }
    });
    setBusy(false);
  };
  return <section id="coach-memory" className="settings-card"><SectionTitle title="Coach memory" />
    <p className="field-hint">Coach remembers preferences and self-reported training limitations across conversations, including injury details. These facts are saved to your account, separately from workout backups. Review and correct them here.</p>
    {error && <p role="status">{error}</p>}
    {offlineAccess ? <p>Connect online to manage Coach memory.</p> : data && <>
      {!data.enabled && <p role="status">Automatic memory is temporarily unavailable.</p>}
      <label className="memory-toggle"><input type="checkbox" checked={data.automatic} disabled={busy || !data.enabled} onChange={e => { const automatic = e.target.checked; setData({ ...data, automatic }); void change('coach/memory-settings', 'PATCH', data.etag, { automatic }); }} />Automatically save useful training facts</label>
      <p className="field-hint">Turning this off stops new memories. Existing memories remain available until deleted.</p>
      {data.capacityReached && <p role="status">Memory is full. Delete a fact to make room for new ones.</p>}
      {!data.items.length && <p>No saved memories yet.</p>}
      <div className="memory-list">{data.items.map(item => <article className="memory-item" key={item.id}>
        {editing === item.id ? <form onSubmit={e => { e.preventDefault(); void change(`coach/memories/${item.id}`, 'PATCH', item.etag, { content: draft }); }}>
          <label>Edit remembered fact<textarea value={draft} onChange={e => setDraft(e.target.value)} maxLength={1000} required /></label>
          <div className="action-row"><button className="button secondary" disabled={busy || !draft.trim()}>Save memory</button><button type="button" className="text-button" onClick={() => setEditing('')}>Cancel</button></div>
        </form> : <><p>{item.content}</p><small>{item.category} · {item.edited ? 'Edited by you' : 'From your messages'} · {new Date(item.updatedAt).toLocaleDateString()}</small>
          <div className="action-row"><button className="text-button" disabled={busy} onClick={() => { setEditing(item.id); setDraft(item.content); }}>Edit memory</button><button className="text-button" disabled={busy} onClick={() => void change(`coach/memories/${item.id}`, 'DELETE', item.etag)}>Forget memory</button></div>
          {item.sources.length > 0 && <details><summary>Memory sources</summary><p className="field-hint">Supported by {item.sources.length} conversation{item.sources.length === 1 ? '' : 's'}.</p></details>}
        </>}
      </article>)}</div>
      {data.items.length > 0 && <button className="button secondary" disabled={busy} onClick={() => setClear(true)}>Forget all memories</button>}
      {clear && <Modal title="Forget all Coach memories?" onClose={() => setClear(false)}><p>This removes saved facts from future chats. Your conversations and workout records stay saved.</p><div className="action-row"><button className="button secondary" onClick={() => setClear(false)}>Cancel</button><button className="button primary" disabled={busy} onClick={() => void change('coach/memories', 'DELETE', data.etag)}>Forget all</button></div></Modal>}
    </>}
  </section>;
}

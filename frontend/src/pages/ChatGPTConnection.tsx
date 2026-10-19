import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link2, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { useAuth } from '../auth';
import { chatgptVmUrl, vmRequest, type ChatGPTAttempt, type ChatGPTConnection as Connection } from '../chatgptVm';
import { SectionTitle } from '../ui';
import { ChatGPTViewer } from './ChatGPTViewer';

export function ChatGPTConnection() {
  const { userId, session, offlineAccess } = useAuth();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [attempt, setAttempt] = useState<ChatGPTAttempt | null>(null);
  const [pairCode, setPairCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [viewerOpen, setViewerOpen] = useState(false);
  const available = Boolean(chatgptVmUrl && userId && session && !offlineAccess);

  const reload = useCallback(async () => {
    if (userId) setConnection(await vmRequest<Connection>(userId, '/v1/connection'));
  }, [userId]);

  useEffect(() => {
    setConnection(null); setAttempt(null); setError(''); setViewerOpen(false);
    if (available) void reload().catch(e => setError(e instanceof Error ? e.message : 'VM unavailable.'));
  }, [available, reload, userId]);

  useEffect(() => {
    if (!available || !userId || attempt?.state !== 'pending') return;
    let active = true;
    const poll = async () => {
      try {
        const next = await vmRequest<ChatGPTAttempt>(userId, `/v1/attempts/${attempt.id}`);
        if (!active) return;
        setAttempt(current => ({ ...next, viewerToken: current?.viewerToken }));
        if (next.state !== 'pending') setViewerOpen(false);
        if (next.state !== 'pending') setConnection(next.connection ?? null);
      } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Could not check sign-in.'); }
    };
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [available, attempt?.id, attempt?.state, userId]);

  const pair = async (e: FormEvent) => {
    e.preventDefault(); if (!userId || busy) return;
    setBusy(true); setError('');
    try {
      setConnection(await vmRequest<Connection>(userId, '/v1/pair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pairCode.trim() }),
      }));
      setPairCode('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not pair VM.'); }
    finally { setBusy(false); }
  };

  const connect = async () => {
    if (!userId || busy) return;
    setBusy(true); setError('');
    try {
      const next = await vmRequest<ChatGPTAttempt>(userId, '/v1/attempts', { method: 'POST' });
      setAttempt(next);
      if (next.viewerToken) setViewerOpen(true);
      else setError('The VM did not provide a browser session. Try again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start ChatGPT sign-in.');
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    if (!userId || busy || !window.confirm('Disconnect this ChatGPT account from FitCoachGPT?')) return;
    setBusy(true); setError('');
    try {
      await vmRequest<void>(userId, '/v1/connection', { method: 'DELETE' });
      setAttempt(null); setViewerOpen(false); await reload();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not disconnect.'); }
    finally { setBusy(false); }
  };

  return <section className="settings-card"><SectionTitle title="ChatGPT connection"><Link2 size={20} /></SectionTitle>
    <p>Sign in on OpenAI’s page in the browser view below. The browser and ChatGPT credentials stay on the VM. Coach still uses sample responses.</p>
    {!chatgptVmUrl ? <p className="field-hint">The VM connection is not configured for this app deployment yet.</p>
      : !available ? <p className="field-hint">Sign in to FitCoachGPT while online to connect ChatGPT.</p>
        : connection === null ? <p aria-live="polite">Checking VM connection…</p>
          : !connection.paired ? <form onSubmit={e => void pair(e)}><label>VM pairing code<input autoComplete="off" value={pairCode} onChange={e => setPairCode(e.target.value)} required minLength={20} /></label><p className="field-hint">Enter the one-time pairing code from the VM operator. This binds this VM to your FitCoach account.</p><button className="button secondary" disabled={busy} type="submit">Pair VM</button></form>
            : <><div className="privacy-note"><ShieldCheck size={20} /><p>{connection.connected ? `Connected to ${connection.name || connection.email || 'your verified ChatGPT account'}.` : 'No ChatGPT account connected yet.'}</p></div>
              {connection.connected && <p aria-live="polite">ChatGPT plan usage: {connection.planUsageGranted ? 'Granted at sign-in' : 'Not granted'}</p>}
              {attempt?.state === 'pending' && <p aria-live="polite">Complete sign-in and permission review on OpenAI’s page. This page will update when it finishes.</p>}
              {attempt?.state === 'pending' && attempt.viewerToken && !viewerOpen && <button className="button secondary" onClick={() => setViewerOpen(true)}>Resume sign-in</button>}
              {attempt && attempt.state !== 'pending' && attempt.state !== 'connected' && <p aria-live="polite">Sign-in {attempt.state}. You can try again.</p>}
              <div className="action-row"><button className="button secondary" disabled={busy || attempt?.state === 'pending'} onClick={() => void connect()}><RefreshCw size={16} />{connection.connected ? 'Reconnect' : 'Connect ChatGPT'}</button>
                {connection.connected && <button className="button secondary" disabled={busy} onClick={() => void disconnect()}><Unplug size={16} />Disconnect</button>}
              </div></>}
    {error && <p className="field-hint" aria-live="polite">{error}</p>}
    {viewerOpen && attempt?.state === 'pending' && attempt.viewerToken && <ChatGPTViewer token={attempt.viewerToken} onClose={() => setViewerOpen(false)} />}
  </section>;
}

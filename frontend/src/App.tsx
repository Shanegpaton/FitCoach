import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router';
import { Activity, ArrowUpRight, Check, Dumbbell, History as HistoryIcon, LayoutGrid, LogOut, Settings as SettingsIcon, Sparkles, WifiOff, X } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { ZodError } from 'zod';
import { activateUserDatabase, db, hasLegacyData, importLegacyData, initialize } from './db';
import { AppContext, type AppData } from './state';
import { getSyncAccessToken, useAuth } from './auth';
import { startSyncCoordinator, type SyncStatus } from './sync';
import { Modal } from './ui';
import { Today } from './pages/Today';
import { Plans } from './pages/Plans';
import { WorkoutPage } from './pages/Workout';
import { Coach } from './pages/Coach';
import { Settings, Onboarding } from './pages/Settings';

const History = lazy(() => import('./pages/History').then(module => ({ default: module.History })));

export function App() {
  const auth = useAuth();
  const [readyForUser, setReadyForUser] = useState('');
  const [fatal, setFatal] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [legacyAvailable, setLegacyAvailable] = useState(false);
  const [migrationSeen, setMigrationSeen] = useState(false);
  const [importingLegacy, setImportingLegacy] = useState(false);
  const [legacyImportError, setLegacyImportError] = useState('');
  const legacyImportRunning = useRef(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const location = useLocation();
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  useEffect(() => {
    if (!auth.userId) { setReadyForUser(''); return; }
    let alive = true;
    setReadyForUser(''); setFatal('');
    activateUserDatabase(auth.userId);
    const migrated = localStorage.getItem(`fitcoach:${auth.userId}:legacy-reviewed`) === 'yes';
    setMigrationSeen(migrated);
    void initialize(db).then(async () => {
      const legacy = await hasLegacyData();
      if (alive) { setLegacyAvailable(legacy && !migrated); setReadyForUser(auth.userId!); }
    }).catch(error => { if (alive) setFatal(String(error)); });
    return () => { alive = false; };
  }, [auth.userId]);
  useEffect(() => {
    if (!auth.userId || readyForUser !== auth.userId || !auth.session) {
      setSyncStatus(auth.userId ? { state: 'offline', pending: 0, conflicts: 0, failed: 0,
        lastSuccessAt: null, message: 'Sign in online to synchronize. Local changes are safe.' } : null);
      return;
    }
    return startSyncCoordinator(auth.userId, getSyncAccessToken, setSyncStatus, db);
  }, [auth.userId, auth.session?.access_token, readyForUser]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);
  useEffect(() => {
    if (!toast || toast.error) return;
    const timeout = setTimeout(() => setToast(null), 4000); return () => clearTimeout(timeout);
  }, [toast]);
  const data = useLiveQuery(async () => {
    if (!auth.userId || readyForUser !== auth.userId) return undefined;
    const [profile, exercises, plans, sessions, overrides, messages, proposals] = await Promise.all([
      db.profile.get('profile'), db.exercises.toArray(), db.plans.toArray(), db.sessions.toArray(),
      db.overrides.toArray(), db.messages.orderBy('createdAt').toArray(), db.proposals.toArray(),
    ]);
    return { profile: profile!, exercises, plans, sessions, overrides, messages, proposals } satisfies AppData;
  }, [auth.userId, readyForUser]);
  const localPending = useLiveQuery(async () => {
    if (!auth.userId || readyForUser !== auth.userId) return 0;
    return db.outbox.where('userId').equals(auth.userId).count();
  }, [auth.userId, readyForUser]) ?? 0;
  const notify = (message: string, error = false) => setToast({ message, error });
  const run = async (action: () => Promise<unknown>, success?: string) => {
    try { await action(); if (success) notify(success); return true; }
    catch (error) { notify(error instanceof ZodError ? error.issues[0]?.message ?? 'Check the entered values.' : error instanceof Error ? error.message : 'Could not save. Your changes have not been saved.', true); return false; }
  };
  const finishLegacyReview = () => {
    if (legacyImportRunning.current || !auth.userId) return;
    localStorage.setItem(`fitcoach:${auth.userId}:legacy-reviewed`, 'yes');
    setLegacyAvailable(false);
    setMigrationSeen(true);
    setLegacyImportError('');
  };
  const importLegacy = async () => {
    if (legacyImportRunning.current || !auth.userId) return;
    legacyImportRunning.current = true;
    setImportingLegacy(true);
    setLegacyImportError('');
    const userId = auth.userId;
    try {
      await importLegacyData();
      localStorage.setItem(`fitcoach:${userId}:legacy-reviewed`, 'yes');
      setLegacyAvailable(false);
      setMigrationSeen(true);
      notify('Training data imported on this device. Account sync will continue in the background.');
    } catch (error) {
      setLegacyImportError(error instanceof ZodError ? error.issues[0]?.message ?? 'Check the saved data.'
        : error instanceof Error ? error.message : 'Could not import data. Your existing data is safe.');
    } finally {
      legacyImportRunning.current = false;
      setImportingLegacy(false);
    }
  };
  if (auth.loading) return <div className="startup"><span className="brand-mark">f.</span><p>Checking your training space…</p></div>;
  if (!auth.userId) return <div className="auth-screen"><span className="brand-mark large">f.</span><span className="eyebrow">FITCOACH</span><h1>Your training,<br /><span className="text-accent">on your terms.</span></h1><p>Sign in with Google to open your private training space. Once signed in on this device, your workouts stay available offline.</p>{!auth.configured && <div className="auth-config" role="status"><strong>Supabase setup needed</strong><span>Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in frontend/.env.local, then configure Google OAuth in Supabase.</span></div>}<button className="button primary google-signin" disabled={!auth.configured || !online} onClick={() => void auth.signIn()}><GoogleMark />Continue with Google</button>{!online && <p className="field-hint">Connect to the internet to sign in for the first time.</p>}{auth.error && <p className="auth-error" role="alert">{auth.error}</p>}</div>;
  if (fatal) return <div className="startup"><h1>Storage is unavailable</h1><p>FitCoach needs browser storage to save workouts. Check storage permissions and available space, then retry.</p><details><summary>Details</summary>{fatal}</details><button className="button primary" onClick={() => window.location.reload()}>Retry</button></div>;
  if (!data) return <div className="startup"><span className="brand-mark">f.</span><p>Getting your training space ready…</p></div>;
  const active = data.sessions.filter(s => s.status === 'active').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const syncLabel = !syncStatus ? 'Private training space' : syncStatus.state === 'offline'
    ? 'Offline · saved here' : syncStatus.conflicts ? `${syncStatus.conflicts} conflict${syncStatus.conflicts === 1 ? '' : 's'}`
      : syncStatus.failed ? `${syncStatus.failed} failed`
      : syncStatus.state === 'syncing' ? 'Syncing…' : syncStatus.state === 'error'
        ? 'Sync needs attention' : Math.max(syncStatus.pending, localPending) ? `${Math.max(syncStatus.pending, localPending)} pending` : 'Synced';
  const trainingDataReady = Boolean(syncStatus?.state === 'idle' && syncStatus.lastSuccessAt
    && !syncStatus.pending && !syncStatus.failed && !syncStatus.conflicts && !localPending);
  return <AppContext.Provider value={{ ...data, trainingDataReady, notify, run }}>
    <div className="app-shell">
      <header className="app-header"><Link to="/" className="brand" aria-label="FitCoach home"><span className="brand-mark">f.</span><span>fitcoach<span className="brand-dot">.</span></span></Link>
        <div className="header-right"><Link className="local-badge" to="/settings" aria-label={`Synchronization: ${syncStatus?.message ?? syncLabel}`}><span />{auth.offlineAccess ? 'Offline · saved here' : syncLabel}</Link><Link className="icon-button" to="/settings" aria-label="Settings"><SettingsIcon size={20} /></Link><button className="icon-button" aria-label="Sign out" title={auth.email ? `Sign out ${auth.email}` : 'Sign out'} onClick={() => void auth.signOut()}><LogOut size={18} /></button></div></header>
      {!online && <div className="connection-banner"><WifiOff size={15} /> Offline. Your training stays with you.</div>}
      {syncStatus && (syncStatus.state === 'syncing' || syncStatus.state === 'error' || syncStatus.conflicts > 0 || syncStatus.pending > 0 || localPending > 0) && <Link to="/settings" className={`connection-banner sync-banner ${syncStatus.state === 'error' || syncStatus.conflicts ? 'sync-alert' : ''}`} role="status">{syncStatus.state === 'syncing' ? syncStatus.message : syncStatus.conflicts ? `${syncStatus.conflicts} sync conflict${syncStatus.conflicts === 1 ? '' : 's'} need your choice.` : syncStatus.failed ? `${syncStatus.failed} change${syncStatus.failed === 1 ? '' : 's'} failed to upload.` : syncStatus.state === 'error' ? syncStatus.message : `${Math.max(syncStatus.pending, localPending)} change${Math.max(syncStatus.pending, localPending) === 1 ? '' : 's'} waiting to sync.`} <span>View</span></Link>}
      {auth.error && <div className="connection-banner" role="status">{auth.error}{online && <button onClick={() => void auth.signIn()}>Sign in again</button>}</div>}
      {auth.offlineAccess && <div className="connection-banner">Offline access for this account. Workout logging stays local until you’re online and signed in.</div>}
      {needRefresh && <div className="connection-banner">A new version is ready. {active ? 'Finish your workout to update.' : <button onClick={() => run(() => updateServiceWorker(true))}>Update app</button>}</div>}
      <main id="main-content"><Routes>
        <Route path="/auth/callback" element={<Navigate to="/" replace />} />
        <Route path="/" element={<Today />} /><Route path="/plan" element={<Plans />} />
        <Route path="/coach" element={<Coach />} /><Route path="/history" element={<Suspense fallback={<div className="page"><p className="field-hint">Opening your journal…</p></div>}><History /></Suspense>} />
        <Route path="/workout/:id" element={<WorkoutPage />} /><Route path="/settings" element={<Settings />} />
        <Route path="*" element={<div className="empty"><h1>Page not found</h1><Link to="/" className="button primary">Back to Today</Link></div>} />
      </Routes></main>
      {active && !location.pathname.startsWith('/workout/') && <Link className="resume-bar" to={`/workout/${active.id}`}><span className="pulse" /><div><strong>Workout in progress</strong><small>{active.name}</small></div><span>Resume<ArrowUpRight size={18} /></span></Link>}
      <nav className="bottom-nav" aria-label="Main navigation">
        {[['/', 'Today', Activity], ['/plan', 'Plan', LayoutGrid], ['/coach', 'Coach', Sparkles], ['/history', 'History', HistoryIcon]].map(([to, label, Icon]) => {
          const Component = Icon as typeof Dumbbell;
          return <NavLink key={String(to)} to={String(to)} end={to === '/'} className={({ isActive }) => isActive ? 'active' : ''}><Component size={21} /><span>{String(label)}</span></NavLink>;
        })}
      </nav>
      {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <X size={18} /> : <Check size={18} />}<span>{toast.message}</span><button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={16} /></button></div>}
      {!data.profile.onboardingDone && <Onboarding />}
      {legacyAvailable && !migrationSeen && <Modal title="Import this device’s training data?" onClose={finishLegacyReview}><p>FitCoach found data from before sign-in was added. Import it into this Google account to keep using your existing plans, profile, and workout history.</p><p className="field-hint">The original local data is kept. Importing replaces data in this account if it already has any.</p>{legacyImportError && <p className="auth-error" role="alert">Import failed: {legacyImportError}</p>}<div className="action-row"><button className="button secondary" disabled={importingLegacy} onClick={finishLegacyReview}>Keep accounts separate</button><button className="button primary" disabled={importingLegacy} onClick={() => void importLegacy()}>{importingLegacy ? 'Importing…' : 'Import data'}</button></div></Modal>}
    </div>
  </AppContext.Provider>;
}

function GoogleMark() { return <svg aria-hidden="true" viewBox="0 0 48 48" width="19" height="19"><path fill="#4285F4" d="M43.6 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11a9.4 9.4 0 0 1-4.1 6.2v5.5h6.7c3.9-3.6 6-8.9 6-15.7Z"/><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.7-5.5c-1.8 1.2-4 2-6.8 2-5.2 0-9.6-3.5-11.2-8.2H5.9v5.7A20 20 0 0 0 24 44Z"/><path fill="#FBBC05" d="M12.8 27.5a12 12 0 0 1 0-7V14.8H5.9a20 20 0 0 0 0 18.4l6.9-5.7Z"/><path fill="#EA4335" d="M24 12c3 0 5.7 1 7.8 3.1l5.9-5.9C34.1 5.9 29.5 4 24 4A20 20 0 0 0 5.9 14.8l6.9 5.7C14.4 15.5 18.8 12 24 12Z"/></svg>; }

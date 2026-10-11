import { lazy, Suspense, useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router';
import { Activity, ArrowUpRight, Check, Dumbbell, History as HistoryIcon, LayoutGrid, Settings as SettingsIcon, Sparkles, WifiOff, X } from 'lucide-react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { ZodError } from 'zod';
import { db, initialize } from './db';
import { AppContext, type AppData } from './state';
import { Today } from './pages/Today';
import { Plans } from './pages/Plans';
import { WorkoutPage } from './pages/Workout';
import { Coach } from './pages/Coach';
import { Settings, Onboarding } from './pages/Settings';

const History = lazy(() => import('./pages/History').then(module => ({ default: module.History })));

export function App() {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const location = useLocation();
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  useEffect(() => { initialize().then(() => setReady(true)).catch(error => setFatal(String(error))); }, []);
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
    if (!ready) return undefined;
    const [profile, exercises, plans, sessions, overrides, messages, proposals] = await Promise.all([
      db.profile.get('profile'), db.exercises.toArray(), db.plans.toArray(), db.sessions.toArray(),
      db.overrides.toArray(), db.messages.orderBy('createdAt').toArray(), db.proposals.toArray(),
    ]);
    return { profile: profile!, exercises, plans, sessions, overrides, messages, proposals } satisfies AppData;
  }, [ready]);
  const notify = (message: string, error = false) => setToast({ message, error });
  const run = async (action: () => Promise<unknown>, success?: string) => {
    try { await action(); if (success) notify(success); return true; }
    catch (error) { notify(error instanceof ZodError ? error.issues[0]?.message ?? 'Check the entered values.' : error instanceof Error ? error.message : 'Could not save. Your changes have not been saved.', true); return false; }
  };
  if (fatal) return <div className="startup"><h1>Storage is unavailable</h1><p>FitCoach needs browser storage to save workouts. Check storage permissions and available space, then retry.</p><details><summary>Details</summary>{fatal}</details><button className="button primary" onClick={() => window.location.reload()}>Retry</button></div>;
  if (!data) return <div className="startup"><span className="brand-mark">f.</span><p>Getting your training space ready…</p></div>;
  const active = data.sessions.find(s => s.status === 'active');
  return <AppContext.Provider value={{ ...data, notify, run }}>
    <div className="app-shell">
      <header className="app-header"><Link to="/" className="brand" aria-label="FitCoach home"><span className="brand-mark">f.</span><span>fitcoach<span className="brand-dot">.</span></span></Link>
        <div className="header-right"><span className="local-badge"><span />On your device</span><Link className="icon-button" to="/settings" aria-label="Settings"><SettingsIcon size={20} /></Link></div></header>
      {!online && <div className="connection-banner"><WifiOff size={15} /> Offline. Your training stays with you.</div>}
      {needRefresh && <div className="connection-banner">A new version is ready. {active ? 'Finish your workout to update.' : <button onClick={() => run(() => updateServiceWorker(true))}>Update app</button>}</div>}
      <main id="main-content"><Routes>
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
    </div>
  </AppContext.Provider>;
}

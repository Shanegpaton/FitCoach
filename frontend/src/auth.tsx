import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const cachedUserKey = `fitcoach:${url ?? 'unconfigured'}:last-user`;

export const supabase: SupabaseClient | null = url && anonKey
  ? createClient(url, anonKey, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

interface AuthState {
  configured: boolean;
  loading: boolean;
  userId: string | null;
  email: string | null;
  session: Session | null;
  offlineAccess: boolean;
  error: string;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [offlineAccess, setOfflineAccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    if (!supabase) { setLoading(false); return; }
    const cachedUser = localStorage.getItem(cachedUserKey);
    const setAuthenticated = (next: Session, offline = false) => {
      if (!alive) return;
      localStorage.setItem(cachedUserKey, next.user.id);
      setUserId(next.user.id); setEmail(next.user.email ?? null); setSession(next);
      setOfflineAccess(offline); setError('');
    };
    const { data: listener } = supabase.auth.onAuthStateChange((event, next) => {
      if (next) setAuthenticated(next, !navigator.onLine);
      else if (event === 'SIGNED_OUT') { setSession(null); setEmail(null); }
    });
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!alive) return;
      if (data.session) setAuthenticated(data.session, !navigator.onLine);
      else if (!navigator.onLine && cachedUser) {
        setUserId(cachedUser); setOfflineAccess(true);
      } else if ((sessionError || cachedUser) && cachedUser) {
        // A network/refresh failure must not block local workouts for the last account.
        setUserId(cachedUser); setOfflineAccess(true); setError(sessionError ? 'Could not refresh your sign-in. Local workouts remain available.' : 'Sign in again to use online features. Local workouts remain available.');
      } else if (sessionError) setError(sessionError.message);
      setLoading(false);
    }).catch(() => {
      if (alive) {
        if (cachedUser) { setUserId(cachedUser); setOfflineAccess(true); setError('Could not refresh your sign-in. Local workouts remain available.'); }
        setLoading(false);
      }
    });
    return () => { alive = false; listener.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!supabase) return;
    const onOnline = () => {
      void supabase.auth.refreshSession().then(({ data, error: refreshError }) => {
        if (data.session) {
          localStorage.setItem(cachedUserKey, data.session.user.id);
          setUserId(data.session.user.id); setEmail(data.session.user.email ?? null);
          setSession(data.session); setOfflineAccess(false); setError('');
        } else if (refreshError) {
          setError('Your sign-in could not be refreshed. Sign in again to synchronize; local workouts remain available.');
          setOfflineAccess(Boolean(userId));
        }
      }).catch(() => setError('Could not refresh your sign-in. Local workouts remain available.'));
    };
    const onOffline = () => { if (userId) setOfflineAccess(true); };
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, [userId]);

  const value = useMemo<AuthState>(() => ({
    configured: Boolean(supabase), loading, userId, email, session, offlineAccess, error,
    signIn: async () => {
      if (!supabase) return;
      setError('');
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: 'google', options: { redirectTo: `${window.location.origin}/auth/callback`, queryParams: { access_type: 'offline', prompt: 'select_account' } },
      });
      if (signInError) setError(signInError.message);
    },
    signOut: async () => {
      if (!supabase) return;
      // Local scope works offline. The account's IndexedDB remains stored but is gated by auth.
      const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
      if (signOutError) setError(signOutError.message);
      else { localStorage.removeItem(cachedUserKey); setUserId(null); setEmail(null); setSession(null); setOfflineAccess(false); }
    },
    refresh: async () => {
      if (!supabase) return;
      const { data, error: refreshError } = await supabase.auth.refreshSession();
      if (data.session) {
        localStorage.setItem(cachedUserKey, data.session.user.id); setUserId(data.session.user.id);
        setEmail(data.session.user.email ?? null); setSession(data.session); setOfflineAccess(false); setError('');
      } else if (refreshError) setError(refreshError.message);
    },
  }), [loading, userId, email, session, offlineAccess, error]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('Authentication state unavailable');
  return auth;
}

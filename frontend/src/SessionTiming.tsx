import { useEffect, useState } from 'react';
import type { Session } from './domain';
import { sessionDuration } from './training';

export function SessionTiming({ session }: { session: Session }) {
  const [now, setNow] = useState(Date.now);
  const active = session.status === 'active';
  useEffect(() => {
    if (!active) return;
    const refresh = () => setNow(Date.now());
    refresh();
    const interval = window.setInterval(refresh, 1000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, session.id]);
  const time = (value: string) => <time dateTime={value}>{new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>;
  return <dl className="session-timing" aria-label="Workout timing">
    <div><dt>Started</dt><dd>{time(session.startedAt)}</dd></div>
    <div><dt>Finished</dt><dd>{!active && session.completedAt ? time(session.completedAt) : 'In progress'}</dd></div>
    <div><dt>{active ? 'Elapsed' : 'Duration'}</dt><dd>{sessionDuration(session, now)}</dd></div>
  </dl>;
}

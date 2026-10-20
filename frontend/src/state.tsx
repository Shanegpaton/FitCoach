import { createContext, useContext } from 'react';
import type { Exercise, Message, Plan, Profile, Proposal, ScheduleOverride, Session } from './domain';
import { db, enqueueChange } from './db';

export interface AppData {
  profile: Profile; exercises: Exercise[]; plans: Plan[]; sessions: Session[];
  overrides: ScheduleOverride[]; messages: Message[]; proposals: Proposal[];
}
export interface AppState extends AppData {
  trainingDataReady: boolean;
  notify: (message: string, error?: boolean) => void;
  run: (action: () => Promise<unknown>, success?: string) => Promise<boolean>;
}
export const AppContext = createContext<AppState | null>(null);
export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('App state unavailable');
  return value;
}
export async function updateSession(id: string, update: (session: Session) => void) {
  await db.transaction('rw', [db.sessions, db.outbox, db.sync], async () => {
    const session = await db.sessions.get(id);
    if (!session) throw new Error('Workout not found');
    update(session);
    await db.sessions.put(session);
    await enqueueChange('sessions', id, 'upsert', session);
  });
}

import { createContext, useContext } from 'react';
import type { Exercise, Plan, Profile, ScheduleOverride, Session } from './domain';
import { db, enqueueChange, type TrainingDB } from './db';

export interface AppData {
  database: TrainingDB; profile: Profile; exercises: Exercise[]; plans: Plan[];
  overrides: ScheduleOverride[];
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

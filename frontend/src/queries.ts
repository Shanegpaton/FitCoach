import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { TrainingDB } from './db';

/** Dexie's hook retains the previous result on dependency changes. Tag results
 * so an old account, route ID, search, or date range can never appear as current. */
export function useDatabaseQuery<T>(database: TrainingDB, read: (database: TrainingDB) => Promise<T>, deps: readonly unknown[] = []) {
  const scope = useMemo(() => ({}), [database, ...deps]);
  const result = useLiveQuery(async () => ({ scope, value: await read(database) }), [scope]);
  return result?.scope === scope ? result.value : undefined;
}

export function useActiveSessions(database: TrainingDB) {
  return useDatabaseQuery(database, async database => {
    const sessions = await database.sessions.where('status').equals('active').toArray();
    return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  });
}

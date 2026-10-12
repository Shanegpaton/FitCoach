import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { TrainingDB, createSession, initialize, syncRootId } from './db';
import { catalog, starterPlan } from './catalog';
import { defaultProfile, uid } from './domain';
import { startSession } from './training';
import { resolveConflict } from './sync';

let database: TrainingDB;
afterEach(async () => { if (database) await database.delete(); });

describe('synchronization recovery', () => {
  it('keeps both divergent active-session snapshots and every recorded set', async () => {
    database = new TrainingDB(`sync-${uid()}`, 'sync-user');
    await initialize(database);
    const plan = starterPlan(defaultProfile);
    const local = startSession(plan, plan.workouts[0], catalog);
    local.blocks[0].sets.push({ ...structuredClone(local.blocks[0].sets[0]), id: 'local-offline-set', kg: 40, reps: 8, done: true });
    await createSession(local, database);

    const cloud = structuredClone(local);
    cloud.blocks[0].sets = cloud.blocks[0].sets.filter(set => set.id !== 'local-offline-set');
    cloud.blocks[0].sets.push({ ...structuredClone(cloud.blocks[0].sets[0]), id: 'cloud-offline-set', kg: 45, reps: 7, done: true });
    cloud.notes = 'Changed on the other device';
    const conflictId = `conflict:sync-user:sessions:${local.id}`;
    await database.sync.put({ id: conflictId, userId: 'sync-user', kind: 'conflict', entity: 'sessions',
      entityId: local.id, payload: local, remotePayload: cloud, remoteDeleted: false,
      remoteEtag: '"3"', reason: 'Changed on another device.' });
    const queued = await database.outbox.where('entityId').equals(local.id).first();
    await database.outbox.update(queued!.id, { status: 'conflict' });

    await resolveConflict(database, conflictId, 'keep-both');
    const sessions = await database.sessions.toArray();
    expect(sessions).toHaveLength(2);
    expect(sessions.find(item => item.id === local.id)?.blocks[0].sets.some(set => set.id === 'cloud-offline-set')).toBe(true);
    const localCopy = sessions.find(item => item.id !== local.id)!;
    expect(localCopy.blocks[0].sets.some(set => set.id === 'local-offline-set')).toBe(true);
    expect(await database.outbox.where('entity').equals('sessions').count()).toBe(1);
    expect(await database.sync.get(syncRootId('sync-user', 'sessions', local.id))).toMatchObject({ etag: '"3"' });
  });

  it('keeps local and cloud records unchanged when a recovery choice is not yet made', async () => {
    database = new TrainingDB(`sync-${uid()}`, 'sync-user');
    await initialize(database);
    const plan = starterPlan(defaultProfile);
    const local = startSession(plan, plan.workouts[0], catalog);
    local.blocks[0].sets[0].kg = 25;
    await database.sessions.put(local);
    const cloud = structuredClone(local); cloud.blocks[0].sets[0].kg = 30;
    const id = `conflict:sync-user:sessions:${local.id}`;
    await database.sync.put({ id, userId: 'sync-user', kind: 'conflict', entity: 'sessions',
      entityId: local.id, payload: local, remotePayload: cloud, remoteDeleted: false,
      remoteEtag: '"4"', reason: 'Changed on another device.' });
    expect((await database.sessions.get(local.id))?.blocks[0].sets[0].kg).toBe(25);
    expect((await database.sync.get(id))?.remotePayload).toEqual(cloud);
  });
});

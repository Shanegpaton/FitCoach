import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrainingDB, createSession, initialize } from './db';
import { catalog, starterPlan } from './catalog';
import { defaultProfile, uid } from './domain';
import { startSession } from './training';
import { applyChanges, conflictSnapshot, resolveConflict, upload } from './sync';

let database: TrainingDB;
afterEach(async () => { vi.unstubAllGlobals(); if (database) await database.delete(); });

async function setup(deleted = false) {
  database = new TrainingDB(`sync-${uid()}`, 'sync-user');
  await initialize(database);
  const plan = starterPlan(defaultProfile);
  const local = startSession(plan, plan.workouts[0], catalog);
  local.blocks[0].sets.push({ ...structuredClone(local.blocks[0].sets[0]), id: 'local-set', kg: 40, reps: 8, done: true });
  await createSession(local, database);
  const cloud = structuredClone(local);
  cloud.blocks[0].sets = cloud.blocks[0].sets.filter(set => set.id !== 'local-set');
  cloud.blocks[0].sets.push({ ...structuredClone(cloud.blocks[0].sets[0]), id: 'cloud-set', kg: 45, reps: 7, done: true });
  cloud.notes = 'Cloud notes';
  const id = `conflict:sync-user:sessions:${local.id}`;
  await database.sync.put({ id, userId: 'sync-user', kind: 'conflict', entity: 'sessions', entityId: local.id,
    payload: local, remotePayload: deleted ? null : cloud, remoteDeleted: deleted, remoteEtag: '"3"' });
  const old = (await database.outbox.where('entityId').equals(local.id).first())!;
  await database.outbox.update(old.id, { status: 'conflict' });
  return { local, cloud, id, old };
}

const recoveries = async () => database.sync.where('kind').equals('recovery').toArray();
const change = (id: string, document: unknown, version = 4) => ({ resource: 'sessions' as const, id,
  sequence: version + 1, version, etag: `"${version}"`, deleted: false, document });

describe('explicit conflict resolution', () => {
  it('uses cloud under the original ID and preserves the local sets', async () => {
    const { local, cloud, id } = await setup();
    await resolveConflict(database, id, 'use-cloud', await conflictSnapshot(database, id));
    expect(await database.sessions.toArray()).toEqual([cloud]);
    expect(await database.outbox.count()).toBe(0);
    expect((await recoveries()).some(item => JSON.stringify(item.payload).includes('local-set'))).toBe(true);
    expect(await database.sync.get(id)).toBeUndefined();
    expect((await database.sessions.get(local.id))?.notes).toBe('Cloud notes');
  });

  it('uses this device with the latest ETag and detects another server edit', async () => {
    const { local, cloud, id } = await setup();
    await resolveConflict(database, id, 'use-device', await conflictSnapshot(database, id));
    expect(await database.sessions.toArray()).toEqual([local]);
    const queued = (await database.outbox.where('entityId').equals(local.id).first())!;
    expect(queued).toMatchObject({ expectedEtag: '"3"', operation: 'upsert', status: 'pending' });
    expect((await recoveries()).some(item => JSON.stringify(item.payload).includes('cloud-set'))).toBe(true);
    await applyChanges(database, 'sync-user', [change(local.id, { ...cloud, notes: 'Changed again' })], 5);
    expect(await database.sync.get(id)).toMatchObject({ remoteEtag: '"4"' });
    expect(await database.sessions.get(local.id)).toEqual(local);
    expect((await database.outbox.get(queued.id))?.status).toBe('conflict');
  });

  it('saves a manually edited final record under the original ID and recovers both versions', async () => {
    const { local, cloud, id } = await setup();
    const final = structuredClone(local);
    final.notes = cloud.notes;
    final.blocks[0].sets.push(cloud.blocks[0].sets.find(set => set.id === 'cloud-set')!);
    await resolveConflict(database, id, 'edit-merge', await conflictSnapshot(database, id), final);
    expect(await database.sessions.toArray()).toEqual([final]);
    expect((await database.outbox.where('entityId').equals(local.id).first())?.expectedEtag).toBe('"3"');
    expect((await recoveries()).some(item => JSON.stringify(item.payload).includes('local-set'))).toBe(true);
    expect((await recoveries()).some(item => JSON.stringify(item.payload).includes('cloud-set'))).toBe(true);
  });

  it('rejects invalid manual edits without clearing the conflict', async () => {
    const { local, id } = await setup();
    await expect(resolveConflict(database, id, 'edit-merge', await conflictSnapshot(database, id),
      { ...local, id: 'replacement-id' })).rejects.toThrow('original ID');
    await expect(resolveConflict(database, id, 'edit-merge', await conflictSnapshot(database, id),
      { ...local, blocks: [] })).rejects.toThrow();
    expect(await database.sync.get(id)).toBeDefined();
    expect(await database.sessions.get(local.id)).toEqual(local);
  });

  it('does not overwrite edits made while review is open', async () => {
    const { local, id } = await setup();
    const opened = await conflictSnapshot(database, id);
    await database.sessions.put({ ...local, notes: 'Edited in another tab' });
    await expect(resolveConflict(database, id, 'use-cloud', opened)).rejects.toThrow('changed while');
    expect((await database.sessions.get(local.id))?.notes).toBe('Edited in another tab');
    expect(await database.sync.get(id)).toBeDefined();
  });

  it('requires a fresh review if the cloud version changes while the editor is open', async () => {
    const { cloud, id } = await setup();
    const opened = await conflictSnapshot(database, id);
    await database.sync.update(id, { remoteEtag: '"4"', remotePayload: { ...cloud, notes: 'Another cloud edit' } });
    await expect(resolveConflict(database, id, 'edit-merge', opened, cloud)).rejects.toThrow('changed while');
    expect(await database.sync.get(id)).toMatchObject({ remoteEtag: '"4"' });
  });

  it('keeps conflicts through downloads and preserves a new resolution after an interrupted upload', async () => {
    const { local, cloud, id, old } = await setup();
    await applyChanges(database, 'sync-user', [change(local.id, cloud, 3)], 4);
    expect(await database.sync.get(id)).toBeDefined();
    await resolveConflict(database, id, 'use-device', await conflictSnapshot(database, id));
    const replacement = (await database.outbox.where('entityId').equals(local.id).first())!;
    expect(replacement.id).not.toBe(old.id);
    await applyChanges(database, 'sync-user', [change(local.id, cloud, 3)], 4);
    expect(await database.outbox.get(replacement.id)).toBeDefined();
    expect(await database.sessions.get(local.id)).toEqual(local);
  });

  it('ignores a late acknowledgement from an upload replaced during resolution', async () => {
    database = new TrainingDB(`sync-${uid()}`, 'sync-user');
    await initialize(database);
    const plan = starterPlan(defaultProfile);
    const local = startSession(plan, plan.workouts[0], catalog);
    await createSession(local, database);
    const old = (await database.outbox.where('entityId').equals(local.id).first())!;
    let start!: () => void;
    let finish!: (response: Response) => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const response = new Promise<Response>(resolve => { finish = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => { start(); return response; }));
    const inFlight = upload(database, 'sync-user', async () => 'test-token');
    await started;
    const cloud = { ...local, notes: 'Cloud version' };
    const id = `conflict:sync-user:sessions:${local.id}`;
    await database.sync.put({ id, userId: 'sync-user', kind: 'conflict', entity: 'sessions', entityId: local.id,
      payload: local, remotePayload: cloud, remoteDeleted: false, remoteEtag: '"3"' });
    await database.outbox.update(old.id, { status: 'conflict' });
    await resolveConflict(database, id, 'use-device', await conflictSnapshot(database, id));
    finish(new Response(JSON.stringify({ results: [{ mutationId: old.id, status: 200, resource: 'sessions',
      id: local.id, etag: '"2"', document: local, error: null }] }), { status: 200 }));
    await inFlight;
    expect(await database.outbox.get(old.id)).toBeUndefined();
    expect((await database.outbox.where('entityId').equals(local.id).first())?.expectedEtag).toBe('"3"');
    expect((await database.sync.get(`root:sync-user:sessions:${local.id}`))?.etag).toBe('"3"');
  });

  it('keeps resolution history after the new mutation is acknowledged', async () => {
    const { local, id } = await setup();
    await resolveConflict(database, id, 'use-device', await conflictSnapshot(database, id));
    const queued = (await database.outbox.where('entityId').equals(local.id).first())!;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [{ mutationId: queued.id,
      status: 200, resource: 'sessions', id: local.id, etag: '"4"', document: local, error: null }] }), { status: 200 })));
    await upload(database, 'sync-user', async () => 'test-token');
    expect(await database.outbox.count()).toBe(0);
    expect(await database.sync.get(`root:sync-user:sessions:${local.id}`)).toMatchObject({
      etag: '"4"', resolutionChoice: 'use-device',
    });
  });

  it('accepts a cloud deletion with recovery and refuses to reuse a tombstoned ID', async () => {
    const { local, id } = await setup(true);
    const opened = await conflictSnapshot(database, id);
    await expect(resolveConflict(database, id, 'use-device', opened)).rejects.toThrow('ID cannot be reused');
    expect(await database.sync.get(id)).toBeDefined();
    await resolveConflict(database, id, 'use-cloud', opened);
    expect(await database.sessions.get(local.id)).toBeUndefined();
    expect((await recoveries()).some(item => JSON.stringify(item.payload).includes('local-set'))).toBe(true);
  });

  it('records a local deletion when choosing the cloud copy', async () => {
    const { local, cloud, id, old } = await setup();
    await database.sessions.delete(local.id);
    await database.outbox.update(old.id, { operation: 'delete', payload: null });
    await resolveConflict(database, id, 'use-cloud', await conflictSnapshot(database, id));
    expect(await database.sessions.get(local.id)).toEqual(cloud);
    expect((await recoveries()).some(item => item.reason === 'local deletion before conflict resolution' && item.payload === null)).toBe(true);
  });

  it('preserves a replaced cloud snapshot while a conflict stays unresolved', async () => {
    const { local, cloud, id } = await setup();
    await applyChanges(database, 'sync-user', [change(local.id, { ...cloud, notes: 'Newer cloud notes' })], 5);
    expect(await database.sync.get(id)).toMatchObject({ remoteEtag: '"4"' });
    expect((await recoveries()).some(item => (item.payload as typeof cloud).notes === 'Cloud notes')).toBe(true);
    expect(await database.sessions.get(local.id)).toEqual(local);
  });
});

import Dexie, { type Table } from 'dexie';
import { backupSchema, defaultProfile, planSchema, sessionSchema } from './domain';
import type { Backup, Exercise, Message, Plan, Profile, Proposal, ScheduleOverride, Session } from './domain';
import { catalog } from './catalog';

export class TrainingDB extends Dexie {
  profile!: Table<Profile>; exercises!: Table<Exercise>; plans!: Table<Plan>; sessions!: Table<Session>;
  overrides!: Table<ScheduleOverride>; messages!: Table<Message>; proposals!: Table<Proposal>; outbox!: Table<PendingChange>;
  sync!: Table<SyncRecord>;
  constructor(name = 'fitcoach-v1', readonly ownerId: string | null = name.startsWith('fitcoach-user-') ? name.slice('fitcoach-user-'.length) : null) {
    super(name);
    this.version(1).stores({ profile: 'id', exercises: 'id, name', plans: 'id', sessions: 'id, status, date',
      overrides: 'id, planId, date', messages: 'id, createdAt', proposals: 'id, messageId' });
    this.version(2).stores({ profile: 'id', exercises: 'id, name', plans: 'id', sessions: 'id, status, date',
      overrides: 'id, planId, date', messages: 'id, createdAt', proposals: 'id, messageId', outbox: 'id, createdAt, entity, entityId' });
    this.version(3).stores({ profile: 'id', exercises: 'id, name', plans: 'id', sessions: 'id, status, date',
      overrides: 'id, planId, date', messages: 'id, createdAt', proposals: 'id, messageId',
      outbox: 'id, createdAt, userId, entity, entityId, status, [userId+entity+entityId]',
      sync: 'id, userId, kind, entity, entityId' }).upgrade(async transaction => {
        const outbox = transaction.table('outbox');
        const changes = await outbox.toArray() as Array<Omit<PendingChange, 'entity'> & { entity: string }>;
        for (const change of changes) {
          if (!['profile', 'exercises', 'plans', 'sessions', 'overrides', 'schedule-overrides'].includes(change.entity)) {
            await outbox.delete(change.id);
            continue;
          }
          change.entity = (change.entity === 'overrides' ? 'schedule-overrides' : change.entity) as SyncEntity;
          change.status = 'pending'; change.localRevision ??= 1; change.expectedEtag ??= null;
          await outbox.put(change);
        }
      });
  }
}
export type SyncEntity = 'profile' | 'exercises' | 'plans' | 'sessions' | 'schedule-overrides';
export interface PendingChange {
  id: string; userId: string; createdAt: string; entity: SyncEntity; entityId: string;
  operation: 'upsert' | 'delete'; payload: unknown; expectedEtag: string | null;
  localRevision: number; status: 'pending' | 'awaiting-remote' | 'conflict' | 'failed'; sentAt?: string;
}
export interface SyncRecord {
  id: string; userId: string; kind: 'state' | 'root' | 'conflict' | 'recovery';
  entity?: SyncEntity; entityId?: string; cursor?: number; bootstrapComplete?: boolean;
  etag?: string | null; version?: number; remoteDeleted?: boolean; payload?: unknown; remotePayload?: unknown;
  remoteEtag?: string | null; reason?: string; createdAt?: string; updatedAt?: string;
}
export const legacyDb = new TrainingDB('fitcoach-v1');
export let db = legacyDb;
let activeUserId: string | null = null;
export function activateUserDatabase(userId: string) {
  if (!userId) throw new Error('An authenticated user is required to open training data.');
  if (activeUserId !== userId) { db = new TrainingDB(`fitcoach-user-${userId}`, userId); activeUserId = userId; }
  return db;
}
export function getActiveUserId() { return activeUserId; }

export async function enqueueChange(entity: string, entityId: string, operation: PendingChange['operation'], payload: unknown, database = db) {
  if (!database.ownerId) return;
  if (entity === 'overrides') entity = 'schedule-overrides';
  if (!['profile', 'exercises', 'plans', 'sessions', 'schedule-overrides'].includes(entity)) return;
  const resource = entity as SyncEntity;
  const pending = await database.outbox.where('[userId+entity+entityId]').equals([database.ownerId, resource, entityId]).sortBy('createdAt');
  const rootMeta = await database.sync.get(syncRootId(database.ownerId, resource, entityId));
  const localRevision = Math.max(0, ...pending.map(item => item.localRevision ?? 0)) + 1;
  const unsent = [...pending].reverse().find(item => item.status !== 'conflict' && !item.sentAt);
  if (unsent) {
    await database.outbox.put({ ...unsent, operation, payload, localRevision, status: 'pending' });
  } else {
    await database.outbox.add({ id: crypto.randomUUID(), userId: database.ownerId,
      createdAt: new Date().toISOString(), entity: resource, entityId, operation, payload,
      expectedEtag: rootMeta?.etag ?? null, localRevision, status: 'pending' });
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('fitcoach:local-change'));
}
export async function putLocalChange<T extends { id: string }>(entity: string, row: T, table: Table<T>, database = db) {
  await database.transaction('rw', [table, database.outbox, database.sync], async () => {
    await table.put(row);
    await enqueueChange(entity, row.id, 'upsert', row, database);
  });
}
export async function deleteLocalChange<T>(entity: string, id: string, table: Table<T>, database = db) {
  await database.transaction('rw', [table, database.outbox, database.sync], async () => {
    const before = await table.get(id as never);
    if (database.ownerId && before) await saveRecovery(database, entity, id, before, 'deleted locally');
    await table.delete(id as never);
    if (database.ownerId) {
      const resource = (entity === 'overrides' ? 'schedule-overrides' : entity) as SyncEntity;
      const rootMeta = await database.sync.get(syncRootId(database.ownerId, resource, id));
      const pending = await database.outbox.where('[userId+entity+entityId]').equals([database.ownerId, resource, id]).toArray();
      const unsyncedCreate = !rootMeta?.etag && pending.every(change => !change.sentAt);
      if (unsyncedCreate) await database.outbox.bulkDelete(pending.map(change => change.id));
      else await enqueueChange(resource, id, 'delete', null, database);
    }
  });
}

export const syncStateId = (userId: string) => `state:${userId}`;
export const syncRootId = (userId: string, entity: SyncEntity, id: string) => `root:${userId}:${entity}:${id}`;

export async function saveRecovery(database: TrainingDB, entity: string, entityId: string, payload: unknown, reason: string) {
  if (!database.ownerId) return;
  const id = `recovery:${crypto.randomUUID()}`;
  await database.sync.put({ id, userId: database.ownerId, kind: 'recovery',
    entity: (entity === 'overrides' ? 'schedule-overrides' : entity) as SyncEntity,
    entityId, payload: structuredClone(payload), reason, createdAt: new Date().toISOString() });
}

export async function hasLegacyData(database = legacyDb) {
  await database.open();
  const profile = await database.profile.get('profile');
  const exercises = await database.exercises.toArray();
  const catalogById = new Map(catalog.map(exercise => [exercise.id, exercise]));
  const hasCustomizedExercise = exercises.length > 0 && (exercises.length !== catalog.length || exercises.some(exercise =>
    JSON.stringify(catalogById.get(exercise.id)) !== JSON.stringify(exercise)));
  return Boolean((profile && JSON.stringify(profile) !== JSON.stringify(defaultProfile)) || hasCustomizedExercise ||
    await database.plans.count() || await database.sessions.count() || await database.overrides.count() ||
    await database.messages.count() || await database.proposals.count());
}

export async function importLegacyData(database = db, source = legacyDb) {
  const backup = await exportBackup(source);
  await importBackup(backup, database);
}

export async function initialize(database = db) {
  await database.transaction('rw', [database.profile, database.exercises], async () => {
    if (!await database.profile.get('profile')) await database.profile.put(structuredClone(defaultProfile));
    // Catalog IDs are stable and seed only missing built-ins; user edits survive restarts.
    const existing = new Set(await database.exercises.toCollection().primaryKeys());
    await database.exercises.bulkPut(catalog.filter(ex => !existing.has(ex.id)));
  });
}

export async function savePlan(plan: Plan, database = db) {
  const validated = planSchema.parse(plan);
  await database.transaction('rw', [database.plans, database.overrides, database.outbox, database.sync], async () => {
    if (validated.active) {
      const formerActive = await database.plans.filter(p => p.active && p.id !== validated.id).toArray();
      for (const previous of formerActive) {
        const updated = { ...previous, active: false };
        await database.plans.put(updated);
        await enqueueChange('plans', updated.id, 'upsert', updated, database);
      }
    }
    const existing = await database.plans.get(plan.id);
    await database.plans.put({ ...validated, cursor: Math.min(validated.cursor, validated.workouts.length - 1), revision: (existing?.revision ?? 0) + 1 });
    const workoutIds = new Set(validated.workouts.map(w => w.id));
    const removedOverrides = await database.overrides.where('planId').equals(plan.id).filter(override => !workoutIds.has(override.workoutId)).toArray();
    await database.overrides.where('planId').equals(plan.id).filter(override => !workoutIds.has(override.workoutId)).delete();
    for (const removed of removedOverrides) await enqueueChange('overrides', removed.id, 'delete', null, database);
    await enqueueChange('plans', validated.id, 'upsert', await database.plans.get(validated.id), database);
  });
}

export async function createSession(session: Session, database = db) {
  await database.transaction('rw', [database.sessions, database.outbox, database.sync], async () => {
    await database.sessions.add(sessionSchema.parse(session));
    await enqueueChange('sessions', session.id, 'upsert', sessionSchema.parse(session), database);
  });
}

export async function finishSession(session: Session, database = db) {
  await database.transaction('rw', [database.sessions, database.plans, database.outbox, database.sync], async () => {
    const persisted = await database.sessions.get(session.id);
    if (persisted?.status !== 'active') return;
    if (!persisted.blocks.some(b => b.sets.some(s => s.done))) throw new Error('Log at least one set before finishing.');
    await database.sessions.put(sessionSchema.parse({ ...persisted, status: 'completed', completedAt: new Date().toISOString(), timer: null }));
    await enqueueChange('sessions', session.id, 'upsert', await database.sessions.get(session.id), database);
    const plan = await database.plans.get(session.planId);
    if (plan?.schedule === 'rotation' && plan.workouts[plan.cursor]?.id === session.workoutId) {
      await database.plans.put({ ...plan, cursor: (plan.cursor + 1) % plan.workouts.length, revision: plan.revision + 1 });
      await enqueueChange('plans', plan.id, 'upsert', await database.plans.get(plan.id), database);
    }
  });
}

export async function applyProposal(proposal: Proposal, database = db) {
  await database.transaction('rw', [database.plans, database.proposals, database.overrides, database.outbox, database.sync], async () => {
    const current = await database.plans.get(proposal.plan.id);
    if (proposal.baseRevision !== null && current?.revision !== proposal.baseRevision)
      throw new Error('Your plan changed since this proposal. Ask for a fresh proposal before applying.');
    await savePlan({ ...proposal.plan, active: true }, database);
    await database.proposals.put({ ...proposal, status: 'applied' });
    await enqueueChange('proposals', proposal.id, 'upsert', await database.proposals.get(proposal.id), database);
  });
}

export async function exportBackup(database = db): Promise<Backup> {
  return database.transaction('r', database.tables, async () => backupSchema.parse({
    version: 1, exportedAt: new Date().toISOString(), profile: await database.profile.get('profile'),
    exercises: await database.exercises.toArray(), plans: await database.plans.toArray(), sessions: await database.sessions.toArray(),
    overrides: await database.overrides.toArray(), messages: await database.messages.toArray(), proposals: await database.proposals.toArray(),
  }));
}

export async function importBackup(value: unknown, database = db, queue = true) {
  // Parse before entering the replacement transaction. Failed imports never erase existing records.
  const backup = backupSchema.parse(value);
  const dataTables = database.tables.filter(table => !['outbox', 'sync'].includes(table.name));
  await database.transaction('rw', [...dataTables, database.outbox, database.sync], async () => {
    const previous = backupSchema.parse({ version: 1, exportedAt: new Date().toISOString(),
      profile: await database.profile.get('profile'), exercises: await database.exercises.toArray(),
      plans: await database.plans.toArray(), sessions: await database.sessions.toArray(),
      overrides: await database.overrides.toArray(), messages: await database.messages.toArray(),
      proposals: await database.proposals.toArray() });
    if (database.ownerId) await saveRecovery(database, 'backup', 'all', previous, 'before backup replacement');
    if (queue && database.ownerId) {
      const unsent = await database.outbox.where('userId').equals(database.ownerId).filter(change => !change.sentAt).toArray();
      await database.outbox.bulkDelete(unsent.map(change => change.id));
    }
    for (const table of dataTables) await table.clear();
    await database.profile.put(backup.profile);
    for (const key of ['exercises', 'plans', 'sessions', 'overrides', 'messages', 'proposals'] as const)
      await (database[key] as Table).bulkPut(backup[key]);
    if (queue) {
      await enqueueChange('profile', backup.profile.id, 'upsert', backup.profile, database);
      for (const exercise of backup.exercises) {
        const original = catalog.find(item => item.id === exercise.id);
        if (exercise.custom || !original || JSON.stringify(original) !== JSON.stringify(exercise))
          await enqueueChange('exercises', exercise.id, 'upsert', exercise, database);
      }
      for (const plan of backup.plans) await enqueueChange('plans', plan.id, 'upsert', plan, database);
      for (const override of backup.overrides) await enqueueChange('schedule-overrides', override.id, 'upsert', override, database);
      for (const session of backup.sessions) await enqueueChange('sessions', session.id, 'upsert', session, database);
    }
  });
}

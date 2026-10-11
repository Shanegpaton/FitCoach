import Dexie, { type Table } from 'dexie';
import { backupSchema, defaultProfile, planSchema, sessionSchema } from './domain';
import type { Backup, Exercise, Message, Plan, Profile, Proposal, ScheduleOverride, Session } from './domain';
import { catalog } from './catalog';

export class TrainingDB extends Dexie {
  profile!: Table<Profile>; exercises!: Table<Exercise>; plans!: Table<Plan>; sessions!: Table<Session>;
  overrides!: Table<ScheduleOverride>; messages!: Table<Message>; proposals!: Table<Proposal>; outbox!: Table<PendingChange>;
  constructor(name = 'fitcoach-v1', readonly ownerId: string | null = name.startsWith('fitcoach-user-') ? name.slice('fitcoach-user-'.length) : null) {
    super(name);
    this.version(1).stores({ profile: 'id', exercises: 'id, name', plans: 'id', sessions: 'id, status, date',
      overrides: 'id, planId, date', messages: 'id, createdAt', proposals: 'id, messageId' });
    this.version(2).stores({ profile: 'id', exercises: 'id, name', plans: 'id', sessions: 'id, status, date',
      overrides: 'id, planId, date', messages: 'id, createdAt', proposals: 'id, messageId', outbox: 'id, createdAt, entity, entityId' });
  }
}
export interface PendingChange { id: string; userId: string; createdAt: string; entity: string; entityId: string; operation: 'upsert' | 'delete'; payload: unknown }
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
  await database.outbox.add({ id: crypto.randomUUID(), userId: database.ownerId, createdAt: new Date().toISOString(), entity, entityId, operation, payload });
}
export async function putLocalChange<T extends { id: string }>(entity: string, row: T, table: Table<T>, database = db) {
  await database.transaction('rw', [table, database.outbox], async () => {
    await table.put(row);
    await enqueueChange(entity, row.id, 'upsert', row, database);
  });
}
export async function deleteLocalChange<T>(entity: string, id: string, table: Table<T>, database = db) {
  await database.transaction('rw', [table, database.outbox], async () => {
    await table.delete(id as never);
    await enqueueChange(entity, id, 'delete', null, database);
  });
}

export async function hasLegacyData(database = legacyDb) {
  await database.open();
  const profile = await database.profile.get('profile');
  const exercises = await database.exercises.toArray();
  const catalogById = new Map(catalog.map(exercise => [exercise.id, exercise]));
  const hasCustomizedExercise = exercises.length !== catalog.length || exercises.some(exercise =>
    JSON.stringify(catalogById.get(exercise.id)) !== JSON.stringify(exercise));
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
  await database.transaction('rw', [database.plans, database.overrides, database.outbox], async () => {
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
  await database.transaction('rw', [database.sessions, database.outbox], async () => {
    if (await database.sessions.where('status').equals('active').count()) throw new Error('Resume or finish your active workout first.');
    await database.sessions.add(sessionSchema.parse(session));
    await enqueueChange('sessions', session.id, 'upsert', sessionSchema.parse(session), database);
  });
}

export async function finishSession(session: Session, database = db) {
  await database.transaction('rw', [database.sessions, database.plans, database.outbox], async () => {
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
  await database.transaction('rw', [database.plans, database.proposals, database.overrides, database.outbox], async () => {
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
  const dataTables = database.tables.filter(table => table.name !== 'outbox');
  await database.transaction('rw', [...dataTables, database.outbox], async () => {
    for (const table of dataTables) await table.clear();
    await database.profile.put(backup.profile);
    for (const key of ['exercises', 'plans', 'sessions', 'overrides', 'messages', 'proposals'] as const)
      await (database[key] as Table).bulkPut(backup[key]);
    if (queue) await enqueueChange('backup', 'all', 'upsert', backup, database);
  });
}

import Dexie, { type Table } from 'dexie';
import { backupSchema, defaultProfile, planSchema, sessionSchema } from './domain';
import type { Backup, Exercise, Message, Plan, Profile, Proposal, ScheduleOverride, Session } from './domain';
import { catalog } from './catalog';

export class TrainingDB extends Dexie {
  profile!: Table<Profile>; exercises!: Table<Exercise>; plans!: Table<Plan>; sessions!: Table<Session>;
  overrides!: Table<ScheduleOverride>; messages!: Table<Message>; proposals!: Table<Proposal>;
  constructor(name = 'fitcoach-v1') {
    super(name);
    this.version(1).stores({ profile: 'id', exercises: 'id, name', plans: 'id', sessions: 'id, status, date',
      overrides: 'id, planId, date', messages: 'id, createdAt', proposals: 'id, messageId' });
  }
}
export const db = new TrainingDB();

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
  await database.transaction('rw', [database.plans, database.overrides], async () => {
    if (validated.active) {
      await database.plans.toCollection().modify(p => { p.active = false; });
    }
    const existing = await database.plans.get(plan.id);
    await database.plans.put({ ...validated, cursor: Math.min(validated.cursor, validated.workouts.length - 1), revision: (existing?.revision ?? 0) + 1 });
    const workoutIds = new Set(validated.workouts.map(w => w.id));
    await database.overrides.where('planId').equals(plan.id).filter(override => !workoutIds.has(override.workoutId)).delete();
  });
}

export async function createSession(session: Session, database = db) {
  await database.transaction('rw', database.sessions, async () => {
    if (await database.sessions.where('status').equals('active').count()) throw new Error('Resume or finish your active workout first.');
    await database.sessions.add(sessionSchema.parse(session));
  });
}

export async function finishSession(session: Session, database = db) {
  await database.transaction('rw', [database.sessions, database.plans], async () => {
    const persisted = await database.sessions.get(session.id);
    if (persisted?.status !== 'active') return;
    if (!persisted.blocks.some(b => b.sets.some(s => s.done))) throw new Error('Log at least one set before finishing.');
    await database.sessions.put(sessionSchema.parse({ ...persisted, status: 'completed', completedAt: new Date().toISOString(), timer: null }));
    const plan = await database.plans.get(session.planId);
    if (plan?.schedule === 'rotation' && plan.workouts[plan.cursor]?.id === session.workoutId) {
      await database.plans.put({ ...plan, cursor: (plan.cursor + 1) % plan.workouts.length, revision: plan.revision + 1 });
    }
  });
}

export async function applyProposal(proposal: Proposal, database = db) {
  await database.transaction('rw', [database.plans, database.proposals, database.overrides], async () => {
    const current = await database.plans.get(proposal.plan.id);
    if (proposal.baseRevision !== null && current?.revision !== proposal.baseRevision)
      throw new Error('Your plan changed since this proposal. Ask for a fresh proposal before applying.');
    await savePlan({ ...proposal.plan, active: true }, database);
    await database.proposals.put({ ...proposal, status: 'applied' });
  });
}

export async function exportBackup(database = db): Promise<Backup> {
  return database.transaction('r', database.tables, async () => backupSchema.parse({
    version: 1, exportedAt: new Date().toISOString(), profile: await database.profile.get('profile'),
    exercises: await database.exercises.toArray(), plans: await database.plans.toArray(), sessions: await database.sessions.toArray(),
    overrides: await database.overrides.toArray(), messages: await database.messages.toArray(), proposals: await database.proposals.toArray(),
  }));
}

export async function importBackup(value: unknown, database = db) {
  // Parse before entering the replacement transaction. Failed imports never erase existing records.
  const backup = backupSchema.parse(value);
  await database.transaction('rw', database.tables, async () => {
    for (const table of database.tables) await table.clear();
    await database.profile.put(backup.profile);
    for (const key of ['exercises', 'plans', 'sessions', 'overrides', 'messages', 'proposals'] as const)
      await (database[key] as Table).bulkPut(backup[key]);
  });
}

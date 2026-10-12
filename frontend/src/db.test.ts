import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrainingDB, applyProposal, createSession, exportBackup, finishSession, importBackup, importLegacyData, initialize, savePlan } from './db';
import { catalog, starterPlan } from './catalog';
import { backupSchema, defaultProfile, uid, type Proposal } from './domain';
import { startSession } from './training';

let db: TrainingDB;
beforeEach(async () => { db = new TrainingDB(`test-${uid()}`); await initialize(db); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); });

describe('durable local data', () => {
  it('keeps account databases isolated and copies anonymous data without deleting the source', async () => {
    const legacy = new TrainingDB(`legacy-${uid()}`); const accountA = new TrainingDB(`account-a-${uid()}`, 'user-a'); const accountB = new TrainingDB(`account-b-${uid()}`, 'user-b');
    await initialize(legacy); await legacy.profile.put({ ...(await legacy.profile.get('profile'))!, goals: 'Keep this plan' });
    const sourceBefore = await exportBackup(legacy);
    await initialize(accountA); await importLegacyData(accountA, legacy);
    expect((await accountA.profile.get('profile'))?.goals).toBe('Keep this plan');
    expect(await accountA.outbox.where('entity').equals('profile').count()).toBe(1);
    expect(await accountA.outbox.where('entity').equals('backup').count()).toBe(0);
    const sourceAfter = await exportBackup(legacy);
    expect(sourceAfter.profile).toEqual(sourceBefore.profile); expect(sourceAfter.exercises).toEqual(sourceBefore.exercises);
    await initialize(accountB);
    expect((await accountB.profile.get('profile'))?.goals).toBe('');
    await Promise.all([legacy.delete(), accountA.delete(), accountB.delete()]);
  });
  it('initializes a catalog without fabricating history and preserves catalog edits', async () => {
    expect(await db.sessions.count()).toBe(0); expect(await db.plans.count()).toBe(0);
    await db.exercises.update('ex-squat', { name: 'My squat' }); await initialize(db);
    expect((await db.exercises.get('ex-squat'))?.name).toBe('My squat');
  });
  it('keeps exactly one active plan', async () => {
    const a = starterPlan(defaultProfile), b = starterPlan(defaultProfile);
    await savePlan({ ...a, active: true }, db); await savePlan({ ...b, active: true }, db);
    expect((await db.plans.toArray()).filter(p => p.active).map(p => p.id)).toEqual([b.id]);
  });
  it('preserves separate active workouts started offline on different devices', async () => {
    const p = starterPlan(defaultProfile);
    await createSession(startSession(p, p.workouts[0], catalog), db);
    await createSession({ ...startSession(p, p.workouts[1], catalog), id: 'second-offline-session' }, db);
    expect(await db.sessions.where('status').equals('active').count()).toBe(2);
    expect(await db.sessions.count()).toBe(2);
  });
  it('finishing a rotation advances once and uses the latest persisted sets', async () => {
    const p = starterPlan(defaultProfile); p.schedule = 'rotation'; await savePlan(p, db);
    const s = startSession(p, p.workouts[0], catalog); await createSession(s, db);
    const saved = structuredClone(s); Object.assign(saved.blocks[0].sets[0], { kg: 30, reps: 8, done: true }); await db.sessions.put(saved);
    await finishSession(s, db); await finishSession(s, db);
    expect((await db.plans.get(p.id))?.cursor).toBe(1);
    expect((await db.sessions.get(s.id))?.blocks[0].sets[0].kg).toBe(30);
    db.close(); await db.open(); expect((await db.sessions.get(s.id))?.status).toBe('completed');
  });
  it('manual completion of another rotation workout does not advance the next workout', async () => {
    const p = starterPlan(defaultProfile); p.schedule = 'rotation'; await savePlan(p, db);
    const s = startSession(p, p.workouts[1], catalog); Object.assign(s.blocks[0].sets[0], { kg: 20, reps: 5, done: true }); await createSession(s, db);
    await finishSession(s, db); expect((await db.plans.get(p.id))?.cursor).toBe(0);
  });
  it('removes orphaned schedule overrides when a workout is removed', async () => {
    const p = starterPlan(defaultProfile); await savePlan(p, db);
    await db.overrides.add({ id: uid(), planId: p.id, workoutId: p.workouts[1].id, originalDate: '2026-10-14', date: '2026-10-15' });
    await savePlan({ ...p, workouts: [p.workouts[0]] }, db); expect(await db.overrides.count()).toBe(0);
  });
});

describe('backup safety and proposal review', () => {
  it('round-trips all saved entities and leaves exported snapshots independent', async () => {
    const p = starterPlan(defaultProfile); await savePlan(p, db);
    const s = startSession(p, p.workouts[0], catalog); await createSession(s, db);
    const backup = await exportBackup(db); await db.plans.clear(); await db.sessions.clear();
    await importBackup(backup, db); expect(await db.plans.count()).toBe(1); expect(await db.sessions.count()).toBe(1);
    backup.plans[0].name = 'Edited after importing'; expect((await db.plans.get(p.id))?.name).not.toBe('Edited after importing');
  });
  it('invalid imports do not touch existing data', async () => {
    await savePlan(starterPlan(defaultProfile), db); const before = await exportBackup(db);
    await expect(importBackup({ ...before, version: 99 }, db)).rejects.toThrow();
    expect((await exportBackup(db)).plans).toEqual(before.plans);
  });
  it('validates references, duplicate IDs, non-finite numbers, and real calendar dates', async () => {
    const p = starterPlan(defaultProfile); await savePlan(p, db); const backup = await exportBackup(db);
    const invalid = structuredClone(backup); invalid.plans[0].workouts[0].blocks[0].exerciseId = 'missing';
    expect(backupSchema.safeParse(invalid).success).toBe(false);
    expect(backupSchema.safeParse({ ...backup, plans: [backup.plans[0], backup.plans[0]] }).success).toBe(false);
    const session = startSession(p, p.workouts[0], catalog); session.date = '2026-02-31';
    expect(backupSchema.safeParse({ ...backup, sessions: [session] }).success).toBe(false);
    session.date = '2026-10-10'; session.blocks[0].sets[0].kg = Infinity;
    expect(backupSchema.safeParse({ ...backup, sessions: [session] }).success).toBe(false);
  });
  it('rolls back replacement if a write fails after tables were cleared', async () => {
    await savePlan(starterPlan(defaultProfile), db); const before = await exportBackup(db);
    const backup = structuredClone(before); backup.plans[0].name = 'New imported name';
    vi.spyOn(db.plans, 'bulkPut').mockRejectedValueOnce(new Error('Simulated storage failure'));
    await expect(importBackup(backup, db)).rejects.toThrow('Simulated storage failure');
    expect((await db.plans.toArray())[0].name).toBe(before.plans[0].name);
    expect(await db.exercises.count()).toBe(catalog.length);
  });
  it('applies a reviewed proposal without modifying an active workout snapshot', async () => {
    const p = starterPlan(defaultProfile); await savePlan(p, db); const savedPlan = (await db.plans.get(p.id))!;
    const s = startSession(savedPlan, savedPlan.workouts[0], catalog); await createSession(s, db);
    const proposal: Proposal = { id: uid(), messageId: 'message', plan: { ...savedPlan, name: 'Reviewed name' }, status: 'pending', baseRevision: savedPlan.revision };
    await db.proposals.add(proposal); await applyProposal(proposal, db);
    expect((await db.plans.get(p.id))?.name).toBe('Reviewed name');
    expect((await db.sessions.get(s.id))?.name).toBe(s.name);
    expect((await db.proposals.get(proposal.id))?.status).toBe('applied');
  });
  it('rejects a stale proposal instead of overwriting subsequent manual edits', async () => {
    const p = starterPlan(defaultProfile); await savePlan(p, db); const saved = (await db.plans.get(p.id))!;
    await savePlan({ ...saved, name: 'Manual edit' }, db);
    await expect(applyProposal({ id: uid(), messageId: 'm', plan: saved, status: 'pending', baseRevision: saved.revision }, db)).rejects.toThrow(/changed/);
    expect((await db.plans.get(p.id))?.name).toBe('Manual edit');
  });
});

import 'fake-indexeddb/auto';
import Dexie, { liveQuery } from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrainingDB, exportBackup, importBackup, initialize } from './db';
import { defaultProfile, uid, type Session } from './domain';
import { catalog, starterPlan } from './catalog';
import { startSession } from './training';
import { completedInRange, countJournal, journalCursor, readHistorySummary, readJournalPage, readMessageWindow, readPreviousPerformances, recentCompleted, weekBounds } from './historyQueries';

let database: TrainingDB;
function workout(id: string, date = '2026-10-15', completedAt = '2026-10-15T12:00:00.000Z'): Session {
  const plan = starterPlan(defaultProfile);
  const session = { ...startSession(plan, plan.workouts[0], catalog, date), id, status: 'completed' as const, completedAt };
  Object.assign(session.blocks[0].sets[0], { done: true, kg: 60, reps: 8 });
  return session;
}
beforeEach(async () => { database = new TrainingDB(`queries-${uid()}`, 'account-a'); await initialize(database); });
afterEach(async () => { vi.restoreAllMocks(); await database.delete(); });

describe('scoped history reads', () => {
  it('pages thousands of tied sessions without missing or duplicating IDs', async () => {
    const fixture = workout('base');
    await database.sessions.bulkPut(Array.from({ length: 2500 }, (_, i) => ({ ...fixture, id: `workout-${String(i).padStart(4, '0')}` })));
    const first = await readJournalPage(database, null);
    expect(first.rows).toHaveLength(20); expect(first.hasMore).toBe(true);
    expect(first.rows[0].id).toBe('workout-2499');
    const second = await readJournalPage(database, journalCursor(first.rows.at(-1)!));
    expect(second.rows[0].id).toBe('workout-2479');
    expect(new Set([...first.rows, ...second.rows].map(s => s.id)).size).toBe(40);
    const end = await readJournalPage(database, journalCursor({ ...fixture, id: 'workout-0001' }));
    expect(end.rows.map(s => s.id)).toEqual(['workout-0000']); expect(end.hasMore).toBe(false);
  });

  it('searches snapshot exercise names, workout names and dates across pages', async () => {
    const sessions = Array.from({ length: 45 }, (_, i) => ({ ...workout(`session-${String(i).padStart(2, '0')}`), name: 'Upper day' }));
    sessions[0].blocks[0].name = 'Archived exercise name';
    await database.sessions.bulkPut(sessions);
    expect(await countJournal(database, ' UPPER ')).toBe(45);
    expect((await readJournalPage(database, null, 'archived exercise')).rows.map(s => s.id)).toEqual(['session-00']);
    expect(await countJournal(database, '2026-10-15')).toBe(45);
    expect((await readJournalPage(database, null, 'missing')).rows).toEqual([]);
    const first = await readJournalPage(database, null, 'upper');
    const second = await readJournalPage(database, journalCursor(first.rows.at(-1)!), 'upper');
    expect(second.rows).toHaveLength(20);
    const third = await readJournalPage(database, journalCursor(second.rows.at(-1)!), 'upper');
    expect(third.rows).toHaveLength(5); expect(third.hasMore).toBe(false);
  });

  it('limits charts to their date window while preserving all-time totals and benchmarks', async () => {
    const old = workout('old', '2020-01-01'); old.blocks[0].sets[0].kg = 150;
    const current = workout('current');
    const active = { ...workout('active'), status: 'active' as const, completedAt: null };
    await database.sessions.bulkPut([old, current, active]);
    expect((await completedInRange(database, '2026-10-01', '2026-10-31').toArray()).map(s => s.id)).toEqual(['current']);
    const summary = await readHistorySummary(database);
    expect(summary.count).toBe(2); expect(summary.sets).toBe(2);
    expect(summary.exercises[0]).toMatchObject({ kg: 150, reps: 8, sets: 2 });
    expect(weekBounds('2026-11-01', 4)).toEqual({ start: '2026-10-05', end: '2026-11-01' });
  });

  it('uses completion time for recent workouts and excludes the current session from previous performance', async () => {
    const old = workout('old', '2026-10-20', '2026-10-10T12:00:00.000Z');
    const last = workout('last', '2026-10-01', '2026-10-15T12:00:00.000Z'); last.blocks[0].sets[0].kg = 80;
    const current = workout('current', '2026-10-21', '2026-10-21T12:00:00.000Z'); current.blocks[0].sets[0].kg = 100;
    await database.sessions.bulkPut([old, last, current]);
    expect((await recentCompleted(database, 2)).map(s => s.id)).toEqual(['current', 'last']);
    const previous = await readPreviousPerformances(database, 'current', [current.blocks[0].exerciseId, 'unknown']);
    expect(previous[current.blocks[0].exerciseId][0].kg).toBe(80); expect(previous.unknown).toBeUndefined();
  });

  it('keeps reads account-owned and backup replacement visible without a second cache', async () => {
    const other = new TrainingDB(`queries-other-${uid()}`, 'account-b');
    try {
      await initialize(other); await database.sessions.put(workout('account-a-only'));
      expect((await readJournalPage(other, null)).rows).toEqual([]);
      const backup = await exportBackup(database);
      await database.sessions.put(workout('later'));
      await importBackup(backup, database);
      expect((await readJournalPage(database, null)).rows.map(s => s.id)).toEqual(['account-a-only']);
    } finally { await other.delete(); }
  });

  it('does not rerun completed-history subscriptions for messages or active-set edits', async () => {
    const active = { ...workout('active'), status: 'active' as const, completedAt: null };
    await database.sessions.bulkPut([workout('completed'), active]);
    const read = vi.fn(() => readJournalPage(database, null));
    const received: string[][] = [];
    const summaryRead = vi.fn(() => readHistorySummary(database));
    const rangeRead = vi.fn(() => completedInRange(database, '2026-10-01', '2026-10-31').toArray());
    const errors: unknown[] = [];
    const subscriptions = [
      liveQuery(read).subscribe({ next: page => received.push(page.rows.map(s => s.id)), error: error => errors.push(error) }),
      liveQuery(summaryRead).subscribe({ error: error => errors.push(error) }),
      liveQuery(rangeRead).subscribe({ error: error => errors.push(error) }),
    ];
    try {
      await vi.waitFor(() => { expect(received).toHaveLength(1); expect(summaryRead).toHaveBeenCalledTimes(1); expect(rangeRead).toHaveBeenCalledTimes(1); });
      await database.messages.put({ id: 'sample', role: 'user', text: 'Hello', createdAt: new Date().toISOString() });
      active.blocks[0].sets[0].kg = 90; await database.sessions.put(active);
      // Let Dexie's mutation notifications settle before checking query isolation.
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(read).toHaveBeenCalledTimes(1); expect(summaryRead).toHaveBeenCalledTimes(1); expect(rangeRead).toHaveBeenCalledTimes(1);
      expect(errors).toEqual([]);
      await database.sessions.update('completed', { name: 'Corrected snapshot' });
      await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(2); expect(summaryRead).toHaveBeenCalledTimes(2); expect(rangeRead).toHaveBeenCalledTimes(2); });
    } finally { subscriptions.forEach(subscription => subscription.unsubscribe()); }
  });

  it('reads a bounded message window with stable ordering and preserves older records', async () => {
    await database.messages.bulkPut(Array.from({ length: 125 }, (_, i) => ({ id: `message-${String(i).padStart(3, '0')}`, role: 'user' as const, text: 'Sample', createdAt: '2026-10-01T12:00:00.000Z' })));
    const window = await readMessageWindow(database, 100);
    expect(window.messages).toHaveLength(100); expect(window.hasOlder).toBe(true);
    expect(window.messages[0].id).toBe('message-025');
    expect((await readMessageWindow(database, 200)).hasOlder).toBe(false);
    expect(await database.messages.count()).toBe(125);
  });

  it('adds query indexes to a v3 database without changing snapshots, outbox or recovery copies', async () => {
    const name = `v3-${uid()}`;
    const legacy = new Dexie(name);
    legacy.version(3).stores({ profile: 'id', exercises: 'id, name', plans: 'id', sessions: 'id, status, date',
      overrides: 'id, planId, date', messages: 'id, createdAt', proposals: 'id, messageId',
      outbox: 'id, createdAt, userId, entity, entityId, status, [userId+entity+entityId]', sync: 'id, userId, kind, entity, entityId' });
    const snapshot = workout('durable');
    await legacy.table('sessions').put(snapshot);
    await legacy.table('outbox').put({ id: 'pending', userId: 'account-a', entity: 'sessions', entityId: snapshot.id, payload: snapshot });
    await legacy.table('sync').put({ id: 'recovery', userId: 'account-a', kind: 'recovery', payload: snapshot });
    legacy.close();
    const upgraded = new TrainingDB(name, 'account-a');
    try {
      expect((await readJournalPage(upgraded, null)).rows).toEqual([snapshot]);
      expect((await upgraded.outbox.get('pending'))?.payload).toEqual(snapshot);
      expect((await upgraded.sync.get('recovery'))?.payload).toEqual(snapshot);
    } finally { await upgraded.delete(); }
  });
});

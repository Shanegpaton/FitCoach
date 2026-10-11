import { describe, expect, it } from 'vitest';
import { catalog, starterPlan } from './catalog';
import { defaultProfile, toKg, fromKg, newSet } from './domain';
import { completedStats, lastPerformance, nextSet, restAfterSet, scheduledWorkout, startSession, timerRemaining, weeklyStats } from './training';

describe('workout scheduling and snapshots', () => {
  it('schedules weekdays without silently making a rest day a training day', () => {
    const plan = starterPlan(defaultProfile);
    expect(scheduledWorkout(plan, '2026-10-12')?.name).toBe('Full body A');
    expect(scheduledWorkout(plan, '2026-10-13')).toBeUndefined();
    expect(scheduledWorkout(plan, '2026-10-14')?.name).toBe('Full body B');
  });
  it('moves only one occurrence and leaves next week alone', () => {
    const plan = starterPlan(defaultProfile);
    const overrides = [{ id: 'move', planId: plan.id, workoutId: plan.workouts[0].id, originalDate: '2026-10-12', date: '2026-10-13' }];
    expect(scheduledWorkout(plan, '2026-10-12', overrides)).toBeUndefined();
    expect(scheduledWorkout(plan, '2026-10-13', overrides)?.id).toBe(plan.workouts[0].id);
    expect(scheduledWorkout(plan, '2026-10-19', overrides)?.id).toBe(plan.workouts[0].id);
  });
  it('rotations use the cursor independently of weekdays', () => {
    const plan = starterPlan(defaultProfile); plan.schedule = 'rotation'; plan.cursor = 1;
    expect(scheduledWorkout(plan, '2026-10-13')?.id).toBe(plan.workouts[1].id);
    expect(scheduledWorkout(plan, '2026-10-14')?.id).toBe(plan.workouts[1].id);
  });
  it('snapshotting a session isolates it from later plan and catalog edits', () => {
    const plan = starterPlan(defaultProfile); const exercises = structuredClone(catalog);
    const session = startSession(plan, plan.workouts[0], exercises);
    plan.workouts[0].blocks[0].sets[0].targetReps = 30; exercises[0].name = 'Renamed';
    expect(session.blocks[0].sets[0].targetReps).toBe(8);
    expect(session.blocks[0].name).toBe('Barbell squat');
    expect(session.blocks[0].sets[0].kg).toBeNull();
  });
  it('rejects starting an empty workout', () => {
    const plan = starterPlan(defaultProfile); plan.workouts[0].blocks = [];
    expect(() => startSession(plan, plan.workouts[0], catalog)).toThrow(/Add an exercise/);
  });
});

describe('advanced set flow and timers', () => {
  const makeSession = () => { const p = starterPlan(defaultProfile); return startSession(p, p.workouts[0], catalog); };
  it('does not rest until a superset round is finished', () => {
    const s = makeSession(); s.blocks[0].supersetId = s.blocks[1].supersetId = 'pair';
    s.blocks[0].sets[0].done = true;
    expect(restAfterSet(s.blocks, 0, 0)).toBe(0);
    expect(nextSet(s.blocks, 0, 0)).toEqual({ block: 1, set: 0 });
    s.blocks[1].sets[0].done = true;
    expect(restAfterSet(s.blocks, 1, 0)).toBe(90);
    expect(nextSet(s.blocks, 1, 0)).toEqual({ block: 0, set: 1 });
  });
  it('finishes a drop chain before moving to a paired exercise or resting', () => {
    const s = makeSession(); s.blocks[0].supersetId = s.blocks[1].supersetId = 'pair';
    s.blocks[0].sets[0].chainId = 'drop-chain'; s.blocks[0].sets[0].done = true;
    s.blocks[0].sets.splice(1, 0, { ...newSet('drop', 'drop-chain'), kg: null, reps: null, effort: null, done: false });
    expect(restAfterSet(s.blocks, 0, 0)).toBe(0);
    expect(nextSet(s.blocks, 0, 0)).toEqual({ block: 0, set: 1 });
    s.blocks[0].sets[1].done = true;
    expect(nextSet(s.blocks, 0, 1)).toEqual({ block: 1, set: 0 });
    expect(restAfterSet(s.blocks, 0, 1)).toBe(0);
  });
  it('calculates remaining rest from a deadline after suspension or reload', () => {
    const timer = { endAt: 100000, duration: 90, remaining: 90 };
    expect(timerRemaining(timer, 50000)).toBe(50);
    expect(timerRemaining(timer, 101000)).toBe(0);
    expect(timerRemaining({ ...timer, endAt: null, remaining: 22 }, 101000)).toBe(22);
  });
});

describe('history and units', () => {
  it('converts units without changing the underlying load', () => {
    expect(toKg(100, 'lb')).toBeCloseTo(45.359237);
    expect(fromKg(toKg(100, 'lb'), 'lb')).toBeCloseTo(100);
    expect(toKg(50, 'kg')).toBe(50);
  });
  it('excludes warm-ups and incomplete sets from working volume', () => {
    const p = starterPlan(defaultProfile); const s = startSession(p, p.workouts[0], catalog);
    const sets = s.blocks[0].sets;
    Object.assign(sets[0], { kind: 'warmup', kg: 10, reps: 5, done: true });
    Object.assign(sets[1], { kg: 50, reps: 8, done: true });
    Object.assign(sets[2], { kg: 50, reps: 8, done: false });
    expect(completedStats(s)).toEqual({ sets: 1, volumeKg: 400 });
  });
  it('counts bodyweight reps but does not invent a bodyweight for volume', () => {
    const p = starterPlan({ ...defaultProfile, equipment: ['Bodyweight'] }); const s = startSession(p, p.workouts[0], catalog);
    Object.assign(s.blocks[0].sets[0], { reps: 12, done: true });
    expect(completedStats(s)).toEqual({ sets: 1, volumeKg: 0 });
  });
  it('last performance uses completed sessions, not an unfinished workout', () => {
    const p = starterPlan(defaultProfile); const earlier = startSession(p, p.workouts[0], catalog);
    earlier.status = 'completed'; earlier.completedAt = '2026-10-09T12:00:00.000Z';
    Object.assign(earlier.blocks[0].sets[0], { kg: 20, reps: 8, done: true });
    const active = startSession(p, p.workouts[0], catalog);
    Object.assign(active.blocks[0].sets[0], { kg: 40, reps: 8, done: true });
    expect(lastPerformance([earlier, active], earlier.blocks[0].exerciseId)[0].kg).toBe(20);
  });
  it('groups weekly history by calendar date and ignores active sessions', () => {
    const p = starterPlan(defaultProfile); const s = startSession(p, p.workouts[0], catalog, '2026-10-12');
    s.status = 'completed'; Object.assign(s.blocks[0].sets[0], { kg: 20, reps: 5, done: true });
    const active = startSession(p, p.workouts[0], catalog, '2026-10-13');
    const weeks = weeklyStats([s, active], 2, new Date('2026-10-14T12:00:00'));
    expect(weeks[0].workouts).toBe(0); expect(weeks[1]).toMatchObject({ date: '2026-10-12', workouts: 1, sets: 1, volumeKg: 100 });
  });
});

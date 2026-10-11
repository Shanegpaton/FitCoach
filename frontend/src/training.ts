import { atNoon, localDate, uid } from './domain';
import type { Exercise, Plan, ScheduleOverride, Session, SessionBlock, Timer, Workout } from './domain';

export function scheduledWorkout(plan: Plan, date: string, overrides: ScheduleOverride[] = []): Workout | undefined {
  if (plan.schedule === 'rotation') return plan.workouts[plan.cursor % plan.workouts.length];
  const movedHere = overrides.find(o => o.planId === plan.id && o.date === date);
  if (movedHere) return plan.workouts.find(w => w.id === movedHere.workoutId);
  return plan.workouts.find(w => w.days.includes(atNoon(date).getDay()) &&
    !overrides.some(o => o.planId === plan.id && o.workoutId === w.id && o.originalDate === date));
}

export function startSession(plan: Plan, workout: Workout, exercises: Exercise[], date = localDate()): Session {
  if (!workout.blocks.length) throw new Error('Add an exercise before starting this workout.');
  return {
    id: uid(), planId: plan.id, workoutId: workout.id, name: workout.name, date,
    startedAt: new Date().toISOString(), completedAt: null, status: 'active', notes: '', timer: null,
    blocks: workout.blocks.map(block => {
      const exercise = exercises.find(ex => ex.id === block.exerciseId);
      if (!exercise) throw new Error('This workout references an unknown exercise.');
      return { ...structuredClone(block), name: exercise.name, loadMode: exercise.loadMode, notes: '',
        sets: block.sets.map(set => ({ ...set, kg: null, reps: null, effort: null, done: false })) };
    }),
  };
}

export function completedStats(session: Session) {
  const sets = session.blocks.flatMap(block => block.sets).filter(set => set.done && set.kind !== 'warmup');
  return { sets: sets.length, volumeKg: sets.reduce((total, set) => total + (set.kg ?? 0) * (set.reps ?? 0), 0) };
}

export function timerRemaining(timer: Timer, now = Date.now()) {
  return timer.endAt === null ? timer.remaining : Math.max(0, Math.ceil((timer.endAt - now) / 1000));
}

// Complete a whole drop chain or superset round before automatically starting rest.
export function restAfterSet(blocks: SessionBlock[], blockIndex: number, setIndex: number): number {
  const block = blocks[blockIndex];
  const set = block.sets[setIndex];
  if (set.kind === 'warmup') return block.restSeconds;
  if (set.chainId && block.sets.some(s => s.chainId === set.chainId && !s.done)) return 0;
  if (block.supersetId) {
    const roundIndex = block.sets.slice(0, setIndex + 1).filter(s => s.kind !== 'warmup' && s.kind !== 'drop').length - 1;
    const group = blocks.filter(b => b.supersetId === block.supersetId);
    for (const member of group) {
      const rounds = member.sets.filter(s => s.kind === 'working');
      const round = rounds[roundIndex];
      if (round && (!round.done || (round.chainId && member.sets.some(s => s.chainId === round.chainId && !s.done)))) return 0;
    }
  }
  return block.restSeconds;
}

export function nextSet(blocks: SessionBlock[], blockIndex: number, setIndex: number): { block: number; set: number } | null {
  const current = blocks[blockIndex];
  const logged = current.sets[setIndex];
  if (logged.chainId) {
    const next = current.sets.findIndex(s => s.chainId === logged.chainId && !s.done);
    if (next >= 0) return { block: blockIndex, set: next };
  }
  if (current.supersetId && logged.kind !== 'warmup') {
    const groupIndices = blocks.map((b, i) => b.supersetId === current.supersetId ? i : -1).filter(i => i >= 0);
    const round = current.sets.slice(0, setIndex + 1).filter(s => s.kind === 'working').length - 1;
    for (const i of groupIndices.slice(groupIndices.indexOf(blockIndex) + 1)) {
      const candidates = blocks[i].sets.map((s, j) => s.kind === 'working' ? j : -1).filter(j => j >= 0);
      if (candidates[round] !== undefined && !blocks[i].sets[candidates[round]].done) return { block: i, set: candidates[round] };
    }
    for (const i of groupIndices) {
      const next = blocks[i].sets.findIndex(s => !s.done);
      if (next >= 0) return { block: i, set: next };
    }
  }
  for (const i of [...blocks.keys()].slice(blockIndex).concat([...blocks.keys()].slice(0, blockIndex))) {
    const next = blocks[i].sets.findIndex(s => !s.done);
    if (next >= 0) return { block: i, set: next };
  }
  return null;
}

export function lastPerformance(sessions: Session[], exerciseId: string) {
  const session = [...sessions].filter(s => s.status === 'completed' && s.blocks.some(b => b.exerciseId === exerciseId))
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
  const block = session?.blocks.find(b => b.exerciseId === exerciseId);
  return block?.sets.filter(s => s.done && s.kind !== 'warmup') ?? [];
}

export function weeklyStats(sessions: Session[], weeks = 8, now = new Date()) {
  const monday = new Date(now); monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return Array.from({ length: weeks }, (_, index) => {
    const start = new Date(monday); start.setDate(start.getDate() - (weeks - 1 - index) * 7);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    const completed = sessions.filter(s => s.status === 'completed' && s.date >= localDate(start) && s.date < localDate(end));
    return { date: localDate(start), label: start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      workouts: completed.length, sets: completed.reduce((n, s) => n + completedStats(s).sets, 0),
      volumeKg: completed.reduce((n, s) => n + completedStats(s).volumeKg, 0) };
  });
}

import { catalog, starterPlan } from '../src/catalog';
import { backupSchema, defaultProfile, localDate, type Backup, type Session } from '../src/domain';

/** Synthetic data only. Dates move with today; IDs remain deterministic. */
export function demoBackup(count = 24): Backup {
  const profile = { ...defaultProfile, goals: 'Build strength consistently', unit: 'kg' as const, onboardingDone: true };
  const plan = starterPlan(profile);
  plan.id = 'demo-plan'; plan.name = 'Demo strength routine'; plan.active = true; plan.schedule = 'rotation';
  plan.workouts.forEach((workout, index) => {
    workout.id = `demo-workout-${index}`; workout.days = []; workout.durationMinutes = 45;
    workout.blocks.forEach((block, b) => {
      block.id = `demo-block-${index}-${b}`;
      block.sets.forEach((set, s) => { set.id = `demo-set-${index}-${b}-${s}`; set.targetKg = 20 + b * 10; });
    });
  });
  const sessions: Session[] = Array.from({ length: count }, (_, i) => {
    const day = new Date(); day.setDate(day.getDate() - (count - i) * 2); day.setHours(12, 0, 0, 0);
    const workout = plan.workouts[i % plan.workouts.length];
    return {
      id: `demo-session-${i}`, planId: plan.id, workoutId: workout.id, name: workout.name,
      date: localDate(day), startedAt: day.toISOString(), completedAt: new Date(day.getTime() + 40 * 60000).toISOString(),
      status: 'completed', timer: null, notes: 'Synthetic portfolio example',
      blocks: workout.blocks.map(block => {
        const exercise = catalog.find(item => item.id === block.exerciseId)!;
        return { ...block, name: exercise.name, loadMode: exercise.loadMode, notes: '',
          sets: block.sets.map(set => ({ ...set, kg: (set.targetKg ?? 20) + (Math.floor(i / 6) % 12) * 2.5, reps: 8, effort: 7, done: true })) };
      }),
    };
  });
  return backupSchema.parse({ version: 1, exportedAt: new Date().toISOString(), profile, exercises: catalog,
    plans: [plan], sessions, overrides: [], messages: [], proposals: [] });
}


import type { Exercise, Plan, Profile } from './domain';
import { newBlock, uid } from './domain';

export const catalog: Exercise[] = [
  ['squat', 'Barbell squat', 'Quads', 'Barbell'],
  ['bench', 'Bench press', 'Chest', 'Barbell'],
  ['deadlift', 'Romanian deadlift', 'Hamstrings', 'Barbell'],
  ['row', 'Dumbbell row', 'Back', 'Dumbbell'],
  ['press', 'Overhead press', 'Shoulders', 'Dumbbell'],
  ['pulldown', 'Lat pulldown', 'Back', 'Cable'],
  ['legpress', 'Leg press', 'Quads', 'Machine'],
  ['curl', 'Biceps curl', 'Arms', 'Dumbbell'],
  ['triceps', 'Triceps pushdown', 'Arms', 'Cable'],
  ['lateral', 'Lateral raise', 'Shoulders', 'Dumbbell'],
  ['pullup', 'Pull-up', 'Back', 'Bodyweight'],
  ['pushup', 'Push-up', 'Chest', 'Bodyweight'],
].map(([id, name, muscle, equipment]) => ({
  id: `ex-${id}`, name, muscle, equipment, custom: false,
  loadMode: equipment === 'Bodyweight' ? 'bodyweight' : 'external',
}));

export function starterPlan(profile: Profile): Plan {
  const gym = profile.equipment.includes('Full gym');
  const bodyweight = profile.equipment.includes('Bodyweight') && !gym && !profile.equipment.includes('Dumbbells');
  const blocks = (ids: string[]) => ids.map(id => newBlock(`ex-${id}`));
  const days = profile.trainingDays.length ? profile.trainingDays : [1, 3, 5];
  return {
    id: uid(), name: 'Full body foundations', description: '', schedule: 'week', cursor: 0, revision: 0, active: false,
    workouts: [
      { id: uid(), name: 'Full body A', days: days.filter((_, index) => index % 2 === 0),
        blocks: blocks(bodyweight ? ['pushup', 'pullup'] : gym ? ['squat', 'bench', 'row'] : ['press', 'row', 'curl']) },
      { id: uid(), name: 'Full body B', days: days.filter((_, index) => index % 2 === 1),
        blocks: blocks(bodyweight ? ['pullup', 'pushup'] : gym ? ['deadlift', 'press', 'pulldown'] : ['row', 'press', 'lateral']) },
    ],
  };
}

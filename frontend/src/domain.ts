import { z } from 'zod';

const id = z.string().min(1);
const day = z.number().int().min(0).max(6);
const timestamp = z.string().datetime();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T12:00:00`);
  return !Number.isNaN(parsed.getTime()) && localDate(parsed) === value;
}, 'Invalid calendar date');
export const profileSchema = z.object({
  id: z.literal('profile'), goals: z.string().max(2000), experience: z.string(),
  equipment: z.array(z.string()), trainingDays: z.array(day), sessionMinutes: z.number().int().min(10).max(180),
  unit: z.enum(['lb', 'kg']), onboardingDone: z.boolean(),
});
export const exerciseSchema = z.object({
  id, name: z.string().trim().min(1).max(100), muscle: z.string().max(100), equipment: z.string().max(100),
  loadMode: z.enum(['external', 'bodyweight']), custom: z.boolean(),
});
export const prescriptionSchema = z.object({
  id, kind: z.enum(['warmup', 'working', 'drop']), targetReps: z.number().int().min(1).max(100),
  targetKg: z.number().finite().min(0).max(2000).nullable(), chainId: id.nullable(),
});
export const blockSchema = z.object({
  id, exerciseId: id, restSeconds: z.number().int().min(0).max(1800), supersetId: id.nullable(),
  sets: z.array(prescriptionSchema).min(1).max(40),
});
export const workoutSchema = z.object({
  id, name: z.string().trim().min(1).max(100), days: z.array(day), blocks: z.array(blockSchema).min(1).max(50),
});
export const planSchema = z.object({
  id, name: z.string().trim().min(1).max(100), schedule: z.enum(['week', 'rotation']),
  cursor: z.number().int().min(0), revision: z.number().int().min(0),
  active: z.boolean(), workouts: z.array(workoutSchema).min(1).max(30),
}).superRefine((plan, ctx) => {
  if (plan.cursor >= plan.workouts.length) ctx.addIssue({ code: 'custom', message: 'Invalid rotation cursor' });
  if (new Set(plan.workouts.map(w => w.id)).size !== plan.workouts.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate workout IDs' });
  if (plan.schedule === 'week') {
    const days = plan.workouts.flatMap(w => w.days);
    if (new Set(days).size !== days.length) ctx.addIssue({ code: 'custom', message: 'Only one workout can be assigned to each weekday' });
  }
});
export const loggedSetSchema = prescriptionSchema.extend({
  kg: z.number().finite().min(0).max(2000).nullable(), reps: z.number().int().min(1).max(100).nullable(),
  effort: z.number().finite().min(1).max(10).nullable(), done: z.boolean(),
}).refine(set => !set.done || set.reps !== null, 'Completed sets need reps');
export const sessionBlockSchema = z.object({
  id, exerciseId: id, name: z.string().min(1), loadMode: z.enum(['external', 'bodyweight']),
  restSeconds: z.number().int().min(0).max(1800), supersetId: id.nullable(),
  notes: z.string().max(5000), sets: z.array(loggedSetSchema).min(1),
});
export const timerSchema = z.object({
  endAt: z.number().finite().nullable(), remaining: z.number().finite().min(0),
  duration: z.number().int().min(0).max(1800),
});
export const sessionSchema = z.object({
  id, planId: id, workoutId: id, name: z.string().min(1), date, startedAt: timestamp,
  completedAt: timestamp.nullable(), status: z.enum(['active', 'completed']),
  blocks: z.array(sessionBlockSchema).min(1), timer: timerSchema.nullable(), notes: z.string().max(5000),
}).superRefine((session, ctx) => {
  if (session.status === 'completed' && session.completedAt === null)
    ctx.addIssue({ code: 'custom', message: 'Completed sessions need a completion time' });
  for (const block of session.blocks) for (const set of block.sets)
    if (set.done && block.loadMode === 'external' && set.kg === null)
      ctx.addIssue({ code: 'custom', message: 'Completed weighted sets need a load' });
});
export const overrideSchema = z.object({ id, planId: id, workoutId: id, originalDate: date, date });
export const messageSchema = z.object({
  id, role: z.enum(['user', 'assistant']), text: z.string().min(1).max(10000), createdAt: timestamp,
  source: z.enum(['sample', 'chatgpt']).optional(),
});
export const proposalSchema = z.object({
  id, messageId: id, plan: planSchema, status: z.enum(['pending', 'applied', 'rejected']),
  baseRevision: z.number().int().nullable(),
});
export const backupSchema = z.object({
  version: z.literal(1), exportedAt: timestamp, profile: profileSchema,
  exercises: z.array(exerciseSchema), plans: z.array(planSchema), sessions: z.array(sessionSchema),
  overrides: z.array(overrideSchema), messages: z.array(messageSchema), proposals: z.array(proposalSchema),
}).superRefine((backup, ctx) => {
  for (const table of ['exercises', 'plans', 'sessions', 'overrides', 'messages', 'proposals'] as const) {
    if (new Set(backup[table].map(row => row.id)).size !== backup[table].length)
      ctx.addIssue({ code: 'custom', message: `Duplicate IDs in ${table}` });
  }
  const exerciseIds = new Set(backup.exercises.map(ex => ex.id));
  const plans = [...backup.plans, ...backup.proposals.map(proposal => proposal.plan)];
  for (const plan of plans) {
    if (plan.cursor >= plan.workouts.length) ctx.addIssue({ code: 'custom', message: 'Invalid rotation cursor' });
    if (new Set(plan.workouts.map(w => w.id)).size !== plan.workouts.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate workout IDs' });
    for (const workout of plan.workouts) for (const block of workout.blocks) {
      if (!exerciseIds.has(block.exerciseId)) ctx.addIssue({ code: 'custom', message: 'Unknown exercise in plan' });
    }
  }
  if (backup.plans.filter(plan => plan.active).length > 1) ctx.addIssue({ code: 'custom', message: 'Multiple active plans' });
  for (const override of backup.overrides) {
    if (!backup.plans.some(plan => plan.id === override.planId && plan.workouts.some(w => w.id === override.workoutId)))
      ctx.addIssue({ code: 'custom', message: 'Schedule override references a missing workout' });
  }
  for (const proposal of backup.proposals) if (!backup.messages.some(m => m.id === proposal.messageId))
    ctx.addIssue({ code: 'custom', message: 'Proposal references a missing message' });
});

export type Profile = z.infer<typeof profileSchema>;
export type Exercise = z.infer<typeof exerciseSchema>;
export type Prescription = z.infer<typeof prescriptionSchema>;
export type Block = z.infer<typeof blockSchema>;
export type Workout = z.infer<typeof workoutSchema>;
export type Plan = z.infer<typeof planSchema>;
export type LoggedSet = z.infer<typeof loggedSetSchema>;
export type SessionBlock = z.infer<typeof sessionBlockSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Timer = z.infer<typeof timerSchema>;
export type ScheduleOverride = z.infer<typeof overrideSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Backup = z.infer<typeof backupSchema>;

export const uid = () => crypto.randomUUID();
export const localDate = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const atNoon = (date: string) => new Date(`${date}T12:00:00`);
export const fromKg = (kg: number, unit: Profile['unit']) => unit === 'lb' ? kg / 0.45359237 : kg;
export const toKg = (value: number, unit: Profile['unit']) => unit === 'lb' ? value * 0.45359237 : value;
export const formatLoad = (kg: number, unit: Profile['unit']) => Number(fromKg(kg, unit).toFixed(1)).toString();
export const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const defaultProfile: Profile = {
  id: 'profile', goals: '', experience: 'Beginner', equipment: ['Full gym'], trainingDays: [1, 3, 5],
  sessionMinutes: 45, unit: 'lb', onboardingDone: false,
};
export function newSet(kind: Prescription['kind'] = 'working', chainId: string | null = null): Prescription {
  return { id: uid(), kind, targetReps: 8, targetKg: null, chainId };
}
export function newBlock(exerciseId: string): Block {
  return { id: uid(), exerciseId, restSeconds: 90, supersetId: null, sets: [newSet(), newSet(), newSet()] };
}
export function normalizeDropChains(sets: Prescription[]) {
  for (let i = 0; i < sets.length; i++) {
    const set = sets[i];
    if (set.kind !== 'drop') { set.chainId = null; continue; }
    const previous = sets[i - 1];
    if (!previous || previous.kind === 'warmup') { set.kind = 'working'; set.chainId = null; continue; }
    previous.chainId ??= uid(); set.chainId = previous.chainId;
  }
}
export function newPlan(): Plan {
  return { id: uid(), name: 'My training plan', schedule: 'week', cursor: 0, revision: 0, active: false,
    workouts: [{ id: uid(), name: 'Workout A', days: [1, 3, 5], blocks: [] }] };
}

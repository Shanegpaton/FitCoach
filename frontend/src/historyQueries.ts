import type { TrainingDB } from './db';
import { atNoon, localDate, type LoggedSet, type Session } from './domain';
import { completedStats } from './training';

export const journalIndex = '[status+date+completedAt+id]';
export type JournalCursor = [string, string, string, string];
export const journalCursor = (s: Session): JournalCursor => ['completed', s.date, s.completedAt!, s.id];

export function completedInRange(database: TrainingDB, start = '', end = '\uffff') {
  return database.sessions.where(journalIndex)
    .between(['completed', start], ['completed', end, []], true, true);
}

export function journalMatches(session: Session, query: string) {
  return `${session.name} ${session.date} ${session.blocks.map(b => b.name).join(' ')}`.toLowerCase().includes(query);
}

export async function readJournalPage(database: TrainingDB, cursor: JournalCursor | null, query = '', size = 20) {
  const normalized = query.trim().toLowerCase();
  const collection = cursor
    ? database.sessions.where(journalIndex).between(['completed'], cursor, true, false)
    : completedInRange(database);
  const ordered = collection.reverse();
  const rows = await (normalized ? ordered.filter(s => journalMatches(s, normalized)) : ordered).limit(size + 1).toArray();
  return { rows: rows.slice(0, size), hasMore: rows.length > size };
}

export async function countJournal(database: TrainingDB, query: string) {
  const normalized = query.trim().toLowerCase();
  return normalized ? completedInRange(database).filter(s => journalMatches(s, normalized)).count()
    : database.sessions.where('status').equals('completed').count();
}

export interface ExerciseSummary { id: string; name: string; kg: number; reps: number; sets: number }
export async function readHistorySummary(database: TrainingDB) {
  let count = 0, sets = 0;
  const exercises = new Map<string, ExerciseSummary>();
  // Stream records into compact aggregates; never retain the full history in React.
  await completedInRange(database).reverse().each(session => {
    count++; sets += completedStats(session).sets;
    for (const block of session.blocks) {
      if (!block.sets.some(s => s.done)) continue;
      let exercise = exercises.get(block.exerciseId);
      if (!exercise) { exercise = { id: block.exerciseId, name: block.name, kg: 0, reps: 0, sets: 0 }; exercises.set(block.exerciseId, exercise); }
      for (const set of block.sets) if (set.done && set.kind !== 'warmup') {
        exercise.sets++; exercise.kg = Math.max(exercise.kg, set.kg ?? 0); exercise.reps = Math.max(exercise.reps, set.reps ?? 0);
      }
    }
  });
  return { count, sets, exercises: [...exercises.values()] };
}

export function weekBounds(date: string, weeks = 1) {
  const start = atNoon(date); start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const end = new Date(start); end.setDate(end.getDate() + 6);
  start.setDate(start.getDate() - (weeks - 1) * 7);
  return { start: localDate(start), end: localDate(end) };
}

export function recentCompleted(database: TrainingDB, limit: number) {
  return database.sessions.where('[status+completedAt+id]')
    .between(['completed'], ['completed', []])
    .reverse().limit(limit).toArray();
}

export async function readPreviousPerformances(database: TrainingDB, sessionId: string, exerciseIds: string[]) {
  const remaining = new Set(exerciseIds);
  const result: Record<string, LoggedSet[]> = {};
  if (!remaining.size) return result;
  await database.sessions.where('[status+completedAt+id]')
    .between(['completed'], ['completed', []])
    .reverse().until(() => !remaining.size).each(session => {
      if (session.id === sessionId) return;
      for (const block of session.blocks) if (remaining.delete(block.exerciseId)) {
        result[block.exerciseId] = block.sets.filter(s => s.done && s.kind !== 'warmup');
      }
    });
  return result;
}

export async function readMessageWindow(database: TrainingDB, limit: number) {
  const rows = await database.messages.orderBy('[createdAt+id]').reverse().limit(limit + 1).toArray();
  return { messages: rows.slice(0, limit).reverse(), hasOlder: rows.length > limit };
}

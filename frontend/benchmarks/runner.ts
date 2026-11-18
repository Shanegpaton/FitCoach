import { TrainingDB, putLocalChange } from '../src/db';
import { demoBackup } from './fixture';
import { completedInRange, readHistorySummary, readJournalPage } from '../src/historyQueries';
import { localDate } from '../src/domain';

declare global { interface Window { runBenchmark: (size: number) => Promise<unknown> } }
window.runBenchmark = async (size: number) => {
  const database = new TrainingDB(`fitcoach-benchmark-${crypto.randomUUID()}`, 'synthetic-benchmark');
  const fixture = demoBackup(size);
  fixture.sessions.forEach((session, i) => { session.name = `Benchmark session ${i}`; });
  try {
    await database.sessions.bulkPut(fixture.sessions);
    const start = new Date(); start.setDate(start.getDate() - 28);
    const operations = {
      journal: async () => { const page = await readJournalPage(database, null); if (page.rows.length !== 20) throw new Error('Incorrect journal'); },
      search: async () => { const page = await readJournalPage(database, null, 'Benchmark session 0'); if (page.rows.length !== 1) throw new Error('Incorrect search'); },
      chartRange: async () => { const rows = await completedInRange(database, localDate(start)).toArray(); if (rows.length !== 14) throw new Error('Incorrect chart range'); },
      summary: async () => { const result = await readHistorySummary(database); if (result.count !== size || result.sets !== size * 9) throw new Error('Incorrect summary'); },
      localSave: async () => { await putLocalChange('sessions', fixture.sessions[0], database.sessions, database); },
    };
    const measurements: Record<string, { p50Ms: number; p95Ms: number; samples: number; rawMs: number[] }> = {};
    for (const [name, operation] of Object.entries(operations)) {
      await operation(); // Warm up separately; seeding and module loading are excluded.
      const rawMs = [];
      for (let i = 0; i < 20; i++) { const at = performance.now(); await operation(); rawMs.push(performance.now() - at); }
      const ordered = [...rawMs].sort((a, b) => a - b);
      measurements[name] = { p50Ms: ordered[9], p95Ms: ordered[18], samples: rawMs.length, rawMs };
    }
    return { sessionCount: size, measurements };
  } finally { await database.delete(); }
};

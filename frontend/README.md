# FitCoach PWA

Run `npm run dev` in this directory. Validate changes with `npm test`, `npm run build`, and `npm run test:e2e` for user workflows. Production builds require an HTTPS API origin; see the [root README](../README.md) for environment setup. Playwright supplies its own test-only HTTPS service origins and requires Google Chrome and Playwright WebKit.

## Account-scoped reads

IndexedDB remains the immediate local store. Shared app context contains the active `TrainingDB` instance, profile, exercise catalog, plans, schedule overrides, and shared actions. It does not load session or message history. Account-owned views unmount together on account changes.

`src/queries.ts` provides `useDatabaseQuery`: each subscription captures a particular database and tags its result with its dependency scope. Previous results cannot appear under a different account, session ID, date range, or search. `useActiveSessions` reads the existing status index. Queries stop when their consumer unmounts; sample Coach reads are disabled outside Coach unless a sample turn is still running.

`src/historyQueries.ts` contains the remaining read helpers:

- Journal pages use `[status+date+completedAt+id]`, newest first, with exclusive key cursors and a one-record lookahead. IDs resolve timestamp ties. Loaded pages remain reactive; a changed page boundary resets downstream pages rather than retaining stale or duplicated rows.
- Today reads its displayed calendar week and the current statistics week, an indexed completed count, and the latest completed workout. Workout detail reads one primary key. Previous performances scan completed workouts newest first until each requested exercise is found, returning only the relevant logged sets.
- Charts load only their selected date interval. History's all-time counts, set totals, exercise choices, and benchmarks stream completed snapshots into compact aggregates in a separate subscription. They remain independent of journal paging and text input. No extra persisted cache needs reconciliation after imports, corrections, or sync.
- Journal substring search preserves workout, snapshot exercise-name, and date matching. It runs only while the journal is open, after a 200 ms debounce. Matching counts still require a scan; page results retain only the requested matches. This is not a full-text search index.
- Sample Coach loads the newest 100 local messages in stable `[createdAt+id]` order, associated proposals, and five recently completed workouts. **Load older sample messages** widens the explicit window by 100. Older records remain in IndexedDB and backups. Live Coach conversations continue to use the authenticated server flow.

Dexie version 4 adds indexes without rewriting training records or changing sync/outbox contracts. Full reads remain intentional for backup/export and other operations that require complete snapshots. All-time aggregation and rare exercise lookups can still scan a large history, but those reads do not run per search keystroke or active-set edit. Measure those costs before introducing derived stores that would need transactional maintenance across every write path.

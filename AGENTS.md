# FitCoachGPT

FitCoachGPT is an independent fitness training planner and workout tracker. Its main user experience is a phone-first Progressive Web App (PWA) in `frontend/`. The existing Python RAG backend is a separate capability; preserve it while working on the PWA.

## Product behavior

- The primary screens are Today, Plan, Coach, and History. Keep workout entry fast and usable on small touchscreens.
- Workout plans, profile details, conversations, and logs are stored locally in the browser with IndexedDB. There is no account or cross-device synchronization. Keep storage scoped to the current app origin and preserve import/export support.
- Preserve completed sessions as snapshots: later changes to exercise names or plans must not rewrite workout history.
- Users control future targets and weight progression. Use previous results as references; do not invent starting weights, training history, or measurements.
- The Coach currently uses clearly labeled sample responses through the `ChatAdapter` in `frontend/src/coach.ts`. Do not imply that it calls a live model. Keep future model integrations behind this adapter.
- Installable offline behavior depends on HTTPS and the service worker. Rest timers must recover from their stored deadline; background alerts are not guaranteed on mobile browsers.

## Frontend development

- Keep the PWA in `frontend/`, using its existing React, TypeScript, and Vite setup. Use the existing Zod schemas in `src/domain.ts` for persisted data and imported backups.
- Use Dexie storage helpers in `src/db.ts` for writes. Validate a backup before replacing local data, and keep replacement transactional.
- Preserve accessible labels, keyboard navigation, reduced-motion support, safe-area insets, and touch-friendly controls when changing screens or shared styles.
- Run `npm run dev` from `frontend/` for development. Run `npm test` and `npm run build` from `frontend/` after relevant changes; use `npm run test:e2e` for changes that affect user workflows. The browser tests require Google Chrome and Playwright WebKit.
- Update the root README when product behavior or developer setup changes. Phone installation requires a trusted HTTPS origin; do not describe the plain HTTP preview as phone-installable.

There are no active course or school requirements for this project.

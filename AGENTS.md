# FitCoachGPT

FitCoachGPT is an independent fitness training planner and workout tracker. Its main user experience is a phone-first Progressive Web App (PWA) in `frontend/`. The FastAPI/PostgreSQL API provides account-scoped synchronization. The existing Python RAG backend is a separate capability; preserve it while working on the PWA or sync API.

## Product behavior

- The primary screens are Today, Plan, Coach, and History. Keep workout entry fast and usable on small touchscreens.
- IndexedDB is the PWA's immediate local store. Profile, exercises, plans, schedule overrides, and workout sessions save locally first and synchronize with the API in the background. Offline logging must never wait for the network or backend.
- Keep local data scoped to the authenticated account and app origin. Account switching must not expose another account's local records. Preserve existing anonymous data and its explicit account-import workflow, along with backup import/export support. Do not discard unsynchronized data during account changes, origin changes, or migrations.
- Synchronization uses the existing outbox and server versions/ETags. Preserve client-generated IDs and ordering; make retries safe and idempotent. Never silently overwrite a newer server version. Keep recoverable copies when resolving conflicts or destructive operations.
- Workout history is durable. Preserve completed-session snapshots: later changes to exercise names or plans must not rewrite historical session details. If devices create competing active sessions or edits while offline, retain the session and its recorded sets; do not merge sets or silently discard either copy.
- Coach has two modes behind `ChatAdapter`: labeled device-local sample replies in `frontend/src/coach.ts`, and connected online replies through `frontend/src/chatgptVm.ts` and the authenticated API. Live conversations, proposals, model preferences, summaries, and memory are account-owned server records outside workout synchronization. Workout backups contain local training records, sample messages, and locally cached proposals; they do not export canonical live conversations, memory, summaries, or model settings.
- Live Coach uses the bounded LangGraph agent in `backend/agent/`. Keep training tools account-scoped and gate them on synchronized data. Plan creation/edits, completed-workout corrections, workout starts, and active-session edits require reviewable proposals and explicit approval with freshness checks; model tool calls must not directly change training records. Preserve idempotent turn recovery and attempt leases.
- Keep model selection explicit: use the saved account preference or configured exact deployment default, verify account availability, and surface recoverable errors rather than silently switching models. Preserve account-scoped memory controls and original transcripts during context compaction.
- Installable offline behavior depends on HTTPS and the service worker. Rest timers must recover from their stored deadline; background alerts are not guaranteed on mobile browsers.

## Frontend development

- Keep the PWA in `frontend/`, using its existing React, TypeScript, Vite, Zod, and Dexie setup. Use the schemas in `src/domain.ts` for persisted data and imported backups.
- Use Dexie storage helpers in `src/db.ts` for writes. Keep domain changes and their outbox entries consistent and transactional where appropriate. Validate a backup before replacing local data, and keep replacement transactional. Avoid creating extra sync stores or metadata unless needed for crash recovery.
- Coordinate tabs with the Web Locks API and use browser lifecycle events plus reasonable foreground polling for sync. Keep synchronization recoverable after reload, reconnect, or interruption; do not block normal local use while a sync is pending or failing.
- Preserve accessible labels, keyboard navigation, reduced-motion support, safe-area insets, and touch-friendly controls when changing screens or shared styles. Sync status should be visible without interrupting workout entry.
- Run `npm run dev` from `frontend/` for development. Run `npm test` and `npm run build` from `frontend/` after relevant changes; use `npm run test:e2e` for changes that affect user workflows. The browser tests require Google Chrome and Playwright WebKit.

## Backend, database, and deployment

- The API lives in `backend/` and uses FastAPI, SQLAlchemy 2.0, Psycopg 3, and Alembic with Supabase-hosted PostgreSQL. Read `backend/README.md` before changing API setup, migrations, Coach persistence, or deployment. Keep API startup independent of RAG, embeddings, and Ollama.
- ChatGPT connection uses `services/chatgpt_vm/` for exclusive browser sign-in and a server-to-server credential handoff. Read its `README.md` before changing that flow. Keep OpenAI credentials encrypted in the backend, with only connection metadata and short-lived viewer tokens exposed to the PWA. Preserve cleanup after confirmed storage.
- Alembic is the sole application schema migration system. Use migration credentials for schema changes and a separate restricted runtime role for the API. Preserve the private application schema and row-level security protections. Never put database credentials, Supabase service-role keys, or other secrets in frontend code or committed files.
- The API verifies Supabase access tokens and derives ownership from the verified identity. Do not trust an account/user ID supplied in a request body. Keep authenticated database access scoped to the verified account and fail closed when identity context is missing.
- Preserve the existing authenticated CRUD contracts, aggregate transaction boundaries, incremental download cursor, idempotent upload behavior, and ETag/`If-Match` concurrency checks. Return conflicts for explicit resolution rather than overwriting data silently. Keep shared catalog data read-only to normal users.
- For local development, configure ignored local environment files and never commit their values. A localhost API is reachable only from the development machine; cross-device sync requires a reachable HTTPS API. A hosted PWA also needs an HTTPS API URL, correct CORS origins, and matching Supabase OAuth redirect URLs. Do not describe a plain HTTP preview as phone-installable.
- Apply Alembic migrations and run privileged checkpoint setup before deploying Coach API changes that require them; keep privileged credentials outside the deployed runtime. Deployment is currently manual: there is no checked-in GitHub Actions workflow.
- Update the root and affected component READMEs when product behavior, setup, or deployment changes.

There are no active course or school requirements for this project.

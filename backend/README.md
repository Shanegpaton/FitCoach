# Training API

This FastAPI application stores training documents in relational PostgreSQL tables and serves authenticated synchronization for the React PWA. It is separate from the Python RAG CLI. The PWA remains offline-first in account-scoped IndexedDB; the API receives queued mutations and supplies incremental changes without blocking local logging. Connected accounts can request live ChatGPT Coach replies through the API. Live conversations are stored per account in PostgreSQL; offline sample conversations remain device-local. Live plan proposals are stored server-side per account for review and approval across requests; offline sample proposals remain device-local.

## Coach agent

`backend/agent/graph.py` provides a bounded LangGraph loop for a live Coach request: `START -> model -> (tool -> model)* -> END`. `backend/agent/inference.py` handles the ChatGPT Responses API call, and `backend/agent/tools/database.py` defines validated account-scoped read tools and typed plan and workout proposal tools. `propose_training_plan` validates a complete Plan preview; `propose_plan_changes` applies a bounded discriminated union of operations to a copy of an owned plan. Neither tool writes a plan. The authenticated `/v1/chatgpt/coach` endpoint validates one user message and conversation/request IDs with Pydantic; context is assembled from server-owned records. It verifies the account, reads only that account's encrypted credential, refreshes it when needed, and invokes the graph. The access token and verified user ID stay in API closures rather than graph state; the response contains assistant text and, when created, a structured server proposal. `GET /v1/coach/proposals/{id}`, `POST .../reject`, and `POST .../approve` operate on the authenticated account proposal. Approval uses the stored immutable payload, the source plan ETag, `Store.put`, and the normal root version and sync cursor transaction. Repeated approval is idempotent.

The model may call `search_workout_sessions`, `get_workout_sessions`, `get_exercise_history`, `get_training_profile`, `search_training_plans`, `get_training_plans`, `search_exercises`, `propose_training_plan`, `propose_plan_changes`, `propose_workout_changes`, `propose_start_workout`, and `propose_active_workout_changes`. Search tools return compact pages; detail tools return stored snapshots or definitions. Read calls use read-only transactions; proposal calls validate input against account-scoped exercise and plan records and insert only an expiring proposal record, never a plan aggregate. Filters include exact IDs, recorded names, completed/active status, absolute dates, calendar-relative periods, and nearest date windows. For example, a bench press question about one year ago searches a ±45-day window centered on the same local calendar date last year. Exercise history reports recorded sets, best recorded set, and external-load volume in kg; it does not estimate one-rep max. Tool arguments are Pydantic validated and become only parameters in allowlisted SQLAlchemy queries. Each call runs in a read-only transaction using the verified account identity and existing row-level security. Cursors, page sizes, result bytes, and the graph's twelve tool calls and aggregate output bytes are bounded. Proposal payloads expire after 24 hours and are protected by forced RLS. Approval rechecks ownership, expiry, exercise availability, and the stored source ETag; stale proposals are invalidated rather than merged. The agent cannot send SQL or write workout data.

The PWA sends `localDate` and `trainingDataReady` with recent messages. It marks data ready only after account bootstrap and a successful sync with no pending changes or conflicts. Until then, live Coach can answer general questions, but database tools are unavailable and it asks the user to wait for personal training answers. The graph has persistent account-scoped conversation summaries and memory, with no access to the independent `fitcoach/` RAG corpus. Workout changes remain reviewable proposals requiring explicit approval. Plan writes require the explicit proposal approval endpoints. Offline or disconnected PWA Coach still uses labeled sample responses. Install with `pip install -r backend/requirements-dev.txt` and run the API as described below; no separate agent server is needed.

### Context and memory maintenance

Apply Alembic migration `0010` before deploying the context-enabled API. `agent/context.py` resolves model budgets from fresh catalog metadata, a daily process cache, and the exact-ID registry, falling back to 32,000 only for unknown limits. Registry entries cite their official source and verification date; do not infer capacities from similar names. `agent/context_store.py` assembles saved context per model call and runs summary/memory maintenance; raw transcripts are never replaced. `agent/context_routes.py` exposes authenticated controls.

Compaction is triggered at 70% of the usable input budget (window minus output/reasoning and estimation reserves), not by message count. The frontend coordinator triggers bounded maintenance on completion/focus/reconnect and foreground polling. Jobs use 90-second fenced leases, 60-second execution deadlines, and retry backoff up to 15 minutes. Foreground Coach requests can wait for required compaction within their existing 240-second deadline. Tool exchanges are kept paired; completed prefixes can be summarized without reexecuting tools. Oversized mandatory context fails recoverably with the original message saved.

`GET /v1/coach/conversations/{id}/context` exposes summary/status. `POST /v1/coach/maintenance` optionally accepts `conversationId` to check an opened conversation against the selected model's budget, and processes one pending job. `GET /v1/coach/memories` returns settings, memory records, sources, and ETags. `PATCH /v1/coach/memory-settings`, `PATCH/DELETE /v1/coach/memories/{id}`, and `DELETE /v1/coach/memories` require the returned `If-Match` version; missing versions return 428 and stale versions return 412. Ownership always derives from the verified bearer token.

Automatic memory stores only user-supported preferences, constraints, equipment, and self-reported health limitations. Edited/deleted topics are protected from automatic rewrites; clear/settings changes fence pending extraction. Account mutations serialize concurrent jobs, and source timestamps prevent older jobs from replacing newer facts. Storage is capped at 100 active memories; included memory and summary text each have a 2,000-estimated-token budget. No vector database or external worker is required. Original conversations, summaries, and memories are outside the workout synchronization contract and workout backups.

Flags: `FITCOACH_CONTEXT_ENABLED` and `FITCOACH_MEMORY_ENABLED` default to true. The former disables derived context/maintenance entirely; the latter disables automatic extraction while existing memories remain available. `FITCOACH_CONTEXT_FALLBACK_TOKENS` defaults to 32000. Maintenance calls consume connected ChatGPT usage. Interrupted jobs resume when an authenticated app is open again. Logging includes limit sources, estimates, duration, and failure kinds, never prompt or memory contents.

## Configure and run

From the repository root, use Python 3.10 or newer:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements-dev.txt
cp backend/.env.example backend/.env.local
```

Edit `backend/.env.local` and quote values as needed for your shell. URL-encode passwords containing reserved URI characters. This file is ignored by Git. Load it into the shell before running Alembic or Uvicorn:

```bash
set -a
source backend/.env.local
set +a
```

Use the existing Supabase project URL and publishable/anon key for `FITCOACH_SUPABASE_URL` and `FITCOACH_SUPABASE_KEY`. The API verifies **every** bearer token through Supabase Auth's `/auth/v1/user` endpoint before opening a data transaction. No service-role key is required. It derives the PostgreSQL ownership UUID from the verified response. It does not decode an unverified token or use Supabase's REST database API.

Provision the dedicated `fitcoach_api` login using `backend/provision-role.sql` as an administrator, supplying `runtime_password` through psql or your secret manager. Alternatively, execute the equivalent `CREATE ROLE` command in the Supabase SQL editor, substituting the password there. Do not reuse or change Supabase's managed roles. The runtime login must have `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, own no application objects, and have no membership in an owner or privileged role. Alembic supplies its schema usage and table grants. `FITCOACH_RUNTIME_ROLE` defaults to `fitcoach_api`; use the same provisioned role name if you change it.

Set `FITCOACH_MIGRATION_DATABASE_URL` to privileged migration credentials. Set `FITCOACH_DATABASE_URL` to the dedicated runtime credentials. Both must use `postgresql+psycopg://` and TLS (`sslmode=require`, or `verify-full` with the appropriate CA). The API does not read the migration URL. Startup rejects owner/superuser/BYPASSRLS credentials, unsafe memberships, schema creation privileges, writable catalog access, or disabled RLS.

For a persistent server, use Supabase's direct connection from the project's **Connect** panel. On an IPv4-only network, use its **session** pooler connection on port 5432, with the displayed pooler hostname and `fitcoach_api.PROJECT_REF` username. For Vercel Functions, use the **transaction** pooler on port 6543 with the restricted runtime role; the API disables Psycopg's server-side prepared statements on that port. The SQLAlchemy pool defaults to five connections on persistent servers and one per Vercel function instance, with no overflow, health checks, a five-minute connection recycle interval, and a ten-second pool timeout. Configure `FITCOACH_POOL_SIZE` and `FITCOACH_POOL_TIMEOUT` to fit your project limits. Keep the migration URL on a direct or session connection. [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres)

Apply migrations, then run the API:

```bash
alembic -c backend/alembic.ini upgrade head
env -u FITCOACH_MIGRATION_DATABASE_URL uvicorn backend.app:create_app --factory --reload
```

Alembic is the sole migration system. It creates the private `fitcoach` schema, tables, constraints, indexes, catalog seed, metadata triggers, forced RLS policies and runtime grants. It never changes `auth` or Supabase's `public` application tables; its migration-version table is `public.alembic_version`. Run schema downgrades only against a disposable development database: `alembic -c backend/alembic.ini downgrade base` removes **all training API data**.

`GET /health` is a public process-liveness endpoint. Interactive API documentation is at `/docs`. `FITCOACH_CORS_ORIGINS` is an explicit comma-separated list of allowed browser origins. CORS exposes `ETag`, permits `If-Match`, and allows the API's authenticated methods, including PATCH for conversation renames; it defaults to no allowed origins. Set `VITE_FITCOACH_API_URL` in `frontend/.env.development.local` to this API origin for local development.

## Deploy the API on Vercel

Create a **separate Vercel project** for the API from the same repository as the PWA. Set its Root Directory to `backend` and use the FastAPI framework preset. `backend/index.py` exports the API for Vercel; `backend/requirements.txt` installs only the training API runtime dependencies. The function configuration excludes tests, migrations, and local env files from its bundle. No custom build command or output directory is needed. The frontend Vercel project continues to use `frontend` as its Root Directory.

In the API project's Vercel environment settings, set:

| Variable | Value |
| --- | --- |
| `FITCOACH_DATABASE_URL` | Restricted `fitcoach_api` runtime connection through Supabase's transaction pooler on port 6543, using `postgresql+psycopg://` and `sslmode=require`. |
| `FITCOACH_SUPABASE_URL` | Your Supabase project HTTPS URL. |
| `FITCOACH_SUPABASE_KEY` | Your Supabase publishable/anon key, used when checking bearer tokens with Supabase Auth. |
| `FITCOACH_CORS_ORIGINS` | Exact HTTPS origin of the PWA, with no trailing slash. Use a comma-separated list only if more origins are intentionally allowed. |
| `FITCOACH_CHATGPT_VM_ORIGIN` | Exact HTTPS origin of the shared VM for sign-in control and the one-use credential handoff. |
| `FITCOACH_CHATGPT_SECRET` | A 32-byte base64url secret shared only with the VM's `FITCOACH_VM_HANDOFF_KEY`. It also derives the database encryption key. |

Provision the restricted runtime role and run `alembic -c backend/alembic.ini upgrade head` with `FITCOACH_MIGRATION_DATABASE_URL` from a trusted local or CI environment **before** deploying the function. Do not run migrations during a function startup or give Vercel migration credentials. The API checks its runtime role and schema on each cold start and fails closed if they are unsafe or missing.

Set the frontend Vercel project's `VITE_FITCOACH_API_URL` to the API deployment's HTTPS origin, for example `https://api.example.com`, with no `/v1` suffix. Redeploy the frontend after changing this build-time variable. Preview frontend origins need to be added explicitly to `FITCOACH_CORS_ORIGINS` if they should sync. Choose a Vercel Function region close to the Supabase database in the API project settings. Then request `/health` on the API deployment and confirm the frontend's sync status online. The API URL is public; the runtime database URL must remain only in the API project's environment settings.

### Automate production migrations and API deployment

The repository includes `.github/workflows/deploy-backend.yml`. On pushes to `main` that change `backend/**`, it installs backend dependencies, applies `alembic upgrade head`, initializes LangGraph checkpoint tables and grants, and only then calls the backend Vercel deploy hook. It can also be started manually from **GitHub → Actions → Migrate and deploy backend → Run workflow**. Workflow runs are serialized so production migrations cannot overlap.

Configure this once:

1. In the backend Vercel project, create a **Production Deploy Hook** for the production branch and copy its URL.
2. In GitHub repository **Settings → Secrets and variables → Actions**, add secrets named `FITCOACH_MIGRATION_DATABASE_URL` (the migration connection URL) and `VERCEL_BACKEND_DEPLOY_HOOK_URL` (the deploy hook URL). Set the Actions variable `FITCOACH_RUNTIME_ROLE` only if your runtime role differs from `fitcoach_api`.
3. Disable automatic Git production deployments for the **backend Vercel project** so Vercel cannot build backend code before migrations finish. Leave frontend deployments independent. If a migration or checkpoint setup fails, the workflow stops before triggering the backend deployment.

Use a dedicated migration credential, restrict who can edit/run this workflow, and rotate any database password pasted into chat or committed. Do not put the migration URL in Vercel API environment variables: deployed API code uses only the restricted runtime role. The GitHub runner must be able to resolve and connect to the selected Supabase hostname. Review the workflow output after its first run. For manual verification from a trusted environment, run `alembic -c backend/alembic.ini current`.

## API

| Endpoint | Methods |
| --- | --- |
| `/health` | GET, public |
| `/v1/me` | GET, verified user ID |
| `/v1/profile` | GET, PUT |
| `/v1/exercises`, `/v1/plans`, `/v1/sessions`, `/v1/schedule-overrides` | GET list |
| Each resource above plus `/{client_id}` | GET, PUT, DELETE |
| `/v1/catalog`, `/v1/catalog/{client_id}` | Authenticated GET only |
| `/v1/sync/changes?cursor=&limit=` | GET incremental aggregate changes and tombstones |
| `/v1/sync/records/{resource}/{client_id}` | GET one current record after an upload conflict |
| `/v1/sync/mutations` | POST up to 50 independently committed, idempotent aggregate mutations |
| `/v1/chatgpt/connection` | GET metadata, DELETE encrypted credentials; never returns tokens |
| `/v1/chatgpt/vm/connection`, `/v1/chatgpt/vm/attempts`, `/v1/chatgpt/vm/attempts/{id}` | Authenticated VM status, exclusive session start, and sign-in polling |
| `/v1/chatgpt/vm/save` | POST server-side credential handoff; confirms VM cleanup after database commit |
| `/v1/chatgpt/vm/cleanup` | POST clear this account's leftover VM copy only after confirming a stored backend record |
| `/v1/chatgpt/handoff` | POST a one-use VM handoff code; the API redeems it server-to-server and stores encrypted credentials |
| `/v1/chatgpt/coach` | POST recent messages, local date, and sync readiness; returns text and an optional structured proposal, with no token data |
| `/v1/coach/proposals/{id}` | GET a durable account-scoped proposal and current status |
| `/v1/coach/proposals/{id}/approve`, `/reject` | POST explicit approval or rejection; approval validates freshness and uses ordinary plan aggregate/version/sync semantics |

Migration `0003` creates `fitcoach.chatgpt_credentials` with forced row-level security and
owner-scoped runtime grants. The API encrypts the complete verified OpenAI credential record before
writing it to PostgreSQL. The browser receives only account display information and granted-plan
status. The VM and API must share the handoff secret; do not put it in the PWA project or Git.
The API forwards the verified account's bearer token to the VM, which independently verifies it.
The VM admits one account at a time for five minutes. The API confirms cleanup only after the
encrypted record is committed. If confirmation fails, Settings reports pending cleanup and the
VM retains the lease until it can clear the browser before another account enters.
Run Alembic before deploying code that uses these endpoints. Once Settings confirms the backend
copy, the VM can be stopped. When plan usage is granted, Coach calls the API, which serializes refreshes per account, selects an available model from that account's catalog, and consumes a `store: false`, `stream: true` Responses API request through completion. The PWA never receives an OpenAI token. Removing the backend record attempts OpenAI refresh-token revocation directly
from the API even if the VM is off; if revocation cannot be confirmed, Settings tells the user.

Migration `0011` adds nullable profile fields `trainingBackground`, `daysPerWeek` (1–7), `exercisePreferences`, and `limitations`, plus optional workout `durationMinutes` (10–180). Text fields allow 2,000 characters. Apply it before deploying this API. Existing `sessionMinutes` remains a compatibility field and is not used as a workout target. Omitted new fields preserve saved values on older-client writes; explicit null clears availability/duration. Profile text clears with an empty string. Preferred days describe general availability; plan workout days remain the actual schedule.

Bodies match `frontend/src/domain.ts`: camelCase, client IDs, ordered nested arrays, kilograms, nullable measurements, and local calendar dates. Plans include a description of up to 2,000 characters; migration `0005` adds this field with an empty default for existing plans. Unknown fields (including ownership and metadata) are rejected. Repeated nested IDs are valid across parents and sessions, but duplicates inside the same parent are rejected because they cannot identify relational rows. UTC timestamp strings retain the frontend's original precision. Decimal kilogram/RPE columns have no fixed scale; serialization introduces no application-level rounding.

A profile is absent until its first PUT (`GET` returns 404). PUT creates a new root with 201, or replaces an existing aggregate with 200. Individual reads and writes return a strong `ETag` containing the server root version. This is independent of the client's plan `revision`. Lists return `{items, limit, offset}` with default limit 100, maximum 500, and offset 0; limits outside the allowed range return 422. Plan/exercise/override lists use creation order, sessions use descending local workout date, and catalog definitions use ID order. Get an individual resource's ETag before editing an item returned in a list.

Existing PUTs and DELETEs require exactly that ETag in `If-Match`. Missing preconditions return 428; stale or wildcard preconditions return 412. Inaccessible resources return 404. Attempting to create a root using a tombstoned client ID or reinsert an omitted child ID returns 409. Multiple active sessions are permitted so offline sessions started on separate devices can both be retained. An `If-Match` targeting an absent/deleted root returns 404. IDs are never recycled; use new IDs for replacement records. Weekday assignment rows have server-generated identities, so weekdays can be removed and later assigned again.

Sync uploads contain an account-scoped UUID mutation ID, resource, client ID, operation, expected ETag, and (for upserts) the complete aggregate. The server stores the request hash and original result in the same transaction as each successful aggregate write. Replaying the same key and body returns the original result; reusing a key with different content returns 409. Batches commit each aggregate independently, so a child-write failure rolls back that aggregate while earlier successful receipts remain safe to replay. ETag and validation conflicts are returned per mutation without preventing other entries from completing.

The change endpoint uses a per-account monotonic sequence and the latest sequence on each aggregate root. It returns ordered current aggregate documents or tombstones with a high-water cursor; clients commit the data and cursor together in IndexedDB and perform a catch-up pass for concurrent changes. Migration `0002` backfills existing roots for first sync, enables RLS for sync state and mutation receipts, and removes the one-active-session index. Tombstones stay in the feed so other devices can remove deleted records safely.

Authenticated request examples (set `FITCOACH_ACCESS_TOKEN` to a current Supabase access token without placing it in source control):

```bash
curl -H "Authorization: Bearer $FITCOACH_ACCESS_TOKEN" http://localhost:8000/v1/me
curl -H "Authorization: Bearer $FITCOACH_ACCESS_TOKEN" http://localhost:8000/v1/catalog
curl -i -H "Authorization: Bearer $FITCOACH_ACCESS_TOKEN" http://localhost:8000/v1/plans/PLAN_ID
curl -i -X PUT -H "Authorization: Bearer $FITCOACH_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -H 'If-Match: "1"' \
  --data-binary @plan.json http://localhost:8000/v1/plans/PLAN_ID
curl -H "Authorization: Bearer $FITCOACH_ACCESS_TOKEN" \
  'http://localhost:8000/v1/sync/changes?cursor=0&limit=100'
```

Omit `If-Match` only for a new resource. A `plan.json` body is the full existing frontend plan document, not a patch or backup envelope. No endpoints send mail or messages. Invalid/expired tokens return 401; unavailable Auth or database dependencies return 503. Validation errors return 422 and database integrity conflicts return 409. Error responses do not expose database details or tokens.

## Integrity and history

Every owned row carries `user_id`, a server UUID key, a parent-scoped or user-scoped client ID, `created_at`, `updated_at`, positive `version`, and nullable `deleted_at`. Composite foreign keys contain ownership, including optional historical source links. RLS uses a parameterized **transaction-local** `app.user_id` setting with visibility and write checks; missing context denies access. Direct PostgreSQL connections do not inherit Supabase's JWT context. Catalog definitions are shared and read-only. A catalog definition is copied to the user's exercise table when first referenced or edited; custom exercises remain private. [PostgreSQL RLS behavior](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

Mutations use one `AsyncSession.begin()` transaction per aggregate, account-scoped transaction advisory locking and root row locking. Plan activation deactivates the previous active plan in the same transaction; a partial unique index also enforces one live active plan. Reads assemble documents within a consistent read-only snapshot. Reconciliation preserves retained row keys, updates fields, stages reordering to satisfy live position uniqueness, and tombstones omitted children. Triggers maintain timestamps and advance every modified row's version, including root versions when nested data changes. Database constraints enforce scalar ranges and completed-set/session rules; request validation checks aggregate rules before persistence.

Deleting plans tombstones descendants and overrides. Removing a planned workout also tombstones its overrides. Deleting sessions tombstones logged descendants. Deleting source exercises/plans never rewrites logged names, load modes, prescribed targets, actual results, notes, or original source IDs. Imported history is accepted even when source plans or custom exercises do not exist. Explicit session edits remain available through PUT and If-Match. Editing a current plan that references a deleted exercise requires replacing that reference with an available exercise.

Physical cascades exist only within aggregates. Historical source links are deferred, non-cascading foreign keys: a referenced template or exercise cannot be physically purged while history links remain. Runtime credentials have no physical DELETE/TRUNCATE grants. Soft-deleted identities remain reserved. No automatic purge or restore endpoint is included.

## Verification

Unit tests need no database:

```bash
python -m pytest -c backend/pytest.ini backend/tests/test_domain.py
```

Integration tests use real PostgreSQL and the restricted role. They verify Alembic upgrade/downgrade/upgrade, exact nested round trips, ownership and foreign keys, missing RLS context, connection-pool identity clearing, catalog copies, historical snapshots, omitted-child tombstones, transaction rollback after a child constraint failure, concurrent plan activation, multiple independently active sessions, idempotent sync retries, incremental cursors, partial batches, and stale versions. Supabase Auth HTTP responses are mocked; obtaining real Google access tokens and a hosted connection remains an environment smoke test.

To run locally, create a disposable PostgreSQL database and provision its runtime role. For example:

```bash
docker run --name fitcoach-postgres-test -e POSTGRES_PASSWORD=fitcoach-test-only \
  -e POSTGRES_DB=fitcoach_test -p 127.0.0.1:55432:5432 -d postgres:17
docker exec fitcoach-postgres-test psql -U postgres -d fitcoach_test \
  -c "CREATE ROLE fitcoach_api LOGIN PASSWORD 'fitcoach-runtime-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"
export FITCOACH_TEST_ADMIN_URL='postgresql+psycopg://postgres:fitcoach-test-only@127.0.0.1:55432/fitcoach_test'
export FITCOACH_TEST_DATABASE_URL='postgresql+psycopg://fitcoach_api:fitcoach-runtime-test-only@127.0.0.1:55432/fitcoach_test'
export FITCOACH_TEST_ALLOW_RESET=YES
python -m pytest -c backend/pytest.ini
docker rm -f fitcoach-postgres-test
```

The reset acknowledgment is required because the suite downgrades and recreates the **entire fitcoach schema**. Use the same environment variables to run against a **disposable Supabase development database**, with TLS-enabled URLs and the provisioned runtime role. Never target a database containing training API data you want to keep. Without test URLs, integration tests are skipped. `FITCOACH_ALLOW_LOCAL_PLAINTEXT=true` allows only localhost addresses to omit TLS; hosted connections always require TLS.

Migration `0004` creates `fitcoach.coach_proposals`, a narrowly scoped account-owned table with forced RLS, status and expiry fields, an immutable structured payload, and runtime SELECT/INSERT/UPDATE grants. Apply it with Alembic before deploying proposal-capable API code. The PWA stores a local display cache only; the backend is authoritative for approval state. The browser requires online connectivity, completed bootstrap, no pending outbox records, and no sync conflicts before offering approval. The API still independently validates the proposal owner, plan ETag, expiry, and referenced exercises.

Migration `0006` adds account-owned Coach conversation, ordered message, and idempotent turn tables with forced RLS. Apply it with Alembic. Install the `langgraph-checkpoint-postgres` dependency and run `python -m backend.setup_checkpointer` once per database with `FITCOACH_MIGRATION_DATABASE_URL` and `FITCOACH_RUNTIME_ROLE` set. This controlled setup creates LangGraph's internal checkpoint tables in `public`, revokes access from Supabase's `anon`, `authenticated`, and `service_role` roles, enables RLS, and grants row access only to the restricted API role. It also enables RLS and removes API grants from `public.alembic_version`, which is used only by the privileged migration connection. Both setup and API connections select `public` explicitly because Supabase roles may use a custom PostgreSQL `search_path`. Re-run checkpoint setup on existing databases to apply these grants and policies. Do not run checkpoint setup from request handlers. The API opens one short-lived async psycopg connection per graph request, which avoids retaining a pool across serverless invocations. Conversation IDs resolve to server-owned thread IDs; the browser never supplies or receives checkpoint thread IDs. Messages are the user-visible history and include JSON metadata with stable artifact references; checkpoints are internal graph state.

The Coach conversation endpoints under `/v1/coach/conversations` support account-scoped creation, listing, retrieval with bounded message pagination, rename, and deletion. `/v1/chatgpt/coach` accepts only one new user message plus a conversation ID and request ID. The server loads the latest 24 persisted messages; it never combines a browser transcript with checkpoint history. Request IDs make completed retries return the persisted answer, and started turns reject duplicate invocations. A known failed turn can be retried with the same request ID and text.

Migration `0007` adds an attempt UUID, lease deadline, attempt start time, and a partial unique index allowing one started turn per conversation. Each attempt renews a 90-second lease every 20 seconds and has a four-minute execution limit. Status reads, sends, and deletion recover expired turns transactionally without removing messages. Retries preserve the logical request ID and user message while acquiring a new attempt UUID. Reply writes and proposal inserts check ownership and lease validity under the account mutation lock; cleanup also matches the attempt UUID. LangGraph uses a separate server-owned checkpoint thread per attempt, and conversation deletion removes its thread prefix. The frontend times out generation requests after 250 seconds, preserves uncertain requests, and checks status every five seconds while visible plus on reload, focus, and reconnect. It loads completed responses without generating again and enables retry only after a known failure or expiry. Before applying `0007`, drain old API workers; the migration releases legacy started turns, and old code lacks attempt fencing. No queue or scheduled cleanup service is required. Deleting a conversation cascades its history and removes its checkpoint thread.
Migration `0005` adds the persisted plan description field used by Coach proposals and the plan editor. Existing plans receive an empty description. The plan domain has no effort/RPE target field, so proposal tools do not invent or persist effort targets.

### Completed workout correction proposals

Migration `0008` extends the existing RLS-protected Coach proposal table with `session_modify` and a target session ID. `propose_workout_changes` accepts a complete Session snapshot after the model reads it using `get_workout_sessions`. It validates recorded set invariants, keeps the session ID and completed status, and stores both the original and proposed snapshots without writing history. The ordinary authenticated proposal read/reject/approve endpoints handle both plan and workout proposals. Approval checks the source ETag under the account mutation lock and writes through `Store.put('sessions', ...)`, advancing the normal sync cursor atomically. Repeated approvals are idempotent. Stale, deleted, expired, or rejected proposals cannot overwrite history. Before snapshots stay available after acceptance or rejection; a downgrade refuses to remove workout proposal metadata while such proposals exist. The completed-workout tool retains its completed-status restriction.

Migration `0009` adds `session_create` proposals. `propose_start_workout` takes an owned plan ID and workout ID and derives the full session on the server using current exercise snapshots and the client local date. Actual reps, load, effort, and completion flags start empty. Creation approval checks the source plan ETag, refuses to start while another server session is active, and uses create-only session writes under the same account lock. Retries return the same created session. `propose_active_workout_changes` uses the existing session edit proposal contract but requires active source and target status and preserves plan/workout linkage, start/completion timestamps, and the timer. Both tools require explicit user acceptance; neither completes sessions or advances plan rotation. ETag conflicts preserve the proposal's before snapshot. Starting or editing through Coach is online-only; ordinary local workout logging is unchanged.

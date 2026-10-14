# Training API

This FastAPI application stores training documents in relational PostgreSQL tables and serves authenticated synchronization for the React PWA. It is separate from the Python RAG CLI. The PWA remains offline-first in account-scoped IndexedDB; the API receives queued mutations and supplies incremental changes without blocking local logging. Conversations/proposals and live Coach integration remain local/deferred.

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

`GET /health` is a public process-liveness endpoint. Interactive API documentation is at `/docs`. `FITCOACH_CORS_ORIGINS` is an explicit comma-separated list of allowed browser origins. CORS exposes `ETag`, permits `If-Match`, and allows authenticated sync POST requests; it defaults to no allowed origins. Set `VITE_FITCOACH_API_URL` in `frontend/.env.local` to this API origin.

## Deploy the API on Vercel

Create a **separate Vercel project** for the API from the same repository as the PWA. Set its Root Directory to `backend` and use the FastAPI framework preset. `backend/index.py` exports the API for Vercel; `backend/requirements.txt` installs only the training API runtime dependencies. The function configuration excludes tests, migrations, and local env files from its bundle. No custom build command or output directory is needed. The frontend Vercel project continues to use `frontend` as its Root Directory.

In the API project's Vercel environment settings, set:

| Variable | Value |
| --- | --- |
| `FITCOACH_DATABASE_URL` | Restricted `fitcoach_api` runtime connection through Supabase's transaction pooler on port 6543, using `postgresql+psycopg://` and `sslmode=require`. |
| `FITCOACH_SUPABASE_URL` | Your Supabase project HTTPS URL. |
| `FITCOACH_SUPABASE_KEY` | Your Supabase publishable/anon key, used when checking bearer tokens with Supabase Auth. |
| `FITCOACH_CORS_ORIGINS` | Exact HTTPS origin of the PWA, with no trailing slash. Use a comma-separated list only if more origins are intentionally allowed. |

Provision the restricted runtime role and run `alembic -c backend/alembic.ini upgrade head` with `FITCOACH_MIGRATION_DATABASE_URL` from a trusted local or CI environment **before** deploying the function. Do not run migrations during a function startup or give Vercel migration credentials. The API checks its runtime role and schema on each cold start and fails closed if they are unsafe or missing.

Set the frontend Vercel project's `VITE_FITCOACH_API_URL` to the API deployment's HTTPS origin, for example `https://api.example.com`, with no `/v1` suffix. Redeploy the frontend after changing this build-time variable. Preview frontend origins need to be added explicitly to `FITCOACH_CORS_ORIGINS` if they should sync. Choose a Vercel Function region close to the Supabase database in the API project settings. Then request `/health` on the API deployment and confirm the frontend's sync status online. The API URL is public; the runtime database URL must remain only in the API project's environment settings.

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

Bodies match `frontend/src/domain.ts`: camelCase, client IDs, ordered nested arrays, kilograms, nullable measurements, and local calendar dates. Unknown fields (including ownership and metadata) are rejected. Repeated nested IDs are valid across parents and sessions, but duplicates inside the same parent are rejected because they cannot identify relational rows. UTC timestamp strings retain the frontend's original precision. Decimal kilogram/RPE columns have no fixed scale; serialization introduces no application-level rounding.

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

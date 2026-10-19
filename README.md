# FitCoachGPT

## ChatGPT connection experiment

Settings contains an experimental [ChatGPT VM connection](prototype/chatgpt_vm/README.md) for one FitCoach account. The PWA verifies its Supabase sign-in with the VM, opens a protected VM browser, and shows the verified ChatGPT account and whether plan usage was granted. After sign-in, a one-use server-to-server handoff stores encrypted credentials in the account-scoped Supabase PostgreSQL backend, so the VM can be stopped. The PWA receives only connection status. With granted plan usage, Coach sends online requests through the authenticated API; the API refreshes tokens and calls the Responses API. Offline or disconnected Coach uses labeled sample responses. OpenAI eligibility for FitCoachGPT-operated VMs needs confirmation before broader release.

FitCoachGPT is a phone-first workout planner and tracker. Build a routine, log your sets, and see your progress in a dark, installable Progressive Web App (PWA).

The app stores plans, goals, workout history, and conversations on your device. Google sign-in uses Supabase Auth; each account has a separate local workout database. After an account signs in on a device, the workout tracker remains available offline.

## Run the PWA

Use Node.js 20.9 or newer (Node 22 recommended) and npm 10.9 or newer:

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. For production-build and offline testing, set `VITE_FITCOACH_API_URL` to the deployed API's HTTPS origin before building:

```bash
VITE_FITCOACH_API_URL=https://YOUR_API_HOST npm run build
npm run preview
```

### Supabase Google sign-in

Set your Supabase project URL and publishable (anon) key in `frontend/.env.local`, and put the local API URL from `frontend/.env.example` in `frontend/.env.development.local`. These are public frontend values; never put a Supabase service-role key in the PWA. Vite loads a plain `.env` during production builds too, so keep localhost settings in `.env.development.local`.

In Supabase, enable Google under **Authentication → Providers** and add the Google OAuth client ID and secret. In Google Cloud, set the authorized redirect URI to the callback URL shown by Supabase for your project (`https://<project-ref>.supabase.co/auth/v1/callback`). In Supabase **Authentication → URL Configuration**, set **Site URL** to the production PWA origin (for example, `https://your-app.vercel.app`) and add the exact production callback (`https://your-app.vercel.app/auth/callback`) to **Redirect URLs**. Keep `http://localhost:5173/auth/callback` there as an additional redirect only if you still use local development. The PWA supplies its current origin in `redirectTo`, so preview deployments also need their callback URLs allowed if Google sign-in should work on them.

Deploy the Vercel frontend with `frontend/` as its project root. Its `vercel.json` rewrites direct requests for `/auth/callback` and other PWA routes to `index.html`, so Google OAuth can return to a freshly opened browser route instead of a Vercel 404.

The PWA uses the PKCE flow and persists the Supabase session in browser storage. A returning account can open its local plans and log workouts offline even when its token cannot be refreshed. Signing out clears the active auth session but keeps that account’s local database gated from other accounts. Existing anonymous `fitcoach-v1` data is offered for explicit import into an account; the source database remains intact. The import dialog shows progress and errors, closes after a successful local import, and leaves account synchronization running in the background.

Local changes are recorded in a per-account IndexedDB outbox and uploaded to the authenticated FastAPI training API when connectivity is available. The PWA downloads incremental account changes, uses server ETags to surface conflicts, and keeps recovery copies before deletes or conflict resolution. Workouts continue saving locally while offline. Existing anonymous data still requires explicit import; cloud-only data is preserved during first sync and backup import.

When the same record changes on two devices, Settings keeps both versions available for review. Choose **Use cloud**, **Use this device**, or **Edit and merge** to construct the final record manually. Replaced versions remain available as downloadable recovery copies. Device and manual choices keep the original record ID and wait in the outbox until the server accepts their ETag-checked upload; another server change creates a new conflict. A cloud deletion cannot be restored under its tombstoned ID, so its local copy is kept in recovery. Settings shows unresolved conflicts, failed uploads, and whether recent resolutions are pending upload or synchronized.

Set `VITE_FITCOACH_API_URL` in `frontend/.env.development.local` to the local training API origin (`http://localhost:8000`). In the Vercel frontend project's Production and Preview environment settings, set it to the deployed API's HTTPS origin (without `/v1`), then redeploy. Production builds now fail when this URL is missing, uses HTTP, or includes a path. Supabase access tokens authenticate sync requests. The API must allow the PWA origin in `FITCOACH_CORS_ORIGINS`; see [the API guide](backend/README.md). After deployment, check the browser's network requests for the HTTPS API origin and confirm the sync status. Existing pending changes remain in the local outbox and retry after the corrected build loads.

Open `http://localhost:4173` once online, then test offline. Service-worker caching is enabled in the production build, not the development server. Keep using the same origin: development, preview, and different hostnames have separate browser databases.

### What you can do

- Skip or complete a brief training profile, then edit it in Settings.
- Create, duplicate, reorder, and edit routines with weekday or rotating schedules.
- Create custom exercises and prescribe sets, reps, optional weights, and rest periods.
- Log actual weights, reps, optional RPE, warm-ups, supersets, drop sets, and notes.
- Resume an unfinished session after closing the app; rest timers retain their deadlines.
- Review session history, exercise benchmarks, weekly sets, workout frequency, and external-load volume.
- Export and import versioned JSON backups. Invalid imports leave existing data intact.

Today, Plan, Coach, and History are the four primary tabs. Weight progression is user-controlled; previous results are shown as references. Starting weights are never invented, and personal history starts empty. For dumbbells, use combined external load consistently; bodyweight volume counts only added load.

### Coach in this milestone

Coach uses ChatGPT for freeform conversation when the signed-in account has granted ChatGPT plan usage and the API is reachable. Replies are labeled ChatGPT and saved only on that device. Without the grant or while offline, Coach uses labeled sample responses and editable sample plan proposals. Review and apply a proposal to save it; proposals do not change your plan automatically. Live replies do not create or edit plans. The typed `ChatAdapter` in `frontend/src/coach.ts` keeps the two modes separate.

The PWA does not currently call Ollama or the Python backend. That existing backend and its scientific corpus remain available separately below.

### Install and test on a phone

A phone must first load the production build from a trusted HTTPS origin. A computer's plain HTTP LAN address does not enable service workers. [Service-worker secure contexts](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)

For local HTTPS testing, install [mkcert](https://github.com/FiloSottile/mkcert), then run these commands from `frontend/`, replacing the example IP with your computer's LAN IP:

```bash
mkcert -install
mkdir -p .certs
FITCOACH_LAN_IP=192.168.1.100
mkcert -cert-file .certs/local.pem -key-file .certs/local-key.pem localhost 127.0.0.1 "$FITCOACH_LAN_IP"
VITE_FITCOACH_API_URL=https://YOUR_API_HOST npm run build
FITCOACH_TLS_CERT=.certs/local.pem FITCOACH_TLS_KEY=.certs/local-key.pem npm run preview
```

Install and trust **only** mkcert's public `rootCA.pem` certificate on the test phone, following its mobile-device instructions; never share `rootCA-key.pem`. On the same Wi-Fi, open `https://YOUR_LAN_IP:4173`, then add the app to the home screen using Safari's Share menu on iOS or Chrome's Install app menu on Android. Open it once, allow caching to finish, and relaunch in airplane mode. Future static HTTPS hosting can serve `frontend/dist/`; it needs an `index.html` fallback for application routes.

Phone testing initially uses your computer to serve the files. Once cached, plans, logging, and history operate independently. Browser data can be cleared or evicted, so keep exported backups. Google sign-in requires connectivity; accounts already signed in on that device can continue using their local data offline.

Rest timers recalculate correctly after returning to the app. Sound and vibration depend on browser support and user interaction; locked-screen alarms are not guaranteed. [Background timer behavior](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)

### Frontend verification

```bash
cd frontend
npm test
VITE_FITCOACH_API_URL=https://YOUR_API_HOST npm run build
npx playwright install webkit
VITE_FITCOACH_API_URL=https://YOUR_API_HOST npm run test:e2e
```

Browser tests use installed Google Chrome for desktop and Android-sized emulation, plus Playwright WebKit for iPhone-sized emulation. They cover onboarding, offline logging and reload recovery, proposals, supersets, timers, custom exercises, real history, and backups. Physical iOS/Android installation and device alert behavior should also be checked before release.

### ChatGPT connection prototype

Settings can pair one FitCoach account to the Oracle VM and display its Firefox
sign-in browser inside the PWA. The user completes OpenAI sign-in and permission
review in that view. On phones, tap the OpenAI field in the remote view, then
use the keyboard relay below it to type and send Enter, Tab, or Backspace. The
relay clears its input after each keystroke; the OAuth callback completes on the VM. A one-use
handoff moves verified credentials to the encrypted backend store. The PWA receives only
connection status and a short-lived viewer token. Coach still uses
sample responses and makes no model requests. Set `VITE_CHATGPT_VM_URL` to the
VM's HTTPS origin in the frontend deployment. See
[the VM prototype guide](prototype/chatgpt_vm/README.md) for service setup and
release gates.

## Relational training API

The independent `backend/` application uses FastAPI, SQLAlchemy 2, Psycopg 3 and Alembic with Supabase PostgreSQL. It verifies Supabase Auth bearer tokens and provides profiles, owned exercises, a shared exercise catalog, nested plans and session snapshots, and schedule overrides. A private schema, forced row-level security, ownership foreign keys, transactional writes, soft deletion and ETag preconditions protect account data and workout history.

Install its dependencies separately from the RAG requirements:

```bash
pip install -r backend/requirements-dev.txt
```

Follow [the API setup and verification guide](backend/README.md) to provision a restricted runtime role, configure separate runtime/migration connection URLs, apply Alembic migrations, start Uvicorn, and make authenticated requests. Hosted PostgreSQL connections require TLS; use Supabase's direct connection or its session pooler for IPv4 environments. The guide also describes disposable PostgreSQL and Supabase development migration tests.

The API starts without loading embeddings or Ollama. The API can deploy as a Vercel Python Function with `backend/` as its project root; see [the Vercel deployment steps](backend/README.md#deploy-the-api-on-vercel). Conversations, proposals, live Coach integration, and automatic anonymous-data import remain deferred. Backend availability does not gate local workout entry. Multiple active sessions are allowed in the cloud so simultaneous offline workouts from different devices cannot reject one another's recorded sets.

## Python RAG Backend

The independent Python backend answers fitness questions using scientific papers about training, nutrition, supplements, and recovery. It provides a command-line interface and a reusable service using local Ollama models. Its Retrieval-Augmented Generation (RAG) pipeline keeps chunks, embeddings, and retrieval indexes in memory.

## Pipeline

```text
PDF papers
  -> page-by-page text extraction
  -> sentence-aware chunks
  -> dense embeddings + BM25 index
  -> hybrid retrieval with Reciprocal Rank Fusion
  -> retrieved context added to the prompt
  -> grounded Ollama answer with citations
```

## Features

- Loads 10 PDF papers with `pypdf`
- Preserves source URLs and PDF page numbers
- Creates sentence-aware chunks targeting 300 MPNet tokens
- Uses approximately 25 tokens of overlap
- Embeds chunks with `sentence-transformers/all-mpnet-base-v2`
- Stores normalized 768-dimensional vectors in memory
- Supports dense, BM25, and hybrid retrieval
- Combines dense and BM25 rankings with Reciprocal Rank Fusion
- Generates cited answers with local `llama3.2` through Ollama
- Abstains when the retrieved evidence does not support an answer
- Includes optional retrieval and answer-quality evaluation

## Runtime Prerequisites

- Python 3.10 or newer
- [Ollama](https://ollama.com/)
- The `llama3.2` Ollama model

## Setup

Create and activate a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Download and start the Ollama model:

```bash
ollama pull llama3.2
ollama serve
```

The embedding model is downloaded automatically the first time the application runs.

## Ask a Question

Hybrid retrieval is the default:

```bash
python fit_coach_gpt.py \
  --query "Does creatine improve high-intensity exercise performance?"
```

Choose a retrieval strategy or change the number of returned chunks:

```bash
python fit_coach_gpt.py \
  --retrieval bm25 \
  --top-k 5 \
  --query "How much protein should an exercising person consume?"
```

Valid retrieval modes are `dense`, `bm25`, and `hybrid`.

## Corpus and Chunking

PDFs are stored in `data/documents/`. Source metadata is stored in `data/manifest.csv` and matched by exact PDF filename.

Each PDF is extracted page by page. The chunker uses the MPNet tokenizer to create chunks of up to 300 model tokens with approximately 25 tokens of sentence-level overlap. Each chunk retains its document ID, title, source URL, year, topics, and page range.

The current corpus produces 972 chunks. Their normalized `float32` embedding matrix has shape `(972, 768)` and uses approximately 2.85 MB of memory.

## Retrieval

Dense retrieval embeds the question with MPNet and computes cosine similarity using a dot product against the normalized chunk embeddings.

BM25 retrieval performs keyword-based sparse search. Hybrid retrieval obtains candidates from both methods and combines their ranks using Reciprocal Rank Fusion:

```text
RRF score = sum(1 / (60 + rank))
```

This combination helps with both semantic questions and exact fitness terminology.

## Grounded Generation

The five highest-ranked chunks are labeled `[S1]` through `[S5]` and injected into the Ollama prompt. The model is instructed to answer only from this evidence and cite supported claims.

Answers without a valid retrieved-source citation are replaced with:

```text
I do not have enough evidence in the provided sources.
```

FitCoachGPT provides educational fitness information and is not a medical diagnosis or treatment system.

## Optional Evaluation

The backend includes an optional evaluation command using the labeled questions in `data/eval_dataset.json`:

```bash
python fit_coach_gpt.py --evaluate --top-k 5
```

It reports retrieval and answer-quality scores, using Ollama to judge answers, and saves detailed results to `data/evaluation_results.json`.

## Project Structure

```text
frontend/                    React + TypeScript offline PWA
  src/pages/                 Today, Plan, Workout, Coach, History, Settings
  src/domain.ts              Shared types and validation schemas
  src/db.ts                  Local IndexedDB storage and backups
  src/training.ts            Scheduling, workout flow, and progress calculations
  src/coach.ts               Replaceable chat interface and sample adapter
  e2e/                       Browser workflow tests
backend/                     Independent FastAPI relational training API
  app.py                     Authenticated HTTP endpoints and ETags
  index.py                   Vercel FastAPI entry point
  requirements.txt           API function dependencies
  vercel.json                API function bundle configuration
  domain.py                  Frontend-compatible request/response validation
  schema.py                  SQLAlchemy relational tables and constraints
  store.py                   Transactional aggregate writes and document assembly
  migrations/                Alembic schema, RLS, metadata triggers and catalog seed
  tests/                     Unit and restricted-role PostgreSQL integration tests
fit_coach_gpt.py             Backward-compatible CLI entry point
fitcoach/
  cli.py                     Command-line argument handling
  config.py                  Paths and model defaults
  models.py                  Shared document and retrieval data models
  ingestion.py               PDF loading and sentence-aware chunking
  retrieval.py               Dense, BM25, and hybrid retrieval
  generation.py              Grounded prompting and Ollama generation
  evaluation.py              Retrieval and generation evaluation
  reporting.py               Human-readable CLI output
  service.py                 Reusable API for a future UI or agent
requirements.txt             Independent Python RAG dependencies
data/documents/              PDF corpus
data/manifest.csv            Source metadata
data/eval_dataset.json       Evaluation questions and relevance labels
data/evaluation_results.json Detailed evaluation output
```

The existing CLI commands are unchanged. Application code can initialize the
pipeline once and reuse it across requests:

```python
from fitcoach import FitCoachService

coach = FitCoachService().initialize()
result = coach.answer("How much protein should I eat?")
print(result.text)
```

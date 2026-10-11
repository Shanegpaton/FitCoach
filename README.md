# FitCoachGPT

FitCoachGPT is a phone-first workout planner and tracker. Build a routine, log your sets, and see your progress in a dark, installable Progressive Web App (PWA).

The app stores plans, goals, workout history, and conversations on your device. Google sign-in uses Supabase Auth; each account has a separate local workout database. After an account signs in on a device, the workout tracker remains available offline.

## Run the PWA

Use Node.js 20.9 or newer (Node 22 recommended) and npm 10.9 or newer:

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. For production-build and offline testing:

```bash
npm run build
npm run preview
```

### Supabase Google sign-in

Create `frontend/.env.local` from `frontend/.env.example` and set your Supabase project URL and publishable (anon) key. These are public frontend values; never put a Supabase service-role key in the PWA.

In Supabase, enable Google under **Authentication → Providers** and add the Google OAuth client ID and secret. In Google Cloud, set the authorized redirect URI to the callback URL shown by Supabase for your project (`https://<project-ref>.supabase.co/auth/v1/callback`). In Supabase URL configuration, allow the app origin plus `/auth/callback` as a redirect URL (for local development, `http://localhost:5173/auth/callback`; add the trusted HTTPS production origin before release).

The PWA uses the PKCE flow and persists the Supabase session in browser storage. A returning account can open its local plans and log workouts offline even when its token cannot be refreshed. Signing out clears the active auth session but keeps that account’s local database gated from other accounts. Existing anonymous `fitcoach-v1` data is offered for explicit import into an account; the source database remains intact.

Local changes are recorded in a per-account IndexedDB outbox. The repository does not yet contain a FastAPI HTTP application or authenticated synchronization endpoint, so the outbox is groundwork and is not uploaded or drained. Cross-device sync requires that backend and its JWT verification and sync API.

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

Coach is a clearly labeled UI demo with sample conversations and editable plan proposals. Review and apply a proposal to save it; proposals do not change your plan automatically. Freeform conversation and live AI are deferred. The typed `ChatAdapter` in `frontend/src/coach.ts` provides the integration point for a future local-model or hosted provider.

The PWA does not currently call Ollama or the Python backend. That existing backend and its scientific corpus remain available separately below.

### Install and test on a phone

A phone must first load the production build from a trusted HTTPS origin. A computer's plain HTTP LAN address does not enable service workers. [Service-worker secure contexts](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)

For local HTTPS testing, install [mkcert](https://github.com/FiloSottile/mkcert), then run these commands from `frontend/`, replacing the example IP with your computer's LAN IP:

```bash
mkcert -install
mkdir -p .certs
FITCOACH_LAN_IP=192.168.1.100
mkcert -cert-file .certs/local.pem -key-file .certs/local-key.pem localhost 127.0.0.1 "$FITCOACH_LAN_IP"
npm run build
FITCOACH_TLS_CERT=.certs/local.pem FITCOACH_TLS_KEY=.certs/local-key.pem npm run preview
```

Install and trust **only** mkcert's public `rootCA.pem` certificate on the test phone, following its mobile-device instructions; never share `rootCA-key.pem`. On the same Wi-Fi, open `https://YOUR_LAN_IP:4173`, then add the app to the home screen using Safari's Share menu on iOS or Chrome's Install app menu on Android. Open it once, allow caching to finish, and relaunch in airplane mode. Future static HTTPS hosting can serve `frontend/dist/`; it needs an `index.html` fallback for application routes.

Phone testing initially uses your computer to serve the files. Once cached, plans, logging, and history operate independently. Browser data can be cleared or evicted, so keep exported backups. Google sign-in requires connectivity; accounts already signed in on that device can continue using their local data offline.

Rest timers recalculate correctly after returning to the app. Sound and vibration depend on browser support and user interaction; locked-screen alarms are not guaranteed. [Background timer behavior](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)

### Frontend verification

```bash
cd frontend
npm test
npm run build
npx playwright install webkit
npm run test:e2e
```

Browser tests use installed Google Chrome for desktop and Android-sized emulation, plus Playwright WebKit for iPhone-sized emulation. They cover onboarding, offline logging and reload recovery, proposals, supersets, timers, custom exercises, real history, and backups. Physical iOS/Android installation and device alert behavior should also be checked before release.

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
requirements.txt             Python dependencies
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

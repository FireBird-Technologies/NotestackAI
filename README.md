# Notestack

Your archive, in orbit. Turn a Substack (or any feed) into a grounded research notebook, audio
overviews, videos and launch kits, all traced back to what the writer actually wrote.

- Design doc: [docs/DESIGN.md](docs/DESIGN.md)
- Foundations task list: [docs/PHASE0.md](docs/PHASE0.md)

## Layout

```
backend/    FastAPI + SQLAlchemy + Alembic, Postgres job queue worker, DSPy (LLM agnostic, Z.ai first)
frontend/   React + Vite + TS: night sky landing, pricing, blog, auth, Mission Control
renderer/   Remotion compositions + render service that uploads to R2 via presigned PUT
docs/       Design doc and task lists
```

## Run locally

```bash
cp .env.example .env            # fill LLM_API_KEY (Z.ai), GOOGLE_CLIENT_ID, RESEND_API_KEY
docker compose up --build
```

- App: http://localhost:5173, API: http://localhost:8000/docs, MinIO console: http://localhost:9001
- Local storage is MinIO standing in for R2. Presigned URLs point at `http://minio:9000`, so add
  `127.0.0.1 minio` to your hosts file for browser uploads to work locally.
- With `EMAIL_PROVIDER=console`, verification codes print in the `api` logs.

Without Docker (one API process does everything):

```bash
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt
alembic upgrade head && uvicorn app.main:app --reload     # SQLite at backend/notestack.db
cd frontend && npm install && npm run dev
cd renderer && npm install && npm start                    # only needed for videos, quote cards, carousels
```

- With `ENV=development` the API runs the job worker in process (`RUN_WORKER_IN_API`), so syncing,
  topic mapping, audio and launch kits work without a second terminal. In production run
  `python -m app.worker` separately and set `RUN_WORKER_IN_API=false`.
- With no R2 settings, files live on local disk under `backend/.storage` and are served through
  signed `/api/storage/local/...` URLs (range requests supported for audio and video seeking).
- Audio needs `ELEVENLABS_API_KEY`; everything text based needs `LLM_API_KEY`.
- Launchpad: Bluesky connects with an app password. X and LinkedIn need developer apps; the
  redirect URIs are listed in `.env.example` and on the Launchpad page. Substack Notes has no API,
  so those posts (and any post without a connected account) arrive as an email reminder at send time.

## What is in the app

| Menu | Does |
| --- | --- |
| Mission Control | Pre-flight checklist, jobs in flight, sources, notebooks, recent launches, upcoming posts |
| Notebooks | Group posts, chat with cited answers (history kept), summaries, audio overviews, videos, quote cards |
| Sources | Connect feeds (Substack archive included), import one URL, upload md/txt/html/pdf, read posts by line |
| Topic map | LLM tagged topics per post, merged into a constellation; make a notebook from any topic |
| Voice profile | Writing voice built from your posts (editable), host voices, consented voice cloning |
| Video and audio | Audio overviews, 9:16 shorts, 16:9 explainers, 1:1 audiograms, quote cards |
| Launch Kit | Hooks, X thread, LinkedIn, Substack Notes, Bluesky, SEO pack, carousel, quote cards, all editable |
| Launchpad | Calendar and agenda, auto posting to X, LinkedIn and Bluesky, email reminders, tracked links, engagement |
| Archive | Every generated artifact with filters, players, downloads, retry and delete |
| Resurfacing | Evergreen scores and reshare angles for old posts, on this day, straight into a kit or the calendar |
| Settings | Profile, workspace, brand kit, privacy, plan usage meters, connections, sign out everywhere, delete |

## Key choices

| Concern | Where |
| --- | --- |
| Cloudflare R2 storage (keys, presign, uploads) | `backend/app/services/storage.py`, `backend/app/routers/storage.py` |
| Resend email + unsubscribe + campaigns | `backend/app/services/email.py`, `backend/app/worker.py` |
| Google + email code auth, JWT revocation | `backend/app/auth.py`, `backend/app/routers/auth.py` |
| Research over posts as files (no embeddings) | `backend/app/corpus.py`, `backend/app/pipeline/research.py` |
| LLM provider (swap by env) | `backend/app/llm/provider.py`, `.env` `LLM_*` |
| Three plans, billing off | `backend/app/services/plans.py`, `BILLING_ENABLED` |
| Blog posts | `frontend/src/content/blogPosts.ts` (`/blogs`, `/blogs/:slug`) |
| Logo | replace `frontend/public/logo.svg` (white tile, black silhouettes) |
| Sky background | `frontend/src/components/SkyCanvas.tsx` |

## Switching LLM providers

```bash
# Z.ai (default). Cheaper: glm-5.3-flash. Free for dev: glm-4.7-flash
LLM_MODEL=openai/glm-5.3  LLM_API_BASE=https://api.z.ai/api/paas/v4  LLM_REASONING_EFFORT=low
# Anthropic
LLM_MODEL=anthropic/claude-sonnet-5  LLM_API_BASE=
# OpenAI
LLM_MODEL=openai/gpt-5  LLM_API_BASE=
```

## Rules

- No em dashes in any UI, email or generated copy. `npm run check:copy` and
  `app/llm/postprocess.py` enforce it.
- Palette is black, `#217cff` and white only.

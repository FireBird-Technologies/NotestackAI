# Notestack

Your archive, in orbit. Turn a Substack (or any feed) into a grounded research notebook, audio
overviews, videos and launch kits, all traced back to what the writer actually wrote.

- Design doc: [docs/DESIGN.md](docs/DESIGN.md)
- Phase 0 task list: [docs/PHASE0.md](docs/PHASE0.md)

## Layout

```
backend/    FastAPI + SQLAlchemy + Alembic, arq worker, DSPy (LLM agnostic, Z.ai first)
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

Without Docker:

```bash
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt
alembic upgrade head && uvicorn app.main:app --reload     # needs Postgres + Redis
arq app.worker.WorkerSettings                              # second terminal
cd frontend && npm install && npm run dev
cd renderer && npm install && npm start                    # or: npm run studio
```

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

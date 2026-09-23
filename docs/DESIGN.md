# Notestack: Design Doc

Status: draft v0.1 (2026-09-22)
Owner: Firebird Technologies

> Note: Section 0 of the product brief was not included in the handoff. This doc reconstructs the
> product framing from Sections 5 to 12 plus the kickoff decisions. Replace Section 1 with the
> original Section 0 text when available.

## 1. Product

Notestack turns a writer's archive (Substack, Ghost, Medium, any RSS feed or URL) into a grounded
research notebook and a launch engine. Writers can:

- Ask questions of their own archive and get answers with citations to their posts.
- Generate a two-host audio overview of a post or notebook (ElevenLabs).
- Generate videos (explainer 16:9, vertical short 9:16, audiogram 1:1) rendered with Remotion.
- Generate a Launch Kit per post: threads, LinkedIn, Substack Notes, Bluesky, hooks, SEO pack,
  quote cards, carousels, all in the writer's own voice.
- Schedule everything on the Launchpad calendar and resurface evergreen posts.

Every factual statement Notestack generates must trace back to the writer's own sources.

## 2. Kickoff decisions

| Area | Decision |
| --- | --- |
| Backend | FastAPI + SQLAlchemy 2 + Alembic (same stack as blog2video) |
| Worker | Postgres backed queue: the `jobs` table, claimed with `FOR UPDATE SKIP LOCKED`; progress on the row, streamed as SSE. No Redis. |
| Database | Postgres 16 (no vector extension) |
| Frontend | React + Vite + TypeScript, plain CSS with design tokens |
| Renderer | Node service running Remotion (`renderer/`) |
| Storage | Cloudflare R2 (S3 API) for raw HTML, audio, video, stills, compiled DSPy programs |
| Email | Resend, behind a provider interface (mirrors blog2video `EmailService`) |
| Auth | Google sign-in + email 6-digit code signup + password login, JWT access/refresh with `token_version` revocation (mirrors blog2video) |
| LLM | Provider agnostic through DSPy + LiteLLM. Default Z.ai GLM-5.3 (fast tier GLM-5.3-Flash) via its OpenAI compatible endpoint. Retrieval is agentic search over a file system corpus, not embeddings (see 3.2). Any LiteLLM model string works by env var. |
| Billing | Three tiers defined in code (`app/services/plans.py`). `BILLING_ENABLED=false` for now: everyone gets the top tier limits free, checkout returns 409, pricing page shows "Free during early access". |
| Blog | Typed `blogPosts.ts` content array, `/blogs` and `/blogs/:slug`, same shape as blog2video |

## 3. Architecture

```
            +-------------------+        SSE / REST        +--------------------+
 browser -->|  frontend (Vite)  |------------------------->|  api (FastAPI)     |
            +-------------------+                          |  auth, notebooks,  |
                     ^                                     |  billing, storage  |
                     | presigned GET                       +---------+----------+
                     |                                               | insert queued job
            +--------+----------+                          +---------v----------+
            | Cloudflare R2     |<-------------------------|  worker            |
            | notestack-assets  |   put objects            |  ingest, corpus,   |
            +--------+----------+                          |  DSPy, TTS         |
                     ^                                     +---------+----------+
                     | upload final render                           | POST /render
            +--------+----------+   progress callbacks     +---------v----------+
            | renderer (Remotion)|------------------------>|  api /internal/... |
            +-------------------+                          +--------------------+
     Postgres: data + job queue (api, worker)
```

### 3.1 Storage pipeline (R2)

All binary and large text payloads live in R2. Postgres stores only keys and metadata.

Key layout (`app/services/storage.py::keys`):

```
ws/{workspace_id}/sources/{source_id}/documents/{document_id}/raw.html
ws/{workspace_id}/corpus/manifest.json                           path -> sha256 of every corpus file
ws/{workspace_id}/corpus/INDEX.md                                one line per post
ws/{workspace_id}/corpus/sources/{site}/{date}-{slug}.md         clean post as markdown
ws/{workspace_id}/uploads/{upload_id}/{filename}
ws/{workspace_id}/artifacts/{artifact_id}/{variant}.{ext}      audio, video, stills
ws/{workspace_id}/tts-cache/{sha256(script|voice|settings)}.mp3
system/dspy/{module}/{version}.json                              compiled programs
```

Flows:

1. **Server writes** (ingestion, TTS, compiled programs): worker calls `storage.put_bytes()`.
2. **Browser uploads** (logos, voice consent samples): `POST /api/storage/uploads` returns a presigned
   PUT URL and an `upload_id`; the browser PUTs directly to R2; `POST /api/storage/uploads/{id}/complete`
   verifies with a HEAD request and records size and content type.
3. **Renderer writes**: renderer receives a presigned PUT URL in the render request, so it never holds
   R2 credentials.
4. **Reads**: `GET /api/storage/objects/{key}` checks workspace ownership and 302 redirects to a
   presigned GET (default 1 hour). Public stills (quote cards) can later move to a public bucket with
   a custom domain.

The storage service is an S3 client with R2's endpoint, so MinIO in docker-compose stands in for R2
locally with zero code changes.

### 3.2 Research corpus: file system instead of embeddings

Each post is one markdown file (front matter, `# Title`, `## Section` headings) and the workspace
has an `INDEX.md` with one line per post. Research is an agent loop (`dspy.ReAct`,
`app/pipeline/research.py`) with three tools scoped to the notebook's files (`app/corpus.py`):

| Tool | Does |
| --- | --- |
| `list_files(contains)` | Index lines for the notebook's posts: date, path, title, headings |
| `search(pattern, path)` | Case insensitive regex grep, returns `path:line: text` |
| `read(path, start_line, end_line)` | Numbered lines, 160 per call |

The model searches with several phrasings, reads around the hits, and answers with citations of
the form `(path, line_start, line_end)`. Before anything reaches the writer, every citation is read
back from the file: citations that point outside the notebook, past the end of a file or at empty
lines are dropped, markers are renumbered, and an answer left with no verified citation is replaced
by "not in your posts". The UI streams each step ("Searching for pricing|paid tier", "Reading On
pricing, lines 1 to 40").

Why this over embeddings:
- One vendor. Z.ai's international API has no embedding model, and there is no second key,
  re-embedding job or dimension lock-in.
- Citations are exact line ranges the model actually read, which is stronger grounding than
  nearest-neighbour chunks.
- Writers' archives are small (hundreds to a few thousand posts, a few MB of text), so grep over
  local files takes milliseconds.
- The corpus is plain markdown, so the same files feed podcast scripts, launch kits and a future
  MCP server without conversion.

Trade offs: each question costs several LLM steps instead of one (mitigated by
`LLM_REASONING_EFFORT=low` and the `RESEARCH_MAX_STEPS` cap), and paraphrase matching depends on
the model trying synonyms. If quality or latency needs it later, a Postgres full text index can be
added as a fourth tool without changing the corpus.

Storage and sync: R2 holds the corpus under `ws/{id}/corpus/` with a `manifest.json` of file hashes.
The worker writes files to R2 and its own cache in one pass. The API calls `Corpus.sync()` before
each research run, which reads the manifest and downloads only changed files into
`CORPUS_CACHE_DIR`. Containers share nothing but R2.

Brief items that assumed embeddings: voice similarity uses the LLM judge alone; the topic map is
built from LLM extracted entities per post (Phase 2); resurfacing and SEO internal links search the
corpus with the same tools.

### 3.3 LLM layer

`app/llm/provider.py` builds a `dspy.LM` from env:

```
LLM_MODEL=openai/glm-5.3               # any LiteLLM model string
LLM_FAST_MODEL=openai/glm-5.3-flash    # judges, cleanup, cheap passes
LLM_API_BASE=https://api.z.ai/api/paas/v4
LLM_API_KEY=...
LLM_REASONING_EFFORT=low               # low | high | max
```

Z.ai considerations baked in:
- OpenAI compatible chat endpoint, so the `openai/` LiteLLM prefix plus `api_base` works.
- GLM-5.x always reasons (thinking cannot be disabled). Every call sends `thinking: enabled` with
  `reasoning_effort=low` by default; modules that benefit (the groundedness judge) ask for
  `main_lm("high")`. Reasoning tokens count against `max_tokens`, so the default is 16K to leave
  room for the structured answer. Z.ai recommends temperature 1.0 for GLM-5.x.
- 1M token context on GLM-5.3 means whole-notebook prompts (summaries, podcast scripts) can read
  the files directly; chat uses the research agent to keep citations tight and cost low.
- Tool calling runs through DSPy ReAct, so it works with any provider, not only ones with native
  function calling.
- Token usage from every call is written to `usage_events` (metering from day one).

Swapping to Anthropic, OpenAI, Gemini or a local model is only an env change.

### 3.4 Jobs and progress (Postgres, no Redis)

The `jobs` table is the queue, the progress record and the SSE source.

- **Enqueue:** the API inserts a `queued` row (`create_job`). Nothing else.
- **Claim:** `python -m app.worker` polls every `WORKER_POLL_SECONDS` and takes the oldest runnable
  row with `SELECT ... FOR UPDATE SKIP LOCKED`, so any number of workers can share the table without
  double running a job. Up to `WORKER_CONCURRENCY` jobs run at once in threads.
- **Retry:** a handler that raises is requeued with backoff (30s, 60s, 120s... capped at 15 min)
  until `max_attempts` (default 3), then marked `failed`.
- **Heartbeat:** every progress update stamps `heartbeat_at`. A `running` job silent for
  `JOB_STALE_SECONDS` (worker crashed, renderer died) is requeued by the stale sweeper.
- **Hand off:** render jobs return `HANDED_OFF`; the renderer's progress callbacks keep the row
  alive and mark it done.
- **Progress to the browser:** `GET /api/jobs/{id}/events` re-reads the row about once a second and
  sends only changes. Latency is at most a second, which is fine for progress bars.
- **Schedules:** the worker runs the stale sweep (1 min), update email batch (5 min, gated to the
  campaign send hour) and daily cleanup. Each takes a Postgres advisory lock, so with several
  workers only one runs a given task.

No request blocks for more than a few seconds. Add Redis back only if job volume makes polling a
measurable load on Postgres; the handler code would not change.

## 4. Data model

Implemented in `backend/app/models` and `alembic/versions/0001_initial.py`.

- users, workspaces, workspace_members, subscriptions
- email_verification_codes, update_emails, update_email_sends
- sources, documents (with corpus `path`), notebooks, notebook_documents
- voice_profiles, voice_consents
- chats, messages, citations (document, path, line range, verified quote)
- artifacts, jobs (covers render_jobs and tts_jobs via `kind`), uploads
- calendar_items, tracked_links, engagement_events
- dspy_traces, usage_events

## 5. DSPy program design

See brief Section 6. Signatures live in `backend/app/llm/signatures.py` with Pydantic output models.
Phase 1 ships CleanAndSegment, ResearchArchive (the file research agent) and BuildVoiceProfile. All grounded outputs cite `SourceRef(path, line_start, line_end)`. The rest are stubs with typed
signatures so the schema contract is fixed early.

## 6. Plans

| | Free | Writer | Studio |
| --- | --- | --- | --- |
| Price (when billing turns on) | $0 | $19/mo | $49/mo |
| Sources | 1 | 3 | 10 |
| Indexed posts | 50 | 500 | 5,000 |
| Audio overview minutes / mo | 10 | 60 | 240 |
| Video render minutes / mo | 3 | 30 | 120 |
| Launch Kits / mo | 5 | 50 | unlimited |
| Voice profile | yes | yes | yes |
| Voice cloning (with consent) | no | yes | yes |
| Brand kit, no watermark | no | yes | yes |

While `BILLING_ENABLED=false`, every workspace resolves to Studio limits.

## 7. Design system

Strict palette: `#000000`, `#217cff`, `#FFFFFF` and opacity variants only. Tokens in
`frontend/src/styles/tokens.css`. Landing page is a night sky: canvas starfield with slow parallax,
small twinkling sparkles, a soft blue nebula haze and a neon horizon line. `prefers-reduced-motion`
renders a static sky. Logo slot (`<Logo />`) is a white tile that holds the black silhouette mark;
drop the final file at `frontend/public/logo.svg`.

Copy rule: no em dashes anywhere in UI, email or generated output. The generation layer strips them
as a last pass (`app/llm/postprocess.py`).

## 8. Security and privacy

- JWT access (72h) + refresh, revocation by bumping `users.token_version`.
- One auth provider per account for life (Google or email), same as blog2video.
- Verification codes hashed, 10 minute TTL, 5 attempts, 60s resend cooldown.
- R2 keys are always workspace scoped; the API checks ownership before presigning.
- No training on user content without opt-in (`workspaces.training_opt_in`, default false).
- Voice cloning requires a stored consent record with the recorded sample key.

# Phase 0: Foundations task list

Legend: [x] done in this scaffold, [ ] open

## Repo and infra
- [x] Monorepo layout: `backend/`, `frontend/`, `renderer/`, `docs/`
- [x] docker-compose: api, worker, postgres, redis, minio (local R2 stand-in), renderer, frontend
- [x] `.env.example` covering every service
- [x] CI: backend lint + tests, frontend typecheck + build, renderer typecheck
- [ ] Production deploy target (Fly, Render or DO App Platform) and R2 bucket + custom domain
- [ ] Sentry (api, worker, frontend)

## Backend core
- [x] Settings (`app/config.py`), DB session, Alembic initial migration
- [x] Full data model from design doc Section 4
- [x] Health endpoint, CORS, request id logging
- [x] Jobs table + arq worker + Redis progress pub/sub + SSE endpoint
- [x] Usage metering table and helper (`record_usage`)

## Auth (mirrors blog2video)
- [x] JWT access/refresh with token_version revocation
- [x] Google sign-in (ID token verify)
- [x] Email signup with 6 digit code, password login, forgot password
- [x] `/me`, logout (revoke), delete account (soft delete)
- [x] Workspace auto-created on first login
- [ ] MCP OAuth 2.1 bridge (Phase 4)

## Email (Resend)
- [x] `EmailService` over `ResendEmailProvider`, console provider for local dev
- [x] Templates: verification code, password reset, welcome, job finished, job failed alert
- [x] Signed unsubscribe link + `/api/unsubscribe`
- [x] Update email campaign tables + hourly batch sender loop

## Storage (Cloudflare R2)
- [x] S3 client against R2 endpoint, key helpers, put/get/delete/head
- [x] Presigned upload flow (start, direct PUT, complete) and presigned read redirect
- [x] TTS cache key helper
- [ ] Lifecycle rule on R2 for `tmp/` prefix (set in Cloudflare dashboard)

## LLM (agnostic, Z.ai first)
- [x] `dspy.LM` factory from env, Z.ai defaults
- [x] File system corpus in R2 with manifest sync (`app/corpus.py`)
- [x] Research agent: list/search/read tools, verified line citations, live step streaming
- [x] Signatures + Pydantic outputs for CleanAndSegment, ResearchArchive, BuildVoiceProfile, stubs for the rest
- [x] Em dash stripping post-processor
- [ ] Dev sets and first optimization run (Phase 1)

## Billing
- [x] Three tiers defined in code, `BILLING_ENABLED` flag, `/api/billing/plans`, `/api/billing/me`
- [ ] Stripe checkout + webhook when billing turns on

## Frontend
- [x] Design tokens (black, #217cff, white only), fonts
- [x] Night sky starfield with twinkling sparkles, reduced motion fallback
- [x] Custom SVG icon set (single stroke weight)
- [x] Logo slot (white tile, black silhouette placeholder)
- [x] Landing page with "Paste your Substack URL" CTA
- [x] Pricing section and `/pricing`
- [x] Blog: `/blogs`, `/blogs/:slug`, typed `blogPosts.ts`
- [x] Auth page: Google button + email code flow + password login
- [x] App shell: Mission Control, sidebar with themed icons and plain labels
- [ ] Real product demo video on landing (replace placeholder)

## Renderer
- [x] Remotion project with shared props schema (zod), ShortVertical and QuoteCard compositions
- [x] `POST /render` service that renders and uploads to a presigned R2 URL, progress callbacks
- [ ] ExplainerLong and AudiogramSquare compositions (Phase 2)

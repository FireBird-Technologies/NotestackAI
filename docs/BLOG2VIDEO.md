# blog2video integration

Videos are made and edited by blog2video. Notestack is an ordinary blog2video API customer: we own one paid
blog2video account (Pro, topped up with per-video credits) and the backend calls its public `/api/v1` API with that
account's key. Every video is charged to our account; we charge our workspaces from our own allowance.

```
Browser ──► /api/videos/* (backend/app/routers/videos.py) ──(Bearer b2v_live_…)──► blog2video /api/v1
                 ├─ checks the session and workspace
                 ├─ reserves / refunds the workspace's allowance (subscriptions)
                 └─ records which video belongs to which workspace (b2v_videos)
```

The browser never talks to blog2video, and the key never reaches the browser or the logs.

## Settings

Backend `.env` only (never a `VITE_` variable):

| Env var | Value |
|---|---|
| `B2V_API_BASE_URL` | blog2video API host, no trailing slash (`B2V_API_URL` is still read as a fallback) |
| `B2V_API_KEY` | `b2v_live_…`, from blog2video → Account → API keys on our Pro account |
| `B2V_TIMEOUT_SECONDS` | create timeout (default 30); every other call uses 10s |
| `B2V_CAPACITY_ALERT_BELOW` | log an `ALERT` when our account has fewer videos left (default 20) |

A revoked or rotated key answers 401; a blog2video account that dropped to Free answers 403 to everything. Both
log an `ALERT` line and users see "temporarily unavailable".

## Ownership

Everything made with the key (videos, custom templates, styles) belongs to one blog2video account,
and blog2video's ownership checks stop at the account. Notestack is the only place each workspace's things are kept
apart (`backend/app/services/b2v_access.py`):

| Table | What | Used as |
|---|---|---|
| `b2v_videos` | videos (also the allowance ledger) | project id; `created_via` v1 or upload |
| `b2v_templates` | custom templates (`ready` once generated) | `template: "custom_<id>"` |
| `b2v_custom_voices` | designed and cloned voices | `custom_voice_id: "<voice_id>"` |
| `user_saved_voices` | "My voices" (kept only here) | the wizard's voice list |
| `b2v_styles` | custom video styles | `video_style: "custom:<id>"` |
| `usage_counters` | per-workspace counters (below) | |

Every route that takes one of these ids checks it is the workspace's (404 otherwise), and every create or edit body
has its `template`, `video_style` and `custom_voice_id` checked before it is forwarded. Lists come from these tables.
Account-wide endpoints (`POST /api/projects`, `/api/projects/bulk`, `GET /api/projects`, `/api/voices/saved*`,
built-in style overrides, style pin/selection, "Your Style", script preferences) are refused in
`blog2video.DENIED` before anything is sent.

## Routes

| Notestack | blog2video |
|---|---|
| `POST /api/videos` (link, text, a post) | `POST /api/v1/videos` with `Idempotency-Key: <workspace>:<uuid>` |
| `POST /api/videos/upload` (≤5 files) | `POST /api/projects/upload` then `/generate` |
| `POST /api/videos/batch` (≤10 links) | one `POST /api/v1/videos` per link |
| `GET /api/videos/{id}/status` | `/api/v1/videos/{id}/status`, or `/api/projects/{id}/status` for uploads |
| `/api/videos/{id}/script*` | `/api/projects/{id}/script-review/*` |
| `/api/videos/{id}/p/<path>` | `/api/projects/{id}/<path>`, allowlisted in `routers/video_edit.py` |
| `/api/video-voices/*` | `/api/voices/design-from-*`, `/api/voices/custom*`, `/api/voices/clone`, `/api/voice/preview` |
| `/api/video-templates/*` | `/api/custom-templates/*` (editor paths allowlisted) |
| `/api/video-styles/*` | `/api/video-styles/ai-draft`, `/api/video-styles/custom*` |

The live preview link comes from `POST /api/embed/token/{id}` and is safe for the browser.

## Per-workspace limits

blog2video checks every limit against our Pro account, so every workspace passes its checks. Notestack divides them:
each plan row has `video_limits`. There are no premium (★) video options: videos use the standard lengths (short,
medium), the built-in templates and styles, and the free built-in voices. Notestack does not proxy AI chat editing,
avatars, AI script or scene rewrites, AI template editing, designer templates, paid or custom voices, voice tuning,
voice design or cloning for videos, or the source download.

| Metric | Period | Free / Writer / Studio | Counts |
|---|---|---|---|
| `ai_edits` | month | 20 / 300 / 1000 | scene regenerate/add, AI image, stock clip |
| `templates` | lifetime | 0 / 2 / 5 | custom templates made (blog2video slots are never given back) |
| `template_ai_daily` | day | 0 / 3 / 5 | theme from a document or prompt, code generation |

Edit a plan row to change them. A counter is given back when blog2video refuses the call. A template switch also
uses a video.

## Quota

One row per workspace in `subscriptions`, enforced only by us (`backend/app/services/video_quota.py`):

| Column | Meaning |
|---|---|
| `video_plan` | effective plan id (`free`, `writer`, `studio`) |
| `video_limit` | videos per period, from the plan |
| `videos_used` | videos made this period |
| `videos_period_start` | start of the current period |

- **Reserve** before calling blog2video: `videos_used + 1` only while below `video_limit`, in one `UPDATE`. At the
  limit we answer 402 `plan_limit` and blog2video is never called.
- **Refund exactly once** (conditional `UPDATE b2v_videos SET quota_state = 'refunded' WHERE quota_state = 'charged'`)
  when the create is refused (402, 422, key/plan problems), gets no answer after 3 tries with the same
  `Idempotency-Key`, or generation fails (status `failed`/`error`, or 404).
- The worker's `video_refund_sweep` (every 10 min) checks charged, unfinished videos older than 30 minutes, for users
  who closed the tab. `video_capacity_check` (hourly) reads `GET /api/v1/me` and alerts when we run low.
- Resets: Stripe `invoice.paid` with `billing_reason` `subscription_cycle` or `subscription_create`; otherwise the
  hourly `video_period_reset` resets any period older than a month (free, billing disabled, annual plans).

A 402 `quota_exceeded` from blog2video means **our** account is out of videos, not the user: they are refunded and
see "temporarily unavailable"; buy credits. Our users' limits added up can exceed the account, so watch the alert.

## Videos made before the switch

Videos made through the old partner integration belonged to a blog2video service account that is now deactivated;
the key gets 404 for them. They have no `b2v_videos` row, so the API treats them as legacy: `GET` returns the stored
`video_url`/`preview_url` with `legacy: true`, and edits answer 410. blog2video can move them to our account on
request if we ever need them editable.

## Clean-up after the switch

The partner-token code and settings (`B2V_PARTNER_SLUG`, `B2V_PARTNER_SECRET`) are gone. blog2video used to connect
to our database, so drop that access:

```sql
REVOKE ALL ON public.subscriptions FROM b2v_partner;
DROP VIEW IF EXISTS b2v_quota;
DROP ROLE IF EXISTS b2v_partner;
```

and remove blog2video's server IP from the database firewall.

## Local development

Set `B2V_API_BASE_URL` and a test key. Unit tests (`backend/tests/test_videos.py`) use a fake blog2video.

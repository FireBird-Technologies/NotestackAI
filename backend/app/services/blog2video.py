"""blog2video: turns a post into an editable, narrated video. Every call goes through here.

NoteStack is an ordinary blog2video API customer: each request carries our account's key
(Authorization: Bearer b2v_live_...), and everything made with it (videos, custom templates, custom voices, video
styles) belongs to that one account. blog2video does not know our workspaces and its ownership checks stop at the
account, so callers must check ownership first (app/services/b2v_access.py) and charge the workspace's own
allowances (app/services/video_quota.py, app/services/video_limits.py).

Some endpoints change state shared by every workspace, or hand one workspace another's data. They are refused here,
before anything is sent (DENIED). The key never reaches the browser or the logs.
"""

import logging
import re
import threading
import time
from collections.abc import Callable
from typing import Any

import httpx

from app.config import settings

log = logging.getLogger(__name__)

STATUS_TIMEOUT = 30  # every call without its own timeout (status polls, edits): blog2video can take well over 10s
UPLOAD_TIMEOUT = 120
CREATE_ATTEMPTS = 3  # a create is retried with the same Idempotency-Key, which never makes a duplicate
CATALOG_TTL = 3600

# Account-wide endpoints NoteStack must never call (the integration guide, section 11).
DENIED: list[tuple[str, re.Pattern]] = [
    (m, re.compile(p)) for m, p in [
        ("POST", r"^/api/projects/?$"),  # same URL within 10 minutes returns another workspace's project
        ("POST", r"^/api/projects/bulk/?$"),
        ("GET", r"^/api/projects/?$"),  # every project on the account
        ("GET", r"^/api/projects/template-availability/?$"),
        ("*", r"^/api/voices/saved(/.*)?$"),  # one saved-voice list shared by everyone
        ("*", r"^/api/video-styles/builtin/.*$"),  # changes a built-in style for everyone
        ("*", r"^/api/video-styles/pin/?$"),
        ("*", r"^/api/video-styles/selection/?$"),
        ("*", r"^/api/video-styles/your-style/?$"),
        ("*", r"^/api/auth/me/script-preferences/?$"),
    ]
]


class B2VError(RuntimeError):
    def __init__(self, message: str, status: int = 502, detail: Any = None):
        super().__init__(message)
        self.status = status
        self.detail = detail


class AccountOutOfVideos(B2VError):
    """Our blog2video account has no videos (or template slots) left. Not the user's fault; ops must buy more."""


class NotFound(B2VError):
    pass


class Busy(B2VError):
    """Another change is still running (409), or an account rate limit was hit (429)."""


class TemplateInUse(B2VError):
    """409 template_in_use: a video on the account still uses this custom template."""


class BadRequest(B2VError):
    pass


class Upstream(B2VError):
    """blog2video is down or slow, or rejected our key or plan (a configuration problem, not the user's)."""


class Unreachable(Upstream):
    """No answer at all (network error or timeout): a create may or may not have happened."""


class Denied(B2VError):
    """We refused to send this: the endpoint is account-wide (see DENIED)."""


UNAVAILABLE = "Video creation is temporarily unavailable. Try again later."
NOT_RESPONDING = "The video service is being updated. Please try again in a while."


def configured() -> bool:
    return bool(settings.b2v_api_base_url and settings.b2v_api_key)


def _base() -> str:
    return settings.b2v_api_base_url.rstrip("/")


def denied(method: str, path: str) -> bool:
    path = path.split("?", 1)[0]
    return any(m in ("*", method.upper()) and p.match(path) for m, p in DENIED)


def _body(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return resp.text[:500]


def _error_code(body: Any) -> str | None:
    """blog2video errors look like {"detail": {"error": "..."}} or {"detail": "..."}."""
    if not isinstance(body, dict):
        return None
    detail = body.get("detail", body)
    if isinstance(detail, dict):
        return detail.get("error")
    return detail if isinstance(detail, str) else None


def _message(detail: Any, fallback: str) -> str:
    if isinstance(detail, str) and detail.strip():
        return detail.strip()[:300]
    if isinstance(detail, dict) and isinstance(detail.get("message"), str):
        return detail["message"][:300]
    if isinstance(detail, list):  # 422s list the fields: [{"loc": [..., "url"], "msg": "..."}]
        parts = [f"{(d.get('loc') or ['?'])[-1]}: {d.get('msg')}" for d in detail if isinstance(d, dict)]
        if parts:
            return "; ".join(parts)[:300]
    return fallback


def _raise_for(resp: httpx.Response, path: str) -> None:
    if resp.status_code < 400:
        return
    body = _body(resp)
    detail = body.get("detail", body) if isinstance(body, dict) else body
    code = _error_code(body) or ""
    status = resp.status_code
    text = str(detail).lower()
    if status == 402 or (status == 403 and "video limit reached" in text):
        log.error("ALERT blog2video: our account is out of videos (%s): buy credits", path)
        raise AccountOutOfVideos(UNAVAILABLE, 503, detail)
    if status == 403 and code == "custom_template_limit":
        log.error("ALERT blog2video: our account is out of custom template slots (%s): buy slots", path)
        raise AccountOutOfVideos("Creating templates is temporarily unavailable. Try again later.", 503, detail)
    if status == 401:
        log.error("ALERT blog2video rejected our API key on %s (missing, revoked or rotated): update B2V_API_KEY",
                  path)
        raise Upstream(UNAVAILABLE, 503, detail)
    if status == 403:
        log.error("ALERT blog2video refused %s with 403 (%s): is the account still on a paid plan?", path,
                  code or text[:120])
        raise Upstream(UNAVAILABLE, 503, detail)
    if 400 <= status < 500 and status not in (401, 403):
        # What blog2video said, so a refused edit can be traced (never includes our key).
        log.warning("blog2video %s -> %s: %s", path, status, str(detail)[:300])
    if status == 404:
        raise NotFound(_message(detail, "Not found"), 404, detail)
    if status == 409 and code == "template_in_use":
        raise TemplateInUse("A video still uses this template.", 409, detail)
    if status == 409 or (status == 400 and "running" in text):
        raise Busy(_message(detail, "Another change is still running, try again in a moment."), 409, detail)
    if status == 429:
        raise Busy(_message(detail, "The daily limit was reached. Try again later."), 429, detail)
    if status in (400, 413, 415, 422):
        raise BadRequest(_message(detail, str(code or "blog2video rejected the request")), 400, detail)
    raise Upstream(NOT_RESPONDING, 502, detail)


def _retry_after(resp: httpx.Response) -> float:
    try:
        return min(float(resp.headers.get("Retry-After", 1)), 5)
    except ValueError:
        return 1


def request(method: str, path: str, *, json: Any = None, params: dict | None = None, data: dict | None = None,
            files: Any = None, headers: dict | None = None, timeout: float | None = None,
            raw: bool = False) -> Any:
    """Call blog2video with our key. JSON by default; `data` + `files` send multipart; `raw` returns
    (bytes, content_type) for audio and downloads. A POST with an Idempotency-Key (a create) is retried on no
    answer, 5xx and 429, always with the same key: blog2video returns the original video, charged once."""
    if denied(method, path):
        log.error("refused to call account-wide blog2video endpoint %s %s", method, path)
        raise Denied("Not available.", 404)
    if not configured():
        raise Upstream("Video is not set up yet.", 503)
    url = f"{_base()}{path}"
    timeout = timeout or STATUS_TIMEOUT
    retryable = method == "POST" and bool(headers and headers.get("Idempotency-Key"))
    attempts = CREATE_ATTEMPTS if retryable else 1
    for attempt in range(1, attempts + 1):
        last = attempt == attempts
        started = time.monotonic()
        try:
            resp = httpx.request(method, url, json=json, params=params, data=data, files=files, timeout=timeout,
                                 headers={**(headers or {}), "Authorization": f"Bearer {settings.b2v_api_key}"})
        except httpx.HTTPError as e:
            log.warning("blog2video %s %s failed (attempt %d): %s", method, path, attempt, type(e).__name__)
            if last:
                raise Unreachable(NOT_RESPONDING) from None
            time.sleep(attempt)
            continue
        log.info("blog2video %s %s -> %s in %.0fms", method, path, resp.status_code,
                 (time.monotonic() - started) * 1000)
        if not last and (resp.status_code >= 500 or resp.status_code == 429):
            time.sleep(_retry_after(resp) if resp.status_code == 429 else attempt)
            continue
        _raise_for(resp, path)
        if raw:
            return resp.content, resp.headers.get("content-type", "application/octet-stream")
        return None if resp.status_code == 204 or not resp.content else _body(resp)
    raise AssertionError("unreachable")


# Shared catalog: the same for every workspace, cached for an hour.

_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = threading.Lock()


def cached(key: str, fetch: Callable[[], Any], ttl: float = CATALOG_TTL) -> Any:
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.monotonic() - hit[0] < ttl:
            return hit[1]
    try:
        value = fetch()
    except B2VError:
        if hit is None:
            raise
        # blog2video is slow or down: the last copy is better than failing the request.
        log.warning("blog2video catalog %r could not be refreshed; using the copy from %.0fs ago",
                    key, time.monotonic() - hit[0])
        return hit[1]
    with _cache_lock:
        _cache[key] = (time.monotonic(), value)
    return value


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _catalog_timeout() -> float:
    """Catalog lists are fetched about once an hour, so wait as long as a create would rather than fail."""
    return settings.b2v_timeout_seconds


def builtin_templates() -> list[dict]:
    return cached("templates", lambda: request("GET", "/api/templates", timeout=_catalog_timeout()) or [])


def crafted_templates() -> list[dict]:
    return cached("crafted", lambda: request("GET", "/api/crafted-templates", timeout=_catalog_timeout()) or [])


def prebuilt_voices() -> list[dict]:
    """voice_id, name, preview_url, labels, description, plan ('free' | 'paid')."""
    return cached("prebuilt", lambda: (request("GET", "/api/voices/prebuilt", timeout=_catalog_timeout()) or {})
                  .get("voices") or [])


def music_tracks() -> list[dict]:
    """track_id, display_name, mood, r2_url."""
    return cached("music", lambda: request("GET", "/api/background-music/tracks", timeout=_catalog_timeout()) or [])


def video_styles() -> dict:
    """Account-wide picker payload. Filter before use (b2v_access.visible_styles)."""
    return request("GET", "/api/video-styles") or {}


def account() -> Any:
    """Our blog2video account: plan, videos, AI-edit allowance and credits, template slots."""
    return request("GET", "/api/auth/me")


# Videos

def create_video(body: dict, idempotency_key: str) -> Any:
    return request("POST", "/api/v1/videos", json=body, headers={"Idempotency-Key": idempotency_key},
                   timeout=settings.b2v_timeout_seconds)


def upload_project(form: dict, files: list[tuple[str, bytes, str]]) -> Any:
    """Create a project from documents. Generation starts with generate()."""
    return request("POST", "/api/projects/upload", data=form, timeout=UPLOAD_TIMEOUT,
                   files=[("files", (name, content, ctype)) for name, content, ctype in files])


def generate(project_id: int) -> Any:
    return request("POST", f"/api/projects/{project_id}/generate", timeout=settings.b2v_timeout_seconds)


def status(project_id: int, created_via: str = "v1") -> Any:
    if created_via == "upload":
        return request("GET", f"/api/projects/{project_id}/status")
    return request("GET", f"/api/v1/videos/{project_id}/status")


def get_project(project_id: int) -> Any:
    """The whole project (scenes, assets). Much heavier than a status poll, so it gets the long timeout."""
    return request("GET", f"/api/projects/{project_id}", timeout=settings.b2v_timeout_seconds)


def delete_project(project_id: int) -> Any:
    # blog2video removes the project's files before answering, which can take well over the 10s status timeout:
    # timing out early reported a failure for a delete that went on to succeed.
    return request("DELETE", f"/api/projects/{project_id}", timeout=settings.b2v_timeout_seconds)


def upload_logo(project_id: int, filename: str, content_type: str, content: bytes) -> Any:
    return request("POST", f"/api/projects/{project_id}/logo", files={"file": (filename, content, content_type)},
                   timeout=UPLOAD_TIMEOUT)


def preview_token(project_id: int) -> Any:
    return request("POST", f"/api/embed/token/{project_id}")


def project_call(method: str, project_id: int, sub: str, **kwargs) -> Any:
    """Any /api/projects/{id}/... editor endpoint. Callers allowlist `sub` (app/routers/video_edit.py)."""
    return request(method, f"/api/projects/{project_id}/{sub.lstrip('/')}", **kwargs)

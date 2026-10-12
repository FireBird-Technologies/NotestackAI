"""The video editor: one allowlisted proxy onto blog2video's /api/projects/{id}/... endpoints.

    <METHOD> /api/videos/{artifact_id}/p/<path>  ->  <METHOD> /api/projects/{blog2video id}/<path>

Only paths in RULES pass (anything else is 404). Before forwarding, the video must be this workspace's
(b2v_access.video_or_404), every template / voice / style id in a JSON body must be this workspace's (check_refs),
AI edits come out of the workspace's own counter (given back if
blog2video refuses). A template switch also uses one video, as it does on blog2video.

JSON bodies, multipart uploads (images, voiceovers, portraits) and binary answers (downloads, stills) pass through.
"""

import json
import re
import uuid
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from app.auth import Ctx, get_ctx
from app.routers.videos import b2v_ready, store, upstream
from app.services import b2v_access, video_limits, video_quota
from app.services import blog2video as b2v
from app.services.plans import effective_plan, plan_limit_error

router = APIRouter(prefix="/api/videos", tags=["videos"])

MAX_JSON_BYTES = 512 * 1024
MAX_FILE_BYTES = 50 * 1024 * 1024
S = r"\d+"  # a scene id


@dataclass(frozen=True)
class Rule:
    ai_edits: int = 0  # AI edits this call uses (per workspace, video_limits "ai_edits")
    uses_video: bool = False  # a template switch: one video from the allowance
    raw: bool = False  # binary answer (download, still)
    timeout: float = 30
    status: str | None = None  # artifact status to show once it started


RULES: list[tuple[str, re.Pattern, Rule]] = [(m, re.compile(f"^{p}$"), r) for m, p, r in [
    # Project settings, logo, assets
    ("GET", "", Rule(timeout=60)),  # the whole project: slow on a far-away database
    ("PATCH", "update-project", Rule()),
    ("PATCH", "", Rule()),
    ("POST", "logo", Rule()),
    ("DELETE", "logo", Rule()),
    ("PATCH", rf"assets/{S}/exclude", Rule()),
    ("DELETE", rf"assets/{S}", Rule()),
    ("GET", "layouts", Rule()),
    ("GET", "status", Rule()),
    # Scenes
    ("PUT", rf"scenes/{S}", Rule()),
    ("DELETE", rf"scenes/{S}", Rule()),
    ("PUT", "bulk-update-scenes", Rule()),
    ("POST", "scenes/reorder", Rule()),
    ("POST", rf"scenes/{S}/regenerate", Rule(ai_edits=1, timeout=120)),
    ("POST", "scenes/add", Rule(ai_edits=1)),
    ("GET", "scenes/add-status", Rule()),
    # Images
    ("POST", rf"scenes/{S}/image", Rule(timeout=60)),
    ("POST", rf"scenes/{S}/generate-image", Rule(ai_edits=1, timeout=120)),
    ("PATCH", rf"scenes/{S}/image-focus", Rule()),
    ("POST", "images/move", Rule()),
    ("POST", "images/swap", Rule()),
    ("POST", "images/duplicate", Rule()),
    ("POST", "images/assign-existing", Rule()),
    # Stock footage
    ("GET", "stock-footage/search", Rule()),
    ("POST", rf"scenes/{S}/stock-footage", Rule(ai_edits=1, timeout=60)),
    ("GET", "stock-footage/pending", Rule()),
    ("POST", "stock-footage/link", Rule()),
    ("POST", "stock-footage/approve", Rule(status="generating")),
    ("POST", "stock-footage/reject", Rule(status="generating")),
    # Voice, voiceovers, language, template
    ("POST", rf"scenes/{S}/voiceover", Rule(timeout=60)),
    # blog2video keeps the project's status during a voiceover delete; marking ours lets a reload resume its progress
    # (voice-change-status reports it, kind "delete"), and the next status check sets it back.
    ("POST", "delete-voiceover", Rule(status="voice_regenerating")),
    ("POST", "change-voice", Rule(status="voice_regenerating")),
    ("GET", "voice-change-status", Rule()),
    ("POST", "change-language", Rule(status="language_regenerating")),
    ("GET", "language-change-status", Rule()),
    ("POST", "change-template-regenerate-layouts", Rule(uses_video=True, status="regenerating")),
    ("GET", "template-change-status", Rule()),
    # Refresh the script
    ("POST", "regenerate-script", Rule(status="script_regenerating")),
    ("GET", "regenerate-script-status", Rule()),
    ("GET", "regenerate-script/preview", Rule()),
    ("POST", "regenerate-script/verify", Rule()),
    ("POST", "regenerate-script/regenerate", Rule()),
    # Render, download, frames
    ("POST", "render", Rule(status="rendering")),
    ("GET", "render-status", Rule()),
    ("POST", "cancel-render", Rule()),
    ("GET", "download-url", Rule()),
    ("GET", "download", Rule(raw=True, timeout=120)),
    ("GET", "render-still", Rule(raw=True, timeout=60)),
    ("POST", "render-stills", Rule(timeout=120)),
]]


def rule_for(method: str, path: str) -> Rule | None:
    for m, pattern, rule in RULES:
        if m == method and pattern.match(path):
            return rule
    return None


async def _read_body(request: Request) -> tuple[dict | None, dict | None, list | None]:
    """(json, form fields, files) from the browser's request."""
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("multipart/form-data"):
        form = await request.form()
        data, files = {}, []
        for key, value in form.multi_items():
            if isinstance(value, UploadFile):
                content = await value.read(MAX_FILE_BYTES + 1)
                if len(content) > MAX_FILE_BYTES:
                    raise HTTPException(413, "That file is too large.")
                files.append((key, (value.filename or "file", content, value.content_type or
                                    "application/octet-stream")))
            else:
                data[key] = value
        return None, data, files
    raw = await request.body()
    if not raw:
        return None, None, None
    if len(raw) > MAX_JSON_BYTES:
        raise HTTPException(413, "Request too large")
    try:
        return json.loads(raw), None, None
    except ValueError:
        raise HTTPException(400, "Send JSON") from None


def _charge(ctx: Ctx, rule: Rule, body: dict | None, form: dict | None) -> int:
    """References and counters, all before blog2video is called. Returns AI edits taken."""
    plan = effective_plan(ctx.db, ctx.workspace)
    refs = body if isinstance(body, dict) else (form or {})
    with upstream():  # checking a template or voice may need blog2video's catalog
        b2v_access.check_refs(ctx, refs, plan)
    edits = rule.ai_edits
    if edits:
        video_limits.take(ctx.db, ctx.workspace, "ai_edits", edits, plan=plan)
    if rule.uses_video and not video_quota.reserve(ctx.db, ctx.workspace.id):
        if edits:
            video_limits.give_back(ctx.db, ctx.workspace.id, "ai_edits", edits)
        raise plan_limit_error(plan, "videos", "Switching the template uses a video, and you have none left.")
    return edits


@router.api_route("/{artifact_id}/p/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def project_proxy(artifact_id: uuid.UUID, path: str, request: Request, ctx: Ctx = Depends(get_ctx),
                        _: None = Depends(b2v_ready)):
    path = path.strip("/")
    rule = rule_for(request.method, path)
    if rule is None:
        raise HTTPException(404, "Not found")
    a, vid, _row = b2v_access.video_or_404(ctx, artifact_id)
    body, form, files = await _read_body(request)
    edits = await run_in_threadpool(_charge, ctx, rule, body, form)
    params = dict(request.query_params)

    def call():
        return b2v.project_call(request.method, vid, path, json=body, data=form, files=files or None,
                                params=params or None, timeout=rule.timeout, raw=rule.raw)

    try:
        with upstream():
            result = await run_in_threadpool(call)
    except HTTPException:
        if edits:
            video_limits.give_back(ctx.db, ctx.workspace.id, "ai_edits", edits)
        if rule.uses_video:
            video_quota.unreserve(ctx.db, ctx.workspace.id)
        raise
    if rule.status:
        store(ctx, a, status=rule.status)
    if rule.raw:
        content, ctype = result
        return Response(content, media_type=ctype, headers={"Cache-Control": "no-store"})
    return result

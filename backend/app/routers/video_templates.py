"""Custom video templates: made from a website, a document or a description, then generated and edited.

Templates are made on our one blog2video account, which has a small lifetime number of template slots (a delete
does not give one back). b2v_templates records which workspace made each template; only that workspace sees, uses,
edits or deletes it, and each workspace has its own share of slots and daily AI steps (video_limits).

Create: extract a theme (/extract/url | /extract/doc | /extract/prompt) -> POST "" (uses a slot) -> /{id}/generate
-> poll /{id}/generation-status until complete (the template becomes usable in the wizard) or error.
Edit: /{id}/p/<path> -> /api/custom-templates/{id}/<path>, allowlisted in RULES.
"""

import json
import re
from dataclasses import dataclass

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile as StarletteUpload

from app.auth import Ctx, get_ctx
from app.models import B2VTemplate, B2VVideo
from app.routers.videos import b2v_ready, upstream
from app.services import b2v_access, video_limits
from app.services import blog2video as b2v
from app.services.plans import effective_plan, plan_limit_error

router = APIRouter(prefix="/api/video-templates", tags=["videos"])

DOC_MAX_BYTES = 10 * 1024 * 1024
LOGO_MAX_BYTES = 2 * 1024 * 1024
AI_TIMEOUT = 120


def _out(t: B2VTemplate) -> dict:
    return {"id": t.b2v_template_id, "ref": f"custom_{t.b2v_template_id}", "name": t.name, "ready": t.ready,
            "created_at": t.created_at.isoformat() if t.created_at else None}


def _can_make(ctx: Ctx) -> None:
    """Refuse early (before any AI work) when the workspace has no template slots left."""
    plan = effective_plan(ctx.db, ctx.workspace)
    limit = int(plan.video_limits.get("templates", 0))
    if limit >= 0 and video_limits.used(ctx.db, ctx.workspace.id, "templates") >= limit:
        raise plan_limit_error(plan, "video_limits.templates",
                               "Your plan does not include custom templates." if limit == 0
                               else f"You have made all {limit} custom templates your plan includes.")


def _counted(ctx: Ctx, metric: str, call):
    video_limits.take(ctx.db, ctx.workspace, metric)
    try:
        with upstream():
            return call()
    except HTTPException:
        video_limits.give_back(ctx.db, ctx.workspace.id, metric)
        raise


@router.get("")
def list_templates(ctx: Ctx = Depends(get_ctx)):
    limits = video_limits.report(ctx.db, ctx.workspace)["limits"]
    return {"templates": [_out(t) for t in b2v_access.my_templates(ctx)],
            "limits": {k: limits[k] for k in ("templates", "template_ai_daily")}}


# 1. Extract a theme


class ExtractUrlIn(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class ExtractPromptIn(BaseModel):
    prompt: str = Field(min_length=15, max_length=5000)
    name: str | None = Field(None, max_length=255)


@router.post("/extract/url")
def extract_from_url(body: ExtractUrlIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    if not re.match(r"https?://", body.url):
        raise HTTPException(400, "Enter a link that starts with http:// or https://")
    _can_make(ctx)
    with upstream():
        return b2v.request("POST", "/api/custom-templates/extract-theme", json=body.model_dump(), timeout=AI_TIMEOUT)


@router.post("/extract/prompt")
def extract_from_prompt(body: ExtractPromptIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    _can_make(ctx)
    return _counted(ctx, "template_ai_daily", lambda: b2v.request(
        "POST", "/api/custom-templates/extract-theme-from-prompt", json=body.model_dump(), timeout=AI_TIMEOUT))


@router.post("/extract/doc")
async def extract_from_doc(file: UploadFile = File(...), name: str = Form(""), ctx: Ctx = Depends(get_ctx),
                           _: None = Depends(b2v_ready)):
    data = await file.read(DOC_MAX_BYTES + 1)
    if len(data) > DOC_MAX_BYTES:
        raise HTTPException(400, "Keep the document under 10 MB.")
    _can_make(ctx)
    files = {"file": (file.filename or "brand.pdf", data, file.content_type or "application/octet-stream")}
    return await run_in_threadpool(_counted, ctx, "template_ai_daily", lambda: b2v.request(
        "POST", "/api/custom-templates/extract-theme-from-doc", data={"name": name[:255]}, files=files,
        timeout=AI_TIMEOUT))


# 2. Create (uses a slot) and 3. generate


class CreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    theme: dict
    source_url: str | None = Field(None, max_length=2048)
    logo_urls: list[str] | None = Field(None, max_length=20)
    og_image: str | None = Field(None, max_length=2048)
    screenshot_url: str | None = Field(None, max_length=2048)
    reason: str | None = Field(None, max_length=2000)


@router.post("", status_code=201)
def create_template(body: CreateIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    made = _counted(ctx, "templates", lambda: b2v.request("POST", "/api/custom-templates",
                                                          json=body.model_dump(exclude_none=True), timeout=60))
    row = B2VTemplate(b2v_template_id=int(made["id"]), workspace_id=ctx.workspace.id, name=body.name[:255])
    ctx.db.add(row)
    ctx.db.commit()
    return _out(row)


@router.post("/{template_id}/generate")
def generate(template_id: int, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    b2v_access.owned_template(ctx, template_id)
    return _counted(ctx, "template_ai_daily", lambda: b2v.request(
        "POST", f"/api/custom-templates/{template_id}/generate-code", timeout=60))


@router.get("/{template_id}/generation-status")
def generation_status(template_id: int, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    row = b2v_access.owned_template(ctx, template_id)
    with upstream():
        s = b2v.request("GET", f"/api/custom-templates/{template_id}/generation-status") or {}
    ready = s.get("status") == "complete"
    if ready != row.ready:
        row.ready = ready
        ctx.db.commit()
    return {**s, "ready": ready}


@router.delete("/{template_id}")
def delete_template(template_id: int, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    """blog2video refuses (template_in_use) while any video on the account uses the template. We force it only
    when every such video is this workspace's: another workspace's video must never lose its template."""
    row = b2v_access.owned_template(ctx, template_id)
    ref = f"custom_{template_id}"
    try:
        with upstream():
            b2v.request("DELETE", f"/api/custom-templates/{template_id}")
    except HTTPException as e:
        if e.status_code == 404:
            pass
        elif e.status_code == 409:
            others = ctx.db.scalar(select(B2VVideo.id).where(B2VVideo.template_ref == ref,
                                                             B2VVideo.workspace_id != ctx.workspace.id).limit(1))
            if others is not None:
                raise HTTPException(409, "This template is in use and can not be deleted.") from None
            with upstream():
                b2v.request("DELETE", f"/api/custom-templates/{template_id}", params={"force": "true"})
        else:
            raise
    ctx.db.delete(row)
    ctx.db.commit()
    return {"ok": True}  # the slot is not given back: blog2video's slots are lifetime


# Editing: allowlisted proxy


@dataclass(frozen=True)
class Rule:
    ai_edit: bool = False  # ★ one AI edit
    metric: str | None = None  # another counter this uses (a lifetime slot, a daily AI step)
    raw: bool = False


K = r"(intro|outro|content_\d+)"  # scene keys
RULES: list[tuple[str, re.Pattern, Rule]] = [(m, re.compile(f"^{p}$"), r) for m, p, r in [
    ("GET", "", Rule()),
    ("PUT", "", Rule()),
    ("GET", "code", Rule()),
    ("POST", "upload-logo", Rule()),
    ("POST", f"scenes/{K}/ai-edit", Rule(ai_edit=True)),
    ("GET", f"scenes/{K}/ai-edit/status", Rule()),
    ("GET", "scene-drafts", Rule()),
    ("GET", f"scenes/{K}/draft", Rule()),
    ("POST", f"scenes/{K}/draft/apply", Rule()),
    ("POST", f"scenes/{K}/draft/discard", Rule()),
    ("PATCH", f"scenes/{K}/chart", Rule()),
    ("PATCH", f"scenes/{K}/font-defaults", Rule()),
    ("PATCH", "scenes/font-defaults", Rule()),
    ("GET", "versions", Rule()),
    ("POST", r"versions/\d+/rollback", Rule()),
    ("POST", "regenerate-code", Rule(metric="templates")),  # uses a slot, like creating one
    ("POST", "resume-generation", Rule()),
    ("POST", "rating", Rule()),
]]


def _rule(method: str, path: str) -> Rule | None:
    return next((r for m, p, r in RULES if m == method and p.match(path)), None)


def _take(ctx: Ctx, rule: Rule) -> list[str]:
    taken: list[str] = []
    try:
        if rule.ai_edit:
            plan = video_limits.require_premium(ctx.db, ctx.workspace, "AI template editing")
            video_limits.take(ctx.db, ctx.workspace, "ai_edits", plan=plan)
            taken.append("ai_edits")
        if rule.metric:
            video_limits.take(ctx.db, ctx.workspace, rule.metric)
            taken.append(rule.metric)
    except HTTPException:
        for metric in taken:
            video_limits.give_back(ctx.db, ctx.workspace.id, metric)
        raise
    return taken


@router.api_route("/{template_id}/p/{path:path}", methods=["GET", "POST", "PUT", "PATCH"])
async def template_proxy(template_id: int, path: str, request: Request, ctx: Ctx = Depends(get_ctx),
                         _: None = Depends(b2v_ready)):
    path = path.strip("/")
    rule = _rule(request.method, path)
    if rule is None:
        raise HTTPException(404, "Not found")
    row = b2v_access.owned_template(ctx, template_id)
    body = form = files = None
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        parsed = await request.form()
        form, files = {}, []
        for key, value in parsed.multi_items():
            if isinstance(value, StarletteUpload):
                content = await value.read(LOGO_MAX_BYTES + 1)
                if len(content) > LOGO_MAX_BYTES:
                    raise HTTPException(413, "Keep the file under 2 MB.")
                files.append((key, (value.filename or "logo.png", content, value.content_type or "image/png")))
            else:
                form[key] = value
    elif raw := await request.body():
        try:
            body = json.loads(raw)
        except ValueError:
            raise HTTPException(400, "Send JSON") from None
    taken = await run_in_threadpool(_take, ctx, rule)

    def call():
        return b2v.request(request.method, f"/api/custom-templates/{template_id}/{path}".rstrip("/"), json=body,
                           data=form, files=files or None, params=dict(request.query_params) or None,
                           timeout=AI_TIMEOUT, raw=rule.raw)

    try:
        with upstream():
            result = await run_in_threadpool(call)
    except HTTPException:
        for metric in taken:
            video_limits.give_back(ctx.db, ctx.workspace.id, metric)
        raise
    if request.method == "PUT" and path == "" and isinstance(body, dict) and body.get("name"):
        row.name = str(body["name"])[:255]
        ctx.db.commit()
    if rule.raw:
        content, ctype = result
        return Response(content, media_type=ctype)
    return result


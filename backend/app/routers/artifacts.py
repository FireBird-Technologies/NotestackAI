import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from app.auth import Ctx, get_ctx
from app.config import settings
from app.models import Artifact, CalendarItem, Document, Job, Notebook, UserSavedVoice
from app.routers.notebooks import ensure_archive_notebook
from app.services.artifacts import latest_jobs, serialize_artifact, start_artifact
from app.services.jobs import create_job, serialize_job
from app.services.plans import effective_plan, plan_limit_error
from app.services.renderer import COMPOSITIONS
from app.services.storage import storage
from app.services.usage import check_limit

router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])

ArtifactType = Literal["summary", "audio_overview", "video", "quote_card", "carousel", "launch_kit", "mind_map"]


class RenderIn(BaseModel):
    composition: Literal["AudiogramSquare", "QuoteCard", "CarouselSlide"]
    props: dict


class GenerateIn(BaseModel):
    type: Literal["summary", "audio_overview", "video", "quote_card", "carousel", "launch_kit", "mind_map"]
    notebook_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    archive: bool = False  # no notebook or post picked: use the "All posts" notebook
    # audio_overview
    format: Literal["deep_dive", "brief", "debate"] = "deep_dive"
    minutes: int = Field(6, ge=1, le=30)
    # the two hosts' voices, from the workspace's voices (none: the defaults)
    host_a: str | None = Field(None, max_length=100)
    host_b: str | None = Field(None, max_length=100)
    # video: only audiograms here; other videos are made by blog2video (/api/videos)
    style: str = "audiogram"
    audio_artifact_id: uuid.UUID | None = None
    # carousel
    slides: list[dict] | None = None
    parent_id: uuid.UUID | None = None
    # mind_map: the posts to chart (none picked means every post in the notebook) and what to centre on
    document_ids: list[uuid.UUID] | None = None
    focus: str | None = Field(None, max_length=500)


def _hosts(ctx: Ctx, body: GenerateIn) -> dict:
    """The voices picked for an audio overview's two hosts: each one from the workspace's voices (or a default)."""
    picked = {k: v for k, v in (("host_a", body.host_a), ("host_b", body.host_b)) if v}
    if picked:
        ok = set(ctx.db.scalars(select(UserSavedVoice.voice_id).where(UserSavedVoice.workspace_id == ctx.workspace.id,
                                                                     UserSavedVoice.voice_id.in_(picked.values()))))
        ok |= {settings.elevenlabs_voice_a, settings.elevenlabs_voice_b}
        if any(v not in ok for v in picked.values()):
            raise HTTPException(400, "Pick the hosts' voices from your voices")
    return picked


class PatchIn(BaseModel):
    title: str | None = Field(None, max_length=300)
    content: dict | None = None


def get_artifact_or_404(ctx: Ctx, artifact_id: uuid.UUID) -> Artifact:
    a = ctx.db.scalar(select(Artifact).where(Artifact.id == artifact_id, Artifact.workspace_id == ctx.workspace.id))
    if not a:
        raise HTTPException(404, "Artifact not found")
    return a


def _target_title(ctx: Ctx, notebook_id: uuid.UUID | None, document_id: uuid.UUID | None) -> str:
    if document_id:
        doc = ctx.db.scalar(select(Document).where(Document.id == document_id,
                                                   Document.workspace_id == ctx.workspace.id))
        if not doc:
            raise HTTPException(404, "Post not found")
        if not doc.path:
            plan = effective_plan(ctx.db, ctx.workspace)
            raise plan_limit_error(plan, "indexed_posts",
                                   f"This post is not indexed. Your plan indexes your latest {plan.indexed_posts} "
                                   "posts; upgrade to use your whole archive.")
        return doc.title
    if notebook_id:
        nb = ctx.db.scalar(select(Notebook).where(Notebook.id == notebook_id,
                                                  Notebook.workspace_id == ctx.workspace.id))
        if not nb:
            raise HTTPException(404, "Notebook not found")
        return nb.title
    raise HTTPException(400, "Pick a notebook or a post")


@router.post("/generate")
def generate(body: GenerateIn, ctx: Ctx = Depends(get_ctx)):
    """One entry point for every generated artifact."""
    if body.archive and not body.notebook_id and not body.document_id:
        body.notebook_id = ensure_archive_notebook(ctx).id
    params: dict = {}
    content: dict = {}
    if body.type == "video" and body.style != "audiogram":
        raise HTTPException(410, "Videos moved to /app/videos")
    if body.type == "video":
        if not body.audio_artifact_id:
            raise HTTPException(400, "Pick an audio overview for the audiogram")
        source = get_artifact_or_404(ctx, body.audio_artifact_id)
        title = f"Audiogram: {(source.content_json or {}).get('title', 'Audio overview')}"
        params = {"style": "audiogram", "audio_artifact_id": str(source.id)}
        artifact, job = start_artifact(ctx.db, ctx.workspace.id, "video", title=title, notebook_id=source.notebook_id,
                                       document_id=source.document_id, params=params, job_kind="video")
        return serialize_artifact(artifact, job)
    if body.type == "carousel":
        if not body.slides:
            raise HTTPException(400, "A carousel needs slides")
        content = {"slides": body.slides[:12], "parent_id": str(body.parent_id) if body.parent_id else None}
    target = _target_title(ctx, body.notebook_id, body.document_id)
    if body.type == "audio_overview":
        check_limit(ctx.db, ctx.workspace, "audio_minutes", body.minutes)
        params = {"format": body.format, "minutes": body.minutes, **_hosts(ctx, body)}
        title = f"Audio overview: {target}"
    elif body.type == "mind_map":
        if not body.notebook_id:
            raise HTTPException(400, "A Mind Constellation is made from a notebook")
        params = {"document_ids": [str(i) for i in body.document_ids or []], "focus": (body.focus or "").strip()}
        title = f"Mind Constellation: {params['focus'][:60] or target}"
    elif body.type == "launch_kit":
        if not body.document_id:
            raise HTTPException(400, "A Launch Kit is made from one post")
        check_limit(ctx.db, ctx.workspace, "launch_kits", 1)
        title = f"Launch Kit: {target}"
    else:
        title = {"summary": "Summary", "quote_card": "Quote", "carousel": "Carousel"}[body.type] + f": {target}"
    artifact, job = start_artifact(ctx.db, ctx.workspace.id, body.type, title=title, notebook_id=body.notebook_id,
                                   document_id=body.document_id, content=content, params=params,
                                   max_attempts=1 if body.type in {"quote_card", "carousel"} else 2)
    return serialize_artifact(artifact, job)


@router.get("")
def list_artifacts(
    ctx: Ctx = Depends(get_ctx),
    type: str | None = None,
    notebook_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    status: str | None = None,
    q: str = "",
    limit: int = 60,
    offset: int = 0,
):
    query = select(Artifact).where(Artifact.workspace_id == ctx.workspace.id)
    if type:
        query = query.where(Artifact.type.in_(type.split(",")))
    else:  # files uploaded to post live in the Launchpad's picker, not among the things Notestack made
        query = query.where(Artifact.type != "upload")
    if notebook_id:
        query = query.where(Artifact.notebook_id == notebook_id)
    if document_id:
        query = query.where(Artifact.document_id == document_id)
    if status:
        query = query.where(Artifact.status.in_(status.split(",")))
    if q.strip():
        # Titles live in JSON; match on the linked post or notebook title instead of JSON operators.
        like = f"%{q.strip()}%"
        docs = select(Document.id).where(Document.workspace_id == ctx.workspace.id, Document.title.ilike(like))
        nbs = select(Notebook.id).where(Notebook.workspace_id == ctx.workspace.id, Notebook.title.ilike(like))
        query = query.where(or_(Artifact.document_id.in_(docs), Artifact.notebook_id.in_(nbs)))
    total = ctx.db.scalar(select(func.count()).select_from(query.subquery()))
    rows = ctx.db.scalars(query.order_by(Artifact.created_at.desc()).offset(max(offset, 0)).limit(min(limit, 200)))
    rows = list(rows.all())
    jobs = latest_jobs(ctx.db, [a.id for a in rows])
    return {"total": total, "items": [serialize_artifact(a, jobs.get(a.id)) for a in rows]}


@router.get("/{artifact_id}")
def get_artifact(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    a = get_artifact_or_404(ctx, artifact_id)
    return serialize_artifact(a, latest_jobs(ctx.db, [a.id]).get(a.id))


@router.patch("/{artifact_id}")
def patch_artifact(artifact_id: uuid.UUID, body: PatchIn, ctx: Ctx = Depends(get_ctx)):
    a = get_artifact_or_404(ctx, artifact_id)
    content = dict(a.content_json or {})
    if body.content is not None:
        protected = {"slide_keys", "quote_card_ids", "segments", "voices"}
        if a.type == "upload":  # what the file is, as posting reads it: only its title can change
            protected |= {"filename", "content_type", "media", "size_bytes", "duration_s"}
        content.update({k: v for k, v in body.content.items() if k not in protected})
    if body.title is not None:
        if not body.title.strip():
            raise HTTPException(400, "Give it a name.")
        content["title"] = body.title.strip()
    a.content_json = content
    ctx.db.commit()
    return serialize_artifact(a, latest_jobs(ctx.db, [a.id]).get(a.id))


@router.delete("/{artifact_id}")
def delete_artifact(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    a = get_artifact_or_404(ctx, artifact_id)
    if a.type == "video" and (a.content_json or {}).get("provider") == "blog2video":
        from app.routers.videos import remove_video  # also removes it from blog2video

        remove_video(ctx, a)
        return {"ok": True}
    storage.delete_prefix(f"ws/{ctx.workspace.id}/artifacts/{a.id}/")
    if a.type == "upload":  # a file from the user's computer: its upload record (and file) go too
        from app.services.uploads import remove_upload_artifact

        remove_upload_artifact(ctx.db, a)
    ctx.db.query(CalendarItem).filter(CalendarItem.artifact_id == a.id, CalendarItem.status == "scheduled").delete()
    ctx.db.delete(a)
    ctx.db.commit()
    return {"ok": True}


@router.post("/{artifact_id}/retry")
def retry_artifact(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    a = get_artifact_or_404(ctx, artifact_id)
    last = latest_jobs(ctx.db, [a.id]).get(a.id)
    if not last:
        raise HTTPException(400, "Nothing to retry")
    if last.status not in {"failed", "done"}:
        raise HTTPException(409, "Still running")
    a.status = "pending"
    content = dict(a.content_json or {})
    content.pop("error", None)
    a.content_json = content
    job = create_job(ctx.db, ctx.workspace.id, last.kind, last.params, artifact_id=a.id, max_attempts=last.max_attempts)
    return serialize_artifact(a, job)


@router.post("/{artifact_id}/render")
def render_artifact(artifact_id: uuid.UUID, body: RenderIn, ctx: Ctx = Depends(get_ctx)):
    a = get_artifact_or_404(ctx, artifact_id)
    if body.composition not in COMPOSITIONS:
        raise HTTPException(400, "Unknown composition")
    a.status = "rendering"
    job = create_job(ctx.db, ctx.workspace.id, "render",
                     {"artifact_id": str(a.id), "composition": body.composition, "props": body.props},
                     artifact_id=a.id, max_attempts=1)
    return serialize_job(job)


@router.get("/{artifact_id}/jobs")
def artifact_jobs(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    a = get_artifact_or_404(ctx, artifact_id)
    jobs = ctx.db.scalars(select(Job).where(Job.artifact_id == a.id).order_by(Job.created_at.desc())).all()
    return [serialize_job(j) for j in jobs]

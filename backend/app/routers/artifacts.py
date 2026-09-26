import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from app.auth import Ctx, get_ctx
from app.models import Artifact, CalendarItem, Document, Job, Notebook
from app.services.artifacts import latest_jobs, serialize_artifact, start_artifact
from app.services.jobs import create_job, serialize_job
from app.services.renderer import COMPOSITIONS
from app.services.storage import storage
from app.services.usage import check_limit

router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])

ArtifactType = Literal["summary", "audio_overview", "video", "quote_card", "carousel", "launch_kit"]


class RenderIn(BaseModel):
    composition: Literal["ShortVertical", "ExplainerLong", "AudiogramSquare", "QuoteCard", "CarouselSlide"]
    props: dict


class GenerateIn(BaseModel):
    type: Literal["summary", "audio_overview", "video", "quote_card", "carousel", "launch_kit"]
    notebook_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    # audio_overview
    format: Literal["deep_dive", "brief", "debate"] = "deep_dive"
    minutes: int = Field(6, ge=1, le=30)
    # video
    style: Literal["short", "explainer", "audiogram"] = "short"
    audio_artifact_id: uuid.UUID | None = None
    # carousel
    slides: list[dict] | None = None
    parent_id: uuid.UUID | None = None


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
    params: dict = {}
    content: dict = {}
    if body.type == "video" and body.style == "audiogram":
        if not body.audio_artifact_id:
            raise HTTPException(400, "Pick an audio overview for the audiogram")
        source = get_artifact_or_404(ctx, body.audio_artifact_id)
        seconds = float((source.content_json or {}).get("duration_s", 60))
        check_limit(ctx.db, ctx.workspace, "video_minutes", seconds / 60)
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
        params = {"format": body.format, "minutes": body.minutes}
        title = f"Audio overview: {target}"
    elif body.type == "video":
        check_limit(ctx.db, ctx.workspace, "video_minutes", 1 if body.style == "short" else 3)
        params = {"style": body.style}
        title = f"{'Short' if body.style == 'short' else 'Explainer'} video: {target}"
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
        content.update({k: v for k, v in body.content.items() if k not in protected})
    if body.title is not None:
        content["title"] = body.title
    a.content_json = content
    ctx.db.commit()
    return serialize_artifact(a, latest_jobs(ctx.db, [a.id]).get(a.id))


@router.delete("/{artifact_id}")
def delete_artifact(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    a = get_artifact_or_404(ctx, artifact_id)
    storage.delete_prefix(f"ws/{ctx.workspace.id}/artifacts/{a.id}/")
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

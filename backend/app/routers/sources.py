import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select

from app.auth import Ctx, get_ctx
from app.models import Document, Job, Source
from app.pipeline.ingest import normalize_feed_url
from app.services.jobs import create_job, serialize_job
from app.services.plans import effective_plan

router = APIRouter(prefix="/api/sources", tags=["sources"])


class SourceIn(BaseModel):
    url: str


def _serialize(source: Source, doc_count: int = 0) -> dict:
    return {
        "id": str(source.id),
        "feed_url": source.feed_url,
        "platform": source.platform,
        "title": source.title,
        "sync_status": source.sync_status,
        "sync_error": source.sync_error,
        "last_synced_at": source.last_synced_at.isoformat() if source.last_synced_at else None,
        "document_count": doc_count,
    }


def _enqueue_sync(ctx: Ctx, source: Source) -> Job:
    return create_job(ctx.db, ctx.workspace.id, "ingest", {"source_id": str(source.id)})


@router.post("")
def create_source(body: SourceIn, ctx: Ctx = Depends(get_ctx)):
    feed_url, platform = normalize_feed_url(body.url)
    existing = ctx.db.scalar(
        select(Source).where(Source.workspace_id == ctx.workspace.id, Source.feed_url == feed_url)
    )
    if existing:
        job = _enqueue_sync(ctx, existing)
        return {"source": _serialize(existing), "job": serialize_job(job)}
    plan = effective_plan(ctx.db, ctx.workspace)
    count = ctx.db.scalar(select(func.count()).select_from(Source).where(Source.workspace_id == ctx.workspace.id))
    if count >= plan.sources:
        raise HTTPException(402, {"code": "plan_limit", "message": f"Your plan includes {plan.sources} sources."})
    source = Source(workspace_id=ctx.workspace.id, feed_url=feed_url, platform=platform, site_url=body.url)
    ctx.db.add(source)
    ctx.db.commit()
    job = _enqueue_sync(ctx, source)
    return {"source": _serialize(source), "job": serialize_job(job)}


@router.get("")
def list_sources(ctx: Ctx = Depends(get_ctx)):
    rows = ctx.db.execute(
        select(Source, func.count(Document.id))
        .outerjoin(Document, Document.source_id == Source.id)
        .where(Source.workspace_id == ctx.workspace.id)
        .group_by(Source.id)
        .order_by(Source.created_at)
    ).all()
    return [_serialize(s, n) for s, n in rows]


@router.get("/{source_id}/sync")
def sync_source(source_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    source = ctx.db.scalar(
        select(Source).where(Source.id == source_id, Source.workspace_id == ctx.workspace.id)
    )
    if not source:
        raise HTTPException(404, "Source not found")
    job = _enqueue_sync(ctx, source)
    return {"source": _serialize(source), "job": serialize_job(job)}


documents_router = APIRouter(prefix="/api/documents", tags=["documents"])


@documents_router.get("")
def list_documents(ctx: Ctx = Depends(get_ctx), limit: int = 500):
    docs = ctx.db.scalars(
        select(Document)
        .where(Document.workspace_id == ctx.workspace.id)
        .order_by(Document.published_at.desc())
        .limit(min(limit, 5000))
    ).all()
    return [
        {"id": str(d.id), "title": d.title, "url": d.url,
         "published_at": d.published_at.isoformat() if d.published_at else None}
        for d in docs
    ]

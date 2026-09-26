import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select

from app.auth import Ctx, get_ctx
from app.corpus import INDEX, Corpus, CorpusError
from app.models import Document, Job, NotebookDocument, Source, Upload
from app.pipeline.ingest import IMPORTS_FEED, FeedNotFound, discover_feed, imports_source, rebuild_index
from app.services.jobs import create_job, serialize_job
from app.services.plans import effective_plan
from app.services.storage import storage

router = APIRouter(prefix="/api/sources", tags=["sources"])


class SourceIn(BaseModel):
    url: str = Field(min_length=3, max_length=1000)


class UploadImportIn(BaseModel):
    upload_id: uuid.UUID


def serialize_source(source: Source, doc_count: int = 0) -> dict:
    return {
        "id": str(source.id),
        "feed_url": source.feed_url,
        "site_url": source.site_url,
        "platform": source.platform,
        "title": source.title,
        "sync_status": source.sync_status,
        "sync_error": source.sync_error,
        "last_synced_at": source.last_synced_at.isoformat() if source.last_synced_at else None,
        "document_count": doc_count,
        "is_imports": source.feed_url == IMPORTS_FEED,
    }


def _get(ctx: Ctx, source_id: uuid.UUID) -> Source:
    source = ctx.db.scalar(select(Source).where(Source.id == source_id, Source.workspace_id == ctx.workspace.id))
    if not source:
        raise HTTPException(404, "Source not found")
    return source


def _enqueue_sync(ctx: Ctx, source: Source) -> Job:
    source.sync_status = "pending"
    return create_job(ctx.db, ctx.workspace.id, "ingest", {"source_id": str(source.id)})


def _doc_count(ctx: Ctx, source: Source) -> int:
    return ctx.db.scalar(select(func.count()).select_from(Document).where(Document.source_id == source.id)) or 0


@router.post("")
async def create_source(body: SourceIn, ctx: Ctx = Depends(get_ctx)):
    try:
        found = await run_in_threadpool(discover_feed, body.url)
    except FeedNotFound as exc:
        raise HTTPException(422, {"code": "feed_not_found", "message": str(exc)}) from exc
    existing = ctx.db.scalar(
        select(Source).where(Source.workspace_id == ctx.workspace.id, Source.feed_url == found.feed_url)
    )
    if existing:
        job = _enqueue_sync(ctx, existing)
        return {"source": serialize_source(existing, _doc_count(ctx, existing)), "job": serialize_job(job)}
    plan = effective_plan(ctx.db, ctx.workspace)
    count = ctx.db.scalar(
        select(func.count()).select_from(Source)
        .where(Source.workspace_id == ctx.workspace.id, Source.feed_url != IMPORTS_FEED)
    )
    if count >= plan.sources:
        raise HTTPException(402, {"code": "plan_limit", "message": f"Your plan includes {plan.sources} sources."})
    source = Source(workspace_id=ctx.workspace.id, feed_url=found.feed_url, platform=found.platform,
                    site_url=found.site_url, title=found.title)
    ctx.db.add(source)
    ctx.db.commit()
    job = _enqueue_sync(ctx, source)
    return {"source": serialize_source(source), "job": serialize_job(job)}


@router.get("")
def list_sources(ctx: Ctx = Depends(get_ctx)):
    rows = ctx.db.execute(
        select(Source, func.count(Document.id))
        .outerjoin(Document, Document.source_id == Source.id)
        .where(Source.workspace_id == ctx.workspace.id)
        .group_by(Source.id)
        .order_by(Source.created_at)
    ).all()
    return [serialize_source(s, n) for s, n in rows]


@router.post("/{source_id}/sync")
def sync_source(source_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    source = _get(ctx, source_id)
    if source.feed_url == IMPORTS_FEED:
        raise HTTPException(400, "Imported posts have no feed to sync.")
    job = _enqueue_sync(ctx, source)
    return {"source": serialize_source(source, _doc_count(ctx, source)), "job": serialize_job(job)}


def remove_documents(ctx: Ctx, docs: list[Document]) -> None:
    """Delete documents plus their corpus files and raw HTML, then rebuild INDEX.md."""
    if not docs:
        return
    paths = {d.path for d in docs if d.path}
    for d in docs:
        if d.raw_html_key:
            storage.delete_prefix(d.raw_html_key.rsplit("/", 1)[0])
    ids = [d.id for d in docs]
    ctx.db.execute(delete(NotebookDocument).where(NotebookDocument.document_id.in_(ids)))
    ctx.db.execute(delete(Document).where(Document.id.in_(ids)))
    ctx.db.flush()
    Corpus(ctx.workspace.id).write_files({INDEX: rebuild_index(ctx.db, ctx.workspace.id)}, remove=paths)


@router.delete("/{source_id}")
def delete_source(source_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    source = _get(ctx, source_id)
    docs = ctx.db.scalars(select(Document).where(Document.source_id == source.id)).all()
    remove_documents(ctx, list(docs))
    ctx.db.delete(source)
    ctx.db.commit()
    return {"ok": True, "removed_posts": len(docs)}


@router.post("/url")
def import_url(body: SourceIn, ctx: Ctx = Depends(get_ctx)):
    source = imports_source(ctx.db, ctx.workspace.id)
    ctx.db.commit()
    job = create_job(ctx.db, ctx.workspace.id, "import_url", {"source_id": str(source.id), "url": body.url})
    return {"source": serialize_source(source, _doc_count(ctx, source)), "job": serialize_job(job)}


@router.post("/upload")
def import_upload(body: UploadImportIn, ctx: Ctx = Depends(get_ctx)):
    upload = ctx.db.scalar(select(Upload).where(Upload.id == body.upload_id, Upload.workspace_id == ctx.workspace.id))
    if not upload or upload.status != "complete":
        raise HTTPException(404, "Upload not found or not finished")
    source = imports_source(ctx.db, ctx.workspace.id)
    ctx.db.commit()
    job = create_job(ctx.db, ctx.workspace.id, "import_upload",
                     {"source_id": str(source.id), "upload_id": str(upload.id)})
    return {"source": serialize_source(source, _doc_count(ctx, source)), "job": serialize_job(job)}


documents_router = APIRouter(prefix="/api/documents", tags=["documents"])


def serialize_document(d: Document, source: Source | None = None) -> dict:
    meta = d.metadata_json or {}
    return {
        "id": str(d.id),
        "title": d.title,
        "url": d.url,
        "path": d.path,
        "source_id": str(d.source_id) if d.source_id else None,
        "source_title": source.title if source else None,
        "published_at": d.published_at.isoformat() if d.published_at else None,
        "words": meta.get("words") or len((d.clean_text or "").split()),
        "evergreen_score": d.evergreen_score,
    }


@documents_router.get("")
def list_documents(
    ctx: Ctx = Depends(get_ctx),
    q: str = "",
    source_id: uuid.UUID | None = None,
    limit: int = 500,
    offset: int = 0,
):
    query = (
        select(Document, Source)
        .outerjoin(Source, Source.id == Document.source_id)
        .where(Document.workspace_id == ctx.workspace.id)
    )
    if q.strip():
        like = f"%{q.strip()}%"
        query = query.where(or_(Document.title.ilike(like), Document.clean_text.ilike(like)))
    if source_id:
        query = query.where(Document.source_id == source_id)
    total = ctx.db.scalar(select(func.count()).select_from(query.subquery()))
    rows = ctx.db.execute(
        query.order_by(Document.published_at.desc().nulls_last(), Document.created_at.desc())
        .offset(max(offset, 0)).limit(min(limit, 5000))
    ).all()
    return {"total": total, "items": [serialize_document(d, s) for d, s in rows]}


@documents_router.get("/{document_id}")
def get_document(document_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    doc = ctx.db.scalar(select(Document).where(Document.id == document_id, Document.workspace_id == ctx.workspace.id))
    if not doc:
        raise HTTPException(404, "Post not found")
    source = ctx.db.get(Source, doc.source_id) if doc.source_id else None
    lines: list[str] = []
    if doc.path:
        corpus = Corpus(ctx.workspace.id)
        try:
            if not corpus.exists(doc.path):
                corpus.sync()
            lines = corpus.read_lines(doc.path)
        except CorpusError:
            lines = []
    if not lines:
        lines = [f"# {doc.title}", "", *(doc.clean_text or "").splitlines()]
    return {**serialize_document(doc, source), "lines": lines}


@documents_router.delete("/{document_id}")
def delete_document(document_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    doc = ctx.db.scalar(select(Document).where(Document.id == document_id, Document.workspace_id == ctx.workspace.id))
    if not doc:
        raise HTTPException(404, "Post not found")
    remove_documents(ctx, [doc])
    ctx.db.commit()
    return {"ok": True}

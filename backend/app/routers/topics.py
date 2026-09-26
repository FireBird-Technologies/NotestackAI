import uuid
from collections import Counter
from itertools import combinations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.models import Document, DocumentTopic, Topic
from app.routers.sources import serialize_document
from app.services.jobs import create_job, serialize_job

router = APIRouter(prefix="/api/topics", tags=["topics"])


@router.get("")
def topic_map(ctx: Ctx = Depends(get_ctx), min_posts: int = 1, limit: int = 80):
    """Nodes are topics sized by post count; edges join topics that share posts."""
    topics = ctx.db.scalars(
        select(Topic).where(Topic.workspace_id == ctx.workspace.id, Topic.post_count >= min_posts)
        .order_by(Topic.post_count.desc()).limit(min(limit, 300))
    ).all()
    ids = {t.id for t in topics}
    links = ctx.db.execute(
        select(DocumentTopic.document_id, DocumentTopic.topic_id).where(DocumentTopic.topic_id.in_(ids))
    ).all() if ids else []
    by_doc: dict[uuid.UUID, list[uuid.UUID]] = {}
    for doc_id, topic_id in links:
        by_doc.setdefault(doc_id, []).append(topic_id)
    edges: Counter[tuple[str, str]] = Counter()
    for tids in by_doc.values():
        for a, b in combinations(sorted(str(t) for t in tids), 2):
            edges[(a, b)] += 1
    untagged = ctx.db.scalar(
        select(Document.id).where(Document.workspace_id == ctx.workspace.id, Document.path.is_not(None),
                                  Document.id.not_in(select(DocumentTopic.document_id))).limit(1)
    )
    return {
        "nodes": [{"id": str(t.id), "name": t.name, "summary": t.summary, "post_count": t.post_count}
                  for t in topics],
        "edges": [{"source": a, "target": b, "weight": w} for (a, b), w in edges.most_common(400)],
        "has_untagged_posts": untagged is not None,
    }


@router.get("/{topic_id}")
def topic_detail(topic_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    topic = ctx.db.scalar(select(Topic).where(Topic.id == topic_id, Topic.workspace_id == ctx.workspace.id))
    if not topic:
        raise HTTPException(404, "Topic not found")
    rows = ctx.db.execute(
        select(Document, DocumentTopic.weight)
        .join(DocumentTopic, DocumentTopic.document_id == Document.id)
        .where(DocumentTopic.topic_id == topic.id)
        .order_by(DocumentTopic.weight.desc(), Document.published_at.desc())
    ).all()
    return {"id": str(topic.id), "name": topic.name, "summary": topic.summary, "post_count": topic.post_count,
            "posts": [{**serialize_document(d), "weight": w} for d, w in rows]}


@router.post("/rebuild")
def rebuild(ctx: Ctx = Depends(get_ctx), full: bool = False):
    params = {}
    if full:
        # Clear per post tags so every post is mapped again.
        for d in ctx.db.scalars(select(Document).where(Document.workspace_id == ctx.workspace.id)):
            if d.metadata_json and "topics" in d.metadata_json:
                d.metadata_json = {k: v for k, v in d.metadata_json.items() if k != "topics"}
        ctx.db.commit()
    job = create_job(ctx.db, ctx.workspace.id, "topics", params, max_attempts=2)
    return serialize_job(job)

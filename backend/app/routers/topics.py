"""Topic map: topics as stars, co-occurrence as constellation lines, plus the insight a writer needs:
which topics are rising, which went dormant, which travel together, and how each one evolved."""

import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from itertools import combinations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.models import Document, DocumentTopic, Topic
from app.routers.sources import serialize_document
from app.services.jobs import create_job, serialize_job

router = APIRouter(prefix="/api/topics", tags=["topics"])

BUCKETS = 12  # timeline resolution across the archive's lifetime


def _aware(dt: datetime | None) -> datetime | None:
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=UTC)


@dataclass
class TopicStats:
    topic: Topic
    dates: list[datetime] = field(default_factory=list)
    docs: set[uuid.UUID] = field(default_factory=set)


@dataclass
class Archive:
    start: datetime
    end: datetime
    recent_from: datetime
    total_docs: int
    recent_docs: int

    def bucket(self, dt: datetime) -> int:
        span = (self.end - self.start).total_seconds() or 1
        return min(BUCKETS - 1, max(0, int((dt - self.start).total_seconds() / span * BUCKETS)))


def _load(ctx: Ctx, topic_ids: set[uuid.UUID] | None = None):
    """Topic -> dated posts, and the archive's time frame."""
    q = (
        select(DocumentTopic.topic_id, DocumentTopic.document_id, Document.published_at, Document.created_at)
        .join(Document, Document.id == DocumentTopic.document_id)
        .where(Document.workspace_id == ctx.workspace.id)
    )
    if topic_ids is not None:
        q = q.where(DocumentTopic.topic_id.in_(topic_ids))
    rows = ctx.db.execute(q).all()
    all_dates = [
        _aware(p or c)
        for p, c in ctx.db.execute(
            select(Document.published_at, Document.created_at).where(
                Document.workspace_id == ctx.workspace.id, Document.path.is_not(None))
        ).all()
    ]
    now = datetime.now(UTC)
    start = min(all_dates, default=now)
    end = max(all_dates, default=now)
    span = end - start
    # "Recent" is the last quarter of the writer's own publishing history (at least 60 days), so an archive
    # that stopped in 2022 still shows what was rising at the end of it.
    window = max(span / 4, timedelta(days=60))
    recent_from = end - window
    archive = Archive(start, end, recent_from, len(all_dates), sum(1 for d in all_dates if d >= recent_from))
    return rows, archive


def _status(count: int, recent: int, last: datetime | None, archive: Archive) -> tuple[str, float]:
    """(status, momentum). Momentum compares the topic's share of recent posts to its share of all posts."""
    overall = count / max(archive.total_docs, 1)
    recent_share = recent / max(archive.recent_docs, 1)
    momentum = round(recent_share / overall, 2) if overall else 0.0
    if recent == 0 and last and last < archive.recent_from:
        return "dormant", momentum
    if momentum >= 1.4 and recent >= 2:
        return "rising", momentum
    return "steady", momentum


def _galaxies(node_ids: list[str], edges: Counter) -> dict[str, int]:
    """Weighted label propagation: topics that share posts settle into the same galaxy."""
    label = {n: i for i, n in enumerate(node_ids)}
    nbrs: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for (a, b), w in edges.items():
        nbrs[a].append((b, w))
        nbrs[b].append((a, w))
    for _ in range(12):
        changed = False
        for n in node_ids:  # deterministic order: biggest topics first
            if not nbrs[n]:
                continue
            score: Counter = Counter()
            for m, w in nbrs[n]:
                score[label[m]] += w
            best = max(score.items(), key=lambda kv: (kv[1], -kv[0]))[0]
            if score[best] > score.get(label[n], 0) and best != label[n]:
                label[n] = best
                changed = True
        if not changed:
            break
    return label


@router.get("")
def topic_map(ctx: Ctx = Depends(get_ctx), min_posts: int = 1, limit: int = 80):
    topics = ctx.db.scalars(
        select(Topic).where(Topic.workspace_id == ctx.workspace.id, Topic.post_count >= min_posts)
        .order_by(Topic.post_count.desc(), Topic.name).limit(min(limit, 300))
    ).all()
    by_id = {t.id: TopicStats(t) for t in topics}
    rows, archive = _load(ctx, set(by_id)) if by_id else ([], None)

    by_doc: dict[uuid.UUID, list[str]] = defaultdict(list)
    for topic_id, doc_id, published, created in rows:
        st = by_id[topic_id]
        if doc_id not in st.docs:
            st.docs.add(doc_id)
            st.dates.append(_aware(published or created))
            by_doc[doc_id].append(str(topic_id))
    edges: Counter[tuple[str, str]] = Counter()
    for tids in by_doc.values():
        for a, b in combinations(sorted(set(tids)), 2):
            edges[(a, b)] += 1

    node_ids = [str(t.id) for t in topics]
    galaxy_of = _galaxies(node_ids, edges)
    nodes = []
    for t in topics:
        st = by_id[t.id]
        dates = sorted(st.dates)
        count = len(dates) or t.post_count
        recent = sum(1 for d in dates if archive and d >= archive.recent_from)
        first, last = (dates[0], dates[-1]) if dates else (None, None)
        status, momentum = _status(count, recent, last, archive) if archive else ("steady", 1.0)
        timeline = [0] * BUCKETS
        for d in dates:
            timeline[archive.bucket(d)] += 1
        span = (archive.end - archive.start).total_seconds() if archive else 0
        recency = round((last - archive.start).total_seconds() / span, 3) if last and span else 1.0
        nodes.append({
            "id": str(t.id), "name": t.name, "summary": t.summary, "post_count": count,
            "first_at": first.isoformat() if first else None, "last_at": last.isoformat() if last else None,
            "recent_posts": recent, "momentum": momentum, "status": status, "recency": recency,
            "timeline": timeline, "galaxy": galaxy_of[str(t.id)],
        })

    # Galaxies: named after their brightest (most written about) star.
    members: dict[int, list[dict]] = defaultdict(list)
    for n in nodes:
        members[n["galaxy"]].append(n)
    galaxies = []
    for gid, ns in sorted(members.items(), key=lambda kv: -sum(n["post_count"] for n in kv[1])):
        lead = max(ns, key=lambda n: n["post_count"])
        galaxies.append({"id": gid, "name": lead["name"], "topic_ids": [n["id"] for n in ns],
                         "post_count": sum(n["post_count"] for n in ns), "size": len(ns)})
    names = {n["id"]: n["name"] for n in nodes}
    rising = sorted((n for n in nodes if n["status"] == "rising"), key=lambda n: -n["momentum"])[:5]
    dormant = sorted((n for n in nodes if n["status"] == "dormant"), key=lambda n: -n["post_count"])[:5]
    untagged = ctx.db.scalar(
        select(Document.id).where(Document.workspace_id == ctx.workspace.id, Document.path.is_not(None),
                                  Document.id.not_in(select(DocumentTopic.document_id))).limit(1)
    )
    return {
        "nodes": nodes,
        "edges": [{"source": a, "target": b, "weight": w} for (a, b), w in edges.most_common(400)],
        "galaxies": galaxies,
        "insights": {
            "rising": [{"id": n["id"], "name": n["name"], "momentum": n["momentum"]} for n in rising],
            "dormant": [{"id": n["id"], "name": n["name"], "last_at": n["last_at"], "post_count": n["post_count"]}
                        for n in dormant],
            "pairs": [{"a": names[a], "b": names[b], "a_id": a, "b_id": b, "posts": w}
                      for (a, b), w in edges.most_common(5)],
        },
        "archive": {
            "start": archive.start.isoformat() if archive else None,
            "end": archive.end.isoformat() if archive else None,
            "recent_from": archive.recent_from.isoformat() if archive else None,
            "posts": archive.total_docs if archive else 0,
        },
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
    doc_ids = [d.id for d, _ in rows]
    _, archive = _load(ctx, {topic.id})
    dates = sorted(_aware(d.published_at or d.created_at) for d, _ in rows)
    recent = sum(1 for d in dates if d >= archive.recent_from)
    status, momentum = _status(len(dates), recent, dates[-1] if dates else None, archive)
    timeline = [0] * BUCKETS
    for d in dates:
        timeline[archive.bucket(d)] += 1
    # Topics that share posts with this one, strongest first.
    related = Counter()
    if doc_ids:
        for other_id, in ctx.db.execute(
            select(DocumentTopic.topic_id).where(DocumentTopic.document_id.in_(doc_ids),
                                                 DocumentTopic.topic_id != topic.id)
        ).all():
            related[other_id] += 1
    related_topics = {t.id: t for t in ctx.db.scalars(select(Topic).where(Topic.id.in_(list(related))))} \
        if related else {}
    return {
        "id": str(topic.id), "name": topic.name, "summary": topic.summary, "post_count": len(dates),
        "first_at": dates[0].isoformat() if dates else None, "last_at": dates[-1].isoformat() if dates else None,
        "recent_posts": recent, "momentum": momentum, "status": status, "timeline": timeline,
        "timeline_start": archive.start.isoformat(), "timeline_end": archive.end.isoformat(),
        "related": [{"id": str(tid), "name": related_topics[tid].name, "shared_posts": n}
                    for tid, n in related.most_common(6) if tid in related_topics],
        "posts": [{**serialize_document(d), "weight": w} for d, w in rows],
    }


@router.post("/rebuild")
def rebuild(ctx: Ctx = Depends(get_ctx), full: bool = False):
    if full:
        # Clear per post tags so every post is mapped again.
        for d in ctx.db.scalars(select(Document).where(Document.workspace_id == ctx.workspace.id)):
            if d.metadata_json and "topics" in d.metadata_json:
                d.metadata_json = {k: v for k, v in d.metadata_json.items() if k != "topics"}
        ctx.db.commit()
    job = create_job(ctx.db, ctx.workspace.id, "topics", {}, max_attempts=2)
    return serialize_job(job)

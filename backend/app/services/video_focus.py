"""The video wizard's focus cards: the topics the workspace already has for the source, shown as they are.

Each post is tagged by the background `topics` job (generate.extract_topics); a post still without tags is tagged
here on demand. A source's tags make its pool, each scored by weight and by how much of the source shares it (a
chat's tags are those of the posts its answers cite). The cards are the best merged topics (the Topic Map's, with a
summary), spread over the source's posts, then the posts' own tags (a name only) when there are fewer than three.
"""

import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.corpus import slugify
from app.llm import run
from app.llm.provider import fast_lm
from app.llm.signatures import ExtractTopics
from app.models import Citation, Document, DocumentTopic, Message, Topic
from app.pipeline.generate import save_topic_tags
from app.routers.sources import is_locked
from app.services.jobs import create_job, pending_job

INLINE_TAG_CAP = 5  # untagged posts tagged while the wizard waits; the rest go to the background job
TAG_TEXT = 6000  # characters of a post read when tagging it on demand (the background job reads 12000)
CARDS = 3


@dataclass
class Candidate:
    name: str
    summary: str
    score: float
    sources: set[str]  # the posts (or chats) that carry it
    merged: bool  # a topic of the topic table (has a summary), not only a post's own tag


# Tags


def ensure_tags(db: Session, workspace_id: uuid.UUID, docs: list[Document]) -> None:
    """Tag the newest few untagged posts now, in parallel, and leave the rest to the background job, which also
    merges these new tags into the topic table. A failed call leaves that post untagged: never an error here."""
    untagged = [d for d in docs if not (d.metadata_json or {}).get("topics") and not is_locked(d)]
    if not untagged or not settings.llm_api_key:
        return
    untagged.sort(key=lambda d: d.published_at or d.created_at, reverse=True)
    now = untagged[:INLINE_TAG_CAP]
    known = sorted(db.scalars(select(Topic.name).where(Topic.workspace_id == workspace_id)))[:200]
    outs = run.predict_many(ExtractTopics, [{"title": d.title, "text": (d.clean_text or "")[:TAG_TEXT],
                                             "known_topics": known} for d in now],
                            db=db, workspace_id=workspace_id, lm=fast_lm())
    for doc, out in zip(now, outs, strict=True):
        if out is not None:
            save_topic_tags(doc, out)
    db.commit()
    # With no ids the job tags every post still untagged (the rest of these too) and rebuilds the topic table.
    if not pending_job(db, workspace_id, "topics"):
        create_job(db, workspace_id, "topics", {}, max_attempts=2)


def chat_citations(db: Session, workspace_id: uuid.UUID,
                   chat_ids: list[uuid.UUID]) -> tuple[dict[str, dict[uuid.UUID, float]], list[Document]]:
    """For each chat, the posts its answers cite (weighted by how often, the most cited 1.0), and those posts.
    Locked posts are left out: the chat itself is fine to use."""
    rows = db.execute(
        select(Message.chat_id, Citation.document_id, func.count())
        .join(Citation, Citation.message_id == Message.id)
        .where(Message.chat_id.in_(chat_ids))
        .group_by(Message.chat_id, Citation.document_id)
    ).all()
    docs = {d.id: d for d in db.scalars(select(Document).where(
        Document.id.in_({doc_id for _, doc_id, _ in rows}), Document.workspace_id == workspace_id)) if not is_locked(d)}
    counts: dict[str, dict[uuid.UUID, int]] = defaultdict(dict)
    for chat_id, doc_id, n in rows:
        if doc_id in docs:
            counts[str(chat_id)][doc_id] = n
    cited = {chat: {d: n / max(per.values()) for d, n in per.items()} for chat, per in counts.items()}
    return cited, list(docs.values())


def build_pool(db: Session, workspace_id: uuid.UUID, sources: dict[str, dict[uuid.UUID, float]],
               docs: list[Document]) -> list[Candidate]:
    """Every tag of the source's posts, best first. A source is a post (itself, weight 1) or a chat (the posts it
    cites). Score: the tag's weight summed over the sources that carry it, times the share of sources that do, so a
    theme running through the selection beats one post's strongest tag."""
    tags = _doc_tags(db, workspace_id, docs)
    score: dict[str, float] = defaultdict(float)
    carried: dict[str, set[str]] = defaultdict(set)
    summaries: dict[str, str] = {}
    merged: dict[str, bool] = defaultdict(bool)
    for source, weights in sources.items():
        best: dict[str, float] = {}
        for doc_id, w in weights.items():
            for name, (tag_weight, summary, is_merged) in tags.get(doc_id, {}).items():
                best[name] = max(best.get(name, 0.0), tag_weight * w)
                summaries.setdefault(name, summary)
                merged[name] |= is_merged
        for name, v in best.items():
            score[name] += v
            carried[name].add(source)
    total = max(len(sources), 1)
    pool = [Candidate(name, summaries[name], score[name] * len(carried[name]) / total, carried[name], merged[name])
            for name in score]
    return sorted(pool, key=lambda c: (-c.score, c.name))


def _doc_tags(db: Session, workspace_id: uuid.UUID,
              docs: list[Document]) -> dict[uuid.UUID, dict[str, tuple[float, str, bool]]]:
    """Post -> {topic name: (weight, summary, merged)}: the topic table's (merged) topics and the post's own tags. The
    merge folds a post's specific tags into a few broad workspace topics ("Content Repurposing" into "Finance
    Substacks & Audience Growth"), which alone leaves a single post one or two angles; the merged names are what lets
    posts share a tag. An own tag is named as the topic table's matching topic if any, and skipped if already there."""
    out: dict[uuid.UUID, dict[str, tuple[float, str, bool]]] = defaultdict(dict)
    rows = db.execute(
        select(DocumentTopic.document_id, DocumentTopic.weight, Topic.name, Topic.summary)
        .join(Topic, Topic.id == DocumentTopic.topic_id)
        .where(DocumentTopic.document_id.in_([d.id for d in docs]), Topic.workspace_id == workspace_id)
    ).all()
    for doc_id, weight, name, summary in rows:
        out[doc_id][name] = (float(weight or 0.5), summary or "", True)
    own = [d for d in docs if (d.metadata_json or {}).get("topics")]
    if own:
        known = {t.slug: t for t in db.scalars(select(Topic).where(Topic.workspace_id == workspace_id))}
        for d in own:
            have = {slugify(n, 120) for n in out[d.id]}
            for t in d.metadata_json["topics"]:
                topic = known.get(slugify(t["name"], 120))
                name = topic.name if topic else t["name"]
                if slugify(name, 120) in have:
                    continue
                have.add(slugify(name, 120))
                summary = (topic.summary or "") if topic else ""
                out[d.id][name] = (float(t.get("weight") or 0.5), summary, topic is not None)
    return out


def pick_cards(pool: list[Candidate], n: int = CARDS) -> list[Candidate]:
    """The cards: merged topics first, then own tags. Within each, best score first, halved for each card already on
    every post the topic has, so several posts' cards do not all come from one post."""
    chosen: list[Candidate] = []
    covered: Counter[str] = Counter()  # source -> cards on it so far

    def worth(c: Candidate) -> float:
        return c.score * 0.5 ** min(covered[s] for s in c.sources)

    for group in ([c for c in pool if c.merged], [c for c in pool if not c.merged]):
        rest = list(enumerate(group))  # the pool's order breaks ties
        while rest and len(chosen) < n:
            i, best = max(rest, key=lambda ic: (worth(ic[1]), -ic[0]))
            chosen.append(best)
            covered.update(best.sources)
            rest.remove((i, best))
    return chosen

"""Text generation jobs over the corpus: notebook summaries, topic map, voice profile, evergreen scores."""

import logging
import time
import uuid
from collections import Counter, defaultdict
from datetime import UTC, datetime

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.corpus import Corpus, slugify
from app.llm import run
from app.llm.provider import fast_lm
from app.llm.signatures import BuildVoiceProfile, ConsolidateTopics, EvergreenScore, ExtractTopics, SummarizeNotebook
from app.models import Artifact, Document, DocumentTopic, Job, Notebook, Topic, VoiceProfile
from app.pipeline.passages import as_citations, notebook_docs, passages_for, tools_for, workspace_docs
from app.pipeline.research import verify_citations
from app.services.jobs import update_job

log = logging.getLogger(__name__)


class NothingToDo(ValueError):
    pass


# Notebook summary


def summarize_notebook(db: Session, job: Job, artifact: Artifact) -> dict:
    nb = db.get(Notebook, artifact.notebook_id)
    docs = notebook_docs(db, nb.id)
    if not docs:
        raise NothingToDo("This notebook has no posts yet.")
    corpus = Corpus(nb.workspace_id)
    update_job(db, job, progress=0.1, message=f"Reading {len(docs)} posts")
    passages = passages_for(corpus, docs)
    update_job(db, job, progress=0.3, message="Writing the summary")
    out = run.predict(SummarizeNotebook, db=db, workspace_id=nb.workspace_id, job=job,
                      title=nb.title, passages=passages)
    tools = tools_for(corpus, docs)
    text, cites = verify_citations(tools, out.get("summary") or "", as_citations(out.get("citations")))
    by_path = {d.path: d for d in docs}
    content = {
        "title": f"Summary: {nb.title}",
        "summary": text,
        "themes": out.get("themes") or [],
        "citations": [
            {"marker": c.marker, "path": c.path, "line_start": c.line_start, "line_end": c.line_end,
             "span": c.quote, "title": by_path[c.path].title, "url": by_path[c.path].url,
             "document_id": str(by_path[c.path].id)}
            for c in cites if c.path in by_path
        ],
    }
    artifact.content_json = content
    artifact.status = "ready"
    nb.summary = text
    db.commit()
    return {"artifact_id": str(artifact.id)}


# Topic map


TAG_TRIES = 3  # per post per job: the model times out or rate limits now and then
TAG_BACKOFF = (2.0, 6.0)  # seconds before the second and third try
MAX_TAG_FAILURES = 5  # jobs in a row that could not tag a post: the sweep stops asking for it (and logs it)


def needs_topics(meta: dict | None) -> bool:
    """A post without topics yet that is still worth another try (see worker.topics_backfill)."""
    meta = meta or {}
    return not meta.get("topics") and int(meta.get("topics_failures") or 0) < MAX_TAG_FAILURES


def save_topic_tags(doc: Document, out: dict) -> list[dict]:
    """ExtractTopics' answer for a post (at most 8 named topics), kept in metadata_json["topics"]. An answer with no
    topics is not kept, so the post still counts as untagged. Also used by the video wizard, which tags a post on
    demand when it has none yet."""
    tags = [t for t in (out.get("topics") or []) if t.get("name")][:8]
    if tags:
        meta = {k: v for k, v in (doc.metadata_json or {}).items() if k != "topics_failures"}
        doc.metadata_json = {**meta, "topics": tags}
    return tags


def tag_post(db: Session, job: Job | None, workspace_id: uuid.UUID, doc: Document, known: list[str]) -> list[dict]:
    """One post's topics, tried a few times. Out of tries, the post is counted as failed once more (the sweep asks
    again later) and [] returned."""
    error: object = None
    for attempt in range(TAG_TRIES):
        if attempt:
            time.sleep(TAG_BACKOFF[attempt - 1])
        try:
            out = run.predict(ExtractTopics, db=db, workspace_id=workspace_id, job=job, lm=fast_lm(),
                              title=doc.title, text=(doc.clean_text or "")[:12000], known_topics=known)
        except Exception as exc:
            error = exc
            continue
        if tags := save_topic_tags(doc, out):
            return tags
        error = "no topics in the answer"
    meta = doc.metadata_json or {}
    doc.metadata_json = {**meta, "topics_failures": int(meta.get("topics_failures") or 0) + 1}
    log.warning("could not tag post %s (%s): %s", doc.id, doc.title[:60], error)
    return []


def extract_topics(db: Session, job: Job, workspace_id: uuid.UUID, doc_ids: list[str] | None = None) -> dict:
    """Tag posts that have no topics yet (or the given ones), then rebuild the workspace topic table."""
    docs = workspace_docs(db, workspace_id, [uuid.UUID(i) for i in doc_ids] if doc_ids else None)
    todo = [d for d in docs if doc_ids or needs_topics(d.metadata_json)]
    known = sorted({t["name"] for d in docs for t in (d.metadata_json or {}).get("topics", [])})[:200]
    tagged = 0
    for i, d in enumerate(todo):
        update_job(db, job, progress=0.05 + 0.75 * i / max(len(todo), 1), message=f"Mapping {d.title[:70]}")
        if tags := tag_post(db, job, workspace_id, d, known):
            tagged += 1
            known = sorted(set(known) | {t["name"] for t in tags})[:200]
        db.commit()
    update_job(db, job, progress=0.85, message="Drawing constellations")
    count = rebuild_topics(db, job, workspace_id)
    return {"tagged": tagged, "failed": len(todo) - tagged, "topics": count}


def rebuild_topics(db: Session, job: Job | None, workspace_id: uuid.UUID) -> int:
    docs = workspace_docs(db, workspace_id)
    counts: Counter[str] = Counter()
    titles: dict[str, list[str]] = defaultdict(list)
    for d in docs:
        for t in (d.metadata_json or {}).get("topics", []):
            counts[t["name"]] += 1
            if len(titles[t["name"]]) < 3:
                titles[t["name"]].append(d.title)
    if not counts:
        return 0
    canonical = {name: name for name in counts}
    summaries: dict[str, str] = {}
    listing = [f"{n} ({c}): {'; '.join(titles[n])}" for n, c in counts.most_common(150)]
    try:
        out = run.predict(ConsolidateTopics, db=db, workspace_id=workspace_id, job=job, lm=fast_lm(), topics=listing)
        for g in out.get("groups") or []:
            name = (g.get("canonical") or "").strip()
            if not name:
                continue
            summaries[name] = g.get("summary") or ""
            for m in g.get("members") or []:
                if m in canonical:
                    canonical[m] = name
    except Exception:
        pass  # keep raw names; the map still works

    db.execute(delete(DocumentTopic).where(DocumentTopic.document_id.in_([d.id for d in docs])))
    db.execute(delete(Topic).where(Topic.workspace_id == workspace_id))
    db.flush()
    topics: dict[str, Topic] = {}
    for d in docs:
        weights: dict[str, float] = {}
        for t in (d.metadata_json or {}).get("topics", []):
            name = canonical.get(t["name"], t["name"])
            weights[name] = max(weights.get(name, 0), float(t.get("weight") or 0.5))
        for name, weight in weights.items():
            slug = slugify(name, 120)
            topic = topics.get(slug)
            if not topic:
                topic = Topic(workspace_id=workspace_id, name=name, slug=slug, summary=summaries.get(name))
                db.add(topic)
                db.flush()
                topics[slug] = topic
            topic.post_count += 1
            db.add(DocumentTopic(document_id=d.id, topic_id=topic.id, weight=weight))
    db.commit()
    return len(topics)


# Voice profile


def build_voice_profile(db: Session, job: Job, workspace_id: uuid.UUID, doc_ids: list[str]) -> dict:
    docs = workspace_docs(db, workspace_id, [uuid.UUID(i) for i in doc_ids] if doc_ids else None)
    if not doc_ids:
        docs = sorted(docs, key=lambda d: len(d.clean_text or ""), reverse=True)[:8]
    if not docs:
        raise NothingToDo("Add some posts before building a voice profile.")
    update_job(db, job, progress=0.2, message=f"Listening to {len(docs)} posts")
    samples = [f"# {d.title}\n\n{(d.clean_text or '')[:6000]}" for d in docs[:10]]
    out = run.predict(BuildVoiceProfile, db=db, workspace_id=workspace_id, job=job, samples=samples)
    vp = db.scalar(select(VoiceProfile).where(VoiceProfile.workspace_id == workspace_id))
    if not vp:
        vp = VoiceProfile(workspace_id=workspace_id)
        db.add(vp)
    vp.profile_json = out.get("profile") or {}
    vp.sample_doc_ids = [str(d.id) for d in docs[:10]]
    db.commit()
    return {"profile": vp.profile_json}


# Resurfacing


def score_evergreen(db: Session, job: Job, workspace_id: uuid.UUID, limit: int = 60) -> dict:
    docs = [d for d in workspace_docs(db, workspace_id) if d.evergreen_score is None][:limit]
    lm = fast_lm()
    scored = 0
    for i, d in enumerate(docs):
        update_job(db, job, progress=0.05 + 0.9 * i / max(len(docs), 1), message=f"Weighing {d.title[:70]}")
        try:
            out = run.predict(
                EvergreenScore, db=db, workspace_id=workspace_id, job=job, lm=lm, title=d.title,
                published=d.published_at.date().isoformat() if d.published_at else "unknown",
                excerpt=(d.clean_text or "")[:2500],
            )
        except Exception:
            continue
        try:
            d.evergreen_score = max(0.0, min(1.0, float(out.get("score") or 0)))
        except (TypeError, ValueError):
            continue
        d.metadata_json = {**(d.metadata_json or {}), "evergreen_reason": out.get("reason") or "",
                           "reshare_angle": out.get("angle") or "",
                           "scored_at": datetime.now(UTC).isoformat()}
        scored += 1
        db.commit()
    return {"scored": scored}

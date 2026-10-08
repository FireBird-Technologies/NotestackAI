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
from app.llm.signatures import (
    ArrangeMindMap,
    BuildVoiceProfile,
    ConsolidateTopics,
    EvergreenScore,
    ExtractIdeas,
    ExtractTopics,
    SummarizeNotebook,
)
from app.models import Artifact, Document, DocumentTopic, Job, Notebook, Topic, VoiceProfile
from app.pipeline.passages import as_citations, notebook_docs, passages_for, tools_for, verify_refs, workspace_docs
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


# Mind map

MAX_BRANCHES, MAX_DETAILS = 10, 4
IDEAS_BUDGET = 30_000  # characters of one post read for its ideas
BRIEF_ABOVE = 600  # ideas listed to the model by label only beyond this many
CATCH_ALL = "More from your posts"


def _node(item: dict, children: list[dict], refs) -> dict:
    return {"label": (item.get("label") or "").strip()[:80], "note": (item.get("note") or "").strip()[:400],
            "sources": refs(item.get("sources")), "children": children}


def _topic(t: dict, refs) -> dict:
    details = [_node(d, [], refs) for d in [d for d in t.get("details") or [] if (d.get("label") or "").strip()]
               [:MAX_DETAILS]]
    return _node(t, details, refs)


def _cited(branches: list[dict]) -> set[str]:
    found: set[str] = set()

    def walk(n: dict) -> None:
        found.update(s["document_id"] for s in n["sources"])
        for c in n["children"]:
            walk(c)

    for b in branches:
        walk(b)
    return found


def _number(node: dict, nid: str) -> None:
    node["id"] = nid
    for i, c in enumerate(node["children"]):
        _number(c, f"{nid}.{i}")


def ideas_fresh(d) -> bool:
    """True when the post's stored ideas were extracted from its current text."""
    md = d.metadata_json or {}
    return bool(md.get("ideas")) and md.get("ideas_hash") == (d.content_hash or "")


def extract_ideas(db: Session, job: Job | None, workspace_id: uuid.UUID, doc_ids: list[str] | None = None, *,
                  parallel: bool = False, limit: int | None = None) -> dict:
    """Read each post that has no current ideas once and keep what it says on the post (label, note, points and
    the lines they came from). Maps are arranged from these, so they never re-read the posts. `parallel` reads the
    posts together instead of one after the other (a report that needs many at once); `limit` reads at most that many."""
    docs = workspace_docs(db, workspace_id, [uuid.UUID(str(i)) for i in doc_ids] if doc_ids is not None else None)
    todo = [d for d in docs if not ideas_fresh(d)]
    if limit is not None:
        todo = todo[:limit]
    corpus = Corpus(workspace_id)
    lm = fast_lm()
    done = 0
    answers: list[dict | None] | None = None
    if parallel and todo:
        if job:
            update_job(db, job, progress=0.05, message=f"Reading {len(todo)} posts for their key ideas")
        answers = run.predict_many(
            ExtractIdeas,
            [dict(title=d.title, passage="\n\n".join(passages_for(corpus, [d], budget_chars=IDEAS_BUDGET))) for d in todo],
            db=db, workspace_id=workspace_id, lm=lm)
    for i, d in enumerate(todo):
        if answers is not None:
            out = answers[i]
            if out is None:
                continue
        else:
            if job:
                update_job(db, job, progress=0.05 + 0.85 * i / max(len(todo), 1), message=f"Reading {d.title[:70]}")
            try:
                out = run.predict(ExtractIdeas, db=db, workspace_id=workspace_id, job=job, lm=lm, title=d.title,
                                  passage="\n\n".join(passages_for(corpus, [d], budget_chars=IDEAS_BUDGET)))
            except Exception:
                continue
        tools = tools_for(corpus, [d])

        def keep(items, tools=tools, d=d) -> list[dict]:
            return [{"path": r["path"], "line_start": r["line_start"], "line_end": r["line_end"]}
                    for r in verify_refs(tools, items or []) if r["path"] == d.path]

        ideas = []
        for t in out.get("ideas") or []:
            if not (t.get("label") or "").strip():
                continue
            details = [{"label": x["label"].strip()[:80], "note": (x.get("note") or "").strip()[:400],
                        "sources": keep(x.get("sources"))}
                       for x in t.get("details") or [] if (x.get("label") or "").strip()]
            ideas.append({"label": t["label"].strip()[:80], "note": (t.get("note") or "").strip()[:400],
                          "sources": keep(t.get("sources")), "details": details[:MAX_DETAILS]})
        if not ideas:
            continue
        d.metadata_json = {**(d.metadata_json or {}), "ideas": ideas[:8], "ideas_hash": d.content_hash or ""}
        db.commit()
        done += 1
    return {"extracted": done, "skipped": len(todo) - done}


def build_mind_map(db: Session, job: Job, artifact: Artifact) -> dict:
    nb = db.get(Notebook, artifact.notebook_id)
    docs = notebook_docs(db, nb.id)
    picked = {str(i) for i in job.params.get("document_ids") or []}
    if picked:
        docs = [d for d in docs if str(d.id) in picked]
    if not docs:
        raise NothingToDo("Pick at least one post for the Mind Constellation.")
    artifact.content_json = mind_map_content(db, job, nb.workspace_id, nb.title, docs,
                                             (job.params.get("focus") or "").strip())
    artifact.status = "ready"
    db.commit()
    return {"artifact_id": str(artifact.id)}


def mind_map_content(db: Session, job: Job | None, workspace_id: uuid.UUID, title: str, docs: list[Document],
                     focus: str = "") -> dict:
    """A tree (centre, branches, sub-themes, points) over the given posts, arranged from the ideas already stored
    on each post. A focus decides how they are grouped and weighted, never which posts are on the map: every idea
    the model leaves out is filed next to a sibling from the same post, or under a catch-all branch. Used for a
    Mind Constellation artifact and for the map inside a report."""
    corpus = Corpus(workspace_id)
    stale = [d for d in docs if not ideas_fresh(d)]
    if stale:  # background extraction has not reached these yet, so do it now
        if job:
            update_job(db, job, progress=0.1, message=f"Reading {len(stale)} posts")
        extract_ideas(db, None, workspace_id, [str(d.id) for d in stale])
    tools = tools_for(corpus, docs)

    def refs(items) -> list[dict]:
        by_path = {d.path: d for d in docs}
        return [{"document_id": str(by_path[r["path"]].id), "path": r["path"], "title": r["title"],
                 "line_start": r["line_start"], "line_end": r["line_end"], "quote": r["quote"]}
                for r in verify_refs(tools, items or []) if r["path"] in by_path]

    corpus.sync()
    pool: dict[str, dict] = {}  # idea id -> node
    owner: dict[str, str] = {}  # idea id -> document id
    for di, d in enumerate(docs):
        ideas = list((d.metadata_json or {}).get("ideas") or []) if ideas_fresh(d) else []
        if not ideas:  # extraction failed for this post: a sub-theme from its own opening lines
            try:
                lines = corpus.read_lines(d.path)
            except Exception:
                lines = []
            first = next((n for n, line in enumerate(lines, start=1) if line.strip()), 1)
            ideas = [{"label": d.title[:60], "note": "A post in this map. Open its source to read it.",
                      "sources": [{"path": d.path, "line_start": first, "line_end": first + 5}], "details": []}]
        for ii, idea in enumerate(ideas):
            pool[f"{di}.{ii}"] = _topic(idea, refs)
            owner[f"{di}.{ii}"] = str(d.id)

    # A very large notebook lists labels only, and the leftover rule below files whatever is not listed.
    brief = len(pool) > BRIEF_ABOVE
    listing = [f"{i} | {n['label']}" if brief else f"{i} | {n['label']}: {n['note'][:140]}" for i, n in pool.items()]
    if job:
        update_job(db, job, progress=0.4, message="Charting the constellation")
    out = run.predict(ArrangeMindMap, db=db, workspace_id=workspace_id, job=job,
                      title=title, focus=focus or "(none)", ideas=listing)

    placed: set[str] = set()
    branches: list[dict] = []
    members: list[list[str]] = []
    for b in [b for b in out.get("branches") or [] if (b.get("label") or "").strip()][:MAX_BRANCHES]:
        ids = [i for i in dict.fromkeys(b.get("ideas") or []) if i in pool and i not in placed]
        if not ids:
            continue
        placed.update(ids)
        branches.append(_node(b, [pool[i] for i in ids], refs))
        members.append(ids)

    def catch_all() -> dict:
        for b in branches:
            if b["label"] == CATCH_ALL:
                return b
        b = {"label": CATCH_ALL, "note": "Posts whose ideas did not fit a theme above.", "sources": [], "children": []}
        branches.append(b)
        members.append([])
        return b

    for i in [i for i in pool if i not in placed]:
        home = next((k for k, ids in enumerate(members) if any(owner[x] == owner[i] for x in ids)), None)
        (branches[home] if home is not None else catch_all())["children"].append(pool[i])
        if home is not None:
            members[home].append(i)

    for i, b in enumerate(branches):
        _number(b, str(i))
    centre = (out.get("centre") or focus or title).strip()[:80]
    root = {"id": "root", "label": centre, "note": (out.get("overview") or "").strip()[:500], "sources": [],
            "children": branches}

    def count(n: dict) -> int:
        return 1 + sum(count(c) for c in n["children"])

    return {
        "title": f"Mind Constellation: {focus[:60] or title}", "focus": focus, "root": root,
        "node_count": count(root), "document_ids": [str(d.id) for d in docs], "post_count": len(docs),
        "covered_count": len(_cited(branches) & {str(d.id) for d in docs}),
    }


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

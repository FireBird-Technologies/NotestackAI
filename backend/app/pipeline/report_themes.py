"""Themes for a report: what a notebook's posts are about, and how much of it each thing is.

A report no longer reads the posts' text to find out. Every post already has its key ideas stored (documents.metadata_json["ideas"],
written by generate.extract_ideas, each with the lines it came from), so those ideas stand for the posts, however many are picked:

  1. one model call (GroupThemes) names themes and says which ideas belong to which (it sees at most MAX_LISTED_IDEAS of them);
  2. code files every other idea into a theme and counts: how many posts and ideas each theme has gives its weight, so the weights
     are true for the whole selection and not for the sample the model saw. A model groups well and counts badly.

The weights decide how much room a theme gets in the report (report_blueprint.py) and how much of the posts' own text it is written
from (report_evidence.py). A theme the reader asked for is moved up a tier whatever its share."""

import logging
import time
import uuid
from collections import Counter
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.config import settings
from app.corpus import Corpus
from app.llm import run
from app.llm.provider import fast_lm
from app.llm.signatures import GroupThemes
from app.models import Document, Job, Notebook, Workspace
from app.pipeline.generate import extract_ideas, ideas_fresh
from app.pipeline.idea_pool import _tokens
from app.pipeline.passages import _body_start, notebook_docs, workspace_docs
from app.services.jobs import update_job
from app.services.plans import effective_plan

log = logging.getLogger(__name__)

SMALL_SELECTION = 5  # posts or fewer: the posts are read whole, as a report always was
MIN_FRESH_SHARE = 0.5  # fewer posts than this with ideas stored: read the posts' text as before
MAX_LISTED_IDEAS = 300  # ideas the model sees; the rest are filed by code
MAX_THEMES = 12
MIN_THEMES = 2
MAJOR_AT, MEDIUM_AT = 0.25, 0.10  # a theme's share of the report: major from, medium from
POST_WEIGHT, IDEA_WEIGHT = 0.6, 0.4  # how many posts mention it counts for more than how many ideas
CATCH_ALL = "More from your posts"
OPENING_LINES = 8  # lines of a post's opening that stand for a post with no ideas stored yet


class ThemesUnavailable(Exception):
    """The ideas did not group into themes: the caller reads the posts as before."""


@dataclass
class Idea:
    id: str
    doc: Document
    label: str
    note: str
    details: list[dict] = field(default_factory=list)
    sources: list[dict] = field(default_factory=list)
    bare: bool = False  # no ideas stored for this post: this is its title and opening


@dataclass
class Theme:
    id: str
    name: str
    summary: str
    ideas: list[Idea]
    asked: bool = False  # the reader's request asks for it
    weight: float = 0.0  # share of the whole, all themes add up to 1
    tier: str = "minor"  # major | medium | minor
    pinned: bool = False  # asked for: always given a deep section

    @property
    def doc_ids(self) -> set[uuid.UUID]:
        return {i.doc.id for i in self.ideas}


# The posts

def select_docs(db: Session, workspace_id: uuid.UUID, notebook_id: uuid.UUID | None, params: dict) -> list[Document]:
    """The posts a report is made from: the ones picked, or the notebook's, newest first. Not cut at ARTIFACT_MAX_POSTS: only
    what the plan indexes (and REPORT_MAX_POSTS, when set) limits it."""
    picked = [uuid.UUID(str(i)) for i in params.get("document_ids") or []]
    nb = db.get(Notebook, notebook_id) if notebook_id else None
    if picked:
        docs = workspace_docs(db, workspace_id, picked)
    elif nb:
        docs = notebook_docs(db, nb.id)
    else:
        docs = []
    cap = effective_plan(db, db.get(Workspace, workspace_id)).indexed_posts
    if settings.report_max_posts > 0:
        cap = min(cap, settings.report_max_posts) if cap and cap > 0 else settings.report_max_posts
    chosen = docs[:cap] if cap and cap > 0 else docs
    log.info("report posts: workspace=%s notebook=%s picked=%d found=%d used=%d plan_cap=%s report_max_posts=%s", workspace_id,
             notebook_id, len(picked), len(docs), len(chosen), cap, settings.report_max_posts)
    if len(chosen) < len(docs):
        log.warning("report posts cut by the plan or REPORT_MAX_POSTS: workspace=%s found=%d used=%d", workspace_id, len(docs),
                    len(chosen))
    return chosen


def ensure_ideas(db: Session, job: Job | None, workspace_id: uuid.UUID, docs: list[Document]) -> None:
    """Extract the ideas of posts that have none yet, together, at most REPORT_INLINE_IDEAS of them. The rest are represented
    by their opening; the background ideas job reaches them later."""
    stale = [d for d in docs if not ideas_fresh(d)]
    if not stale or settings.report_inline_ideas <= 0:
        log.info("report ideas: workspace=%s posts=%d stale=%d inline_limit=%d, nothing extracted now", workspace_id, len(docs),
                 len(stale), settings.report_inline_ideas)
        return
    started = time.monotonic()
    result = extract_ideas(db, job, workspace_id, [str(d.id) for d in stale], parallel=True, limit=settings.report_inline_ideas)
    for d in stale:
        db.refresh(d)
    log.info("report ideas: workspace=%s posts=%d stale=%d extracted=%s skipped=%s left_for_background=%d seconds=%.1f",
             workspace_id, len(docs), len(stale), result.get("extracted"), result.get("skipped"),
             sum(1 for d in stale if not ideas_fresh(d)), time.monotonic() - started)


def fresh_share(docs: list[Document]) -> float:
    return sum(1 for d in docs if ideas_fresh(d)) / max(len(docs), 1)


def _opening_idea(d: Document, di: int, corpus: Corpus) -> Idea:
    """A post with no ideas stored: its title, its topics and where its opening is, so it still counts and can be cited."""
    meta = d.metadata_json or {}
    tags = ", ".join(t["name"] for t in (meta.get("topics") or [])[:3] if t.get("name"))
    try:
        lines = corpus.read_lines(d.path)
    except Exception:
        lines = []
    first = _body_start(lines) + 1 if lines else 1
    sources = [{"path": d.path, "line_start": first, "line_end": min(first + OPENING_LINES, len(lines) or first)}]
    return Idea(id=f"p{di}.0", doc=d, label=d.title[:80], bare=True, sources=sources,
                note=f"Topics: {tags}" if tags else "Only the opening of this post was read.")


def collect_ideas(docs: list[Document], corpus: Corpus) -> list[Idea]:
    """Every post's stored ideas as Ideas with ids like p3.1 (the third post's second idea), or its opening when it has none."""
    out: list[Idea] = []
    for di, d in enumerate(docs):
        stored = [i for i in ((d.metadata_json or {}).get("ideas") or []) if (i.get("label") or "").strip()] \
            if ideas_fresh(d) else []
        if not stored:
            out.append(_opening_idea(d, di, corpus))
            continue
        for ii, i in enumerate(stored):
            out.append(Idea(id=f"p{di}.{ii}", doc=d, label=i["label"].strip(), note=(i.get("note") or "").strip(),
                            details=i.get("details") or [], sources=i.get("sources") or []))
    log.info("report ideas collected: posts=%d ideas=%d posts_with_only_an_opening=%d", len(docs), len(out),
             sum(1 for i in out if i.bare))
    return out


# Themes

def listed_ideas(ideas: list[Idea]) -> list[Idea]:
    """The ideas the model sees: all of them, or when there are too many, the same number from every post in turn."""
    if len(ideas) <= MAX_LISTED_IDEAS:
        return ideas
    by_doc: dict[uuid.UUID, list[Idea]] = {}
    for i in ideas:
        by_doc.setdefault(i.doc.id, []).append(i)
    lists, picked, rank = list(by_doc.values()), [], 0
    while len(picked) < MAX_LISTED_IDEAS and any(rank < len(x) for x in lists):
        for x in lists:
            if rank < len(x) and len(picked) < MAX_LISTED_IDEAS:
                picked.append(x[rank])
        rank += 1
    return picked


def _file_leftovers(themes: list[Theme], leftovers: list[Idea]) -> None:
    """Every idea the model did not place goes to the theme its post's other ideas are mostly in, else the theme whose words it
    shares most, else a catch-all theme: the way the Mind Constellation files what the model leaves out."""
    by_doc: dict[uuid.UUID, Counter] = {}
    for ti, t in enumerate(themes):
        for i in t.ideas:
            by_doc.setdefault(i.doc.id, Counter())[ti] += 1
    theme_words = [_tokens(" ".join([t.name, t.summary] + [i.label for i in t.ideas[:20]])) for t in themes]
    # A word in most themes ("idea", "post") says nothing about which one an idea is about.
    common = {w for w, n in Counter(w for tw in theme_words for w in tw).items() if n > max(1, len(themes) // 2)}
    theme_words = [tw - common for tw in theme_words]
    catch: Theme | None = None
    for idea in leftovers:
        counts = by_doc.get(idea.doc.id)
        if counts:
            themes[counts.most_common(1)[0][0]].ideas.append(idea)
            continue
        words = _tokens(f"{idea.label} {idea.note}") - common
        best, score = max(((ti, len(words & tw)) for ti, tw in enumerate(theme_words)), key=lambda x: x[1])
        if score > 0:
            themes[best].ideas.append(idea)
            continue
        if catch is None:
            catch = Theme(id="", name=CATCH_ALL, summary="Ideas that fit none of the other themes.", ideas=[])
            themes.append(catch)
        catch.ideas.append(idea)
    log.info("report leftover ideas filed: leftovers=%d catch_all=%d", len(leftovers), len(catch.ideas) if catch else 0)


def weigh(themes: list[Theme], total_posts: int, total_ideas: int) -> None:
    """Each theme's share of the whole, from how many posts and ideas it has (not from anything the model said), and its tier. A
    theme the reader asked for moves up one tier and is pinned. If nothing reached major, the heaviest theme becomes major."""
    raw = [POST_WEIGHT * len(t.doc_ids) / max(total_posts, 1) + IDEA_WEIGHT * len(t.ideas) / max(total_ideas, 1) for t in themes]
    total = sum(raw) or 1.0
    for t, r in zip(themes, raw, strict=True):
        t.weight = round(r / total, 4)
        t.tier = "major" if t.weight >= MAJOR_AT else "medium" if t.weight >= MEDIUM_AT else "minor"
    if themes and not any(t.tier == "major" for t in themes):
        max(themes, key=lambda t: t.weight).tier = "major"
    for t in themes:
        if t.asked:
            t.pinned = True
            t.tier = {"minor": "medium", "medium": "major"}.get(t.tier, t.tier)


def _relations(raw: list[dict] | None, themes: list[Theme]) -> list[dict]:
    by_name = {t.name.lower(): t.id for t in themes}
    out = []
    for r in raw or []:
        a, b = by_name.get(str(r.get("a", "")).strip().lower()), by_name.get(str(r.get("b", "")).strip().lower())
        relation = (r.get("relation") or "").strip()
        if a and b and a != b and relation:
            out.append({"a": a, "b": b, "relation": relation[:200]})
    return out[:8]


def group_themes(db: Session, job: Job | None, workspace_id: uuid.UUID, title: str, request: str,
                 ideas: list[Idea]) -> tuple[list[Theme], list[dict]]:
    """Themes with their weights, and how they relate (by theme id). Raises ThemesUnavailable when the answer is not usable."""
    by_id = {i.id: i for i in ideas}
    listed = listed_ideas(ideas)
    listing = [f"{i.id} | {i.label}: {i.note[:140]}" for i in listed]
    log.info("report themes: asking the model workspace=%s ideas=%d listed=%d (cap %d) posts=%d", workspace_id, len(ideas),
             len(listed), MAX_LISTED_IDEAS, len({i.doc.id for i in ideas}))
    started = time.monotonic()
    out = run.predict(GroupThemes, db=db, workspace_id=workspace_id, job=job, lm=fast_lm(), title=title,
                      request=request, ideas=listing)
    themes: list[Theme] = []
    taken: set[str] = set()
    dropped = 0
    for t in out.get("themes") or []:
        name = (t.get("name") or "").strip()
        wanted = list(t.get("idea_ids") or [])
        mine = [by_id[i] for i in wanted if i in by_id and i not in taken]
        dropped += len(wanted) - len(mine)  # unknown ids, or ideas another theme already took
        if not name or not mine:
            log.info("report theme skipped: name=%r usable_ideas=%d", name, len(mine))
            continue
        taken.update(i.id for i in mine)
        themes.append(Theme(id="", name=name[:80], summary=(t.get("summary") or "").strip()[:400], ideas=mine,
                            asked=bool(t.get("matches_request"))))
        if len(themes) == MAX_THEMES:
            break
    log.info("report themes: model answered themes=%d usable=%d ids_dropped=%d seconds=%.1f", len(out.get("themes") or []),
             len(themes), dropped, time.monotonic() - started)
    if len(themes) < MIN_THEMES:
        log.warning("report themes unusable: usable=%d needed=%d", len(themes), MIN_THEMES)
        raise ThemesUnavailable("the ideas did not group into themes")
    _file_leftovers(themes, [i for i in ideas if i.id not in taken])
    for n, t in enumerate(themes, start=1):
        t.id = f"t{n}"
    weigh(themes, len({i.doc.id for i in ideas}), len(ideas))
    relations = _relations(out.get("relations"), themes)
    for t in themes:
        log.info("report theme: id=%s name=%r weight=%.3f tier=%s asked=%s pinned=%s posts=%d ideas=%d", t.id, t.name, t.weight,
                 t.tier, t.asked, t.pinned, len(t.doc_ids), len(t.ideas))
    log.info("report theme relations: model=%d kept=%d", len(out.get("relations") or []), len(relations))
    return themes, relations


def theme_summary(t: Theme) -> dict:
    """What is kept with the report about a theme."""
    return {"id": t.id, "name": t.name, "summary": t.summary, "weight": t.weight, "tier": t.tier, "pinned": t.pinned,
            "posts": len(t.doc_ids), "ideas": len(t.ideas)}


def progress(db: Session, job: Job | None, value: float, message: str) -> None:
    if job:
        update_job(db, job, progress=value, message=message)

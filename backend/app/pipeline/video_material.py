"""What a video made from a whole notebook (or the archive) on one topic reads: found the way the notebook chat finds an
answer (research.py), then handed to blog2video as plain text.

1. Keyword prefetch: BM25 over the notebook's post passages (prefetch.py). When they cover the topic's words
   (FAST_PATH_MIN_COVERAGE of all of them), they are the material, no model call.
2. Otherwise the chat's research agent (list_files, search, read) looks for it; the sections around the lines it cites
   are the material.
3. Nothing found: an overview of every post in the notebook (its summary, then each post's opening, all given an equal
   share so the oldest posts count as much as the newest). One small call decides whether
   the topic still belongs with the notebook (a broad "my biggest lessons", or a theme it touches without the words): the
   overview is framed around it. A topic the notebook does not deal with is dropped: a plain overview.
"""

import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Literal

from sqlalchemy.orm import Session

from app.corpus import Corpus
from app.llm import run
from app.llm.provider import fast_lm
from app.llm.signatures import TopicFitsNotebook
from app.models import Document, Notebook
from app.pipeline.prefetch import DEEP_PER_POST, DEEP_TOP_K, Prefetch, passages_of, prefetch
from app.pipeline.research import FAST_PATH_MIN_COVERAGE, research

log = logging.getLogger(__name__)

CITED_BUDGET_CHARS = 40_000  # the sections around the agent's citations
OVERVIEW_BUDGET_CHARS = 60_000  # every post's opening together, for an overview video
OVERVIEW_MIN_CHARS = 250  # the least of a post's opening kept, however many posts the notebook has
TITLES_SHOWN = 150  # post titles the relevance check reads
_HEADER = re.compile(r"^\S+ lines \d+-\d+ \((.*)\)$")
_LINE_NO = re.compile(r"^\d+\| ?")


@dataclass
class TopicMaterial:
    text: str  # plain text, each stretch headed by "# Post title"
    mode: Literal["focused", "themed_overview", "overview"]
    path: Literal["fast", "agent", "overview"]
    paths: list[str] = field(default_factory=list)  # the posts it came from
    angle: str = ""  # themed_overview: how the topic connects to the notebook


def plain(rendered: str) -> str:
    """Rendered passages (`path lines a-b (Title › Heading)` then `n| text` lines) as plain text: the line numbers are for
    citing, which blog2video never does."""
    out = []
    for line in rendered.splitlines():
        if m := _HEADER.match(line):
            out.append(f"# {m.group(1)}")
        else:
            out.append(_LINE_NO.sub("", line, count=1))
    return "\n".join(out).strip()


def _cited(corpus: Corpus, allowed: dict[str, str], citations) -> tuple[str, list[str]]:
    """The passages holding the agent's cited lines, with the rest of their sections, under CITED_BUDGET_CHARS."""
    picked, seen, used = [], set(), 0
    by_path: dict[str, list] = {}
    for c in citations:
        if c.path not in allowed:
            continue  # a chat memory file: not a post
        passages = by_path.setdefault(c.path, passages_of(corpus, c.path, allowed[c.path]))
        for p in passages:
            if p.end < c.line_start or p.start > c.line_end:
                continue
            for q in p.section or [p]:
                if id(q) in seen or used + len(q.render()) > CITED_BUDGET_CHARS:
                    continue
                seen.add(id(q))
                used += len(q.render())
                picked.append((1.0, q))
    return Prefetch(passages=picked).text if picked else "", list(dict.fromkeys(p.path for _, p in picked))


def _cut(text: str, limit: int) -> str:
    """The start of a text, cut on a word boundary."""
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "..."


def overview(corpus: Corpus, allowed: dict[str, str], summary: str = "") -> str:
    """The whole notebook in brief: its summary, then every post's title and opening, each post given an equal share of
    OVERVIEW_BUDGET_CHARS (at least OVERVIEW_MIN_CHARS), so a large notebook is covered end to end rather than its
    newest posts only."""
    share = max(OVERVIEW_BUDGET_CHARS // max(len(allowed), 1), OVERVIEW_MIN_CHARS)
    parts = [f"# About this notebook\n{summary.strip()}"] if summary.strip() else []
    for rel, title in allowed.items():
        opening = ""
        for p in passages_of(corpus, rel, title):  # its first passages, until its share is used
            body = plain(p.render()).split("\n", 1)[-1].strip()
            opening = f"{opening}\n{body}".strip()
            if len(opening) >= share:
                break
        parts.append(f"# {title}\n{_cut(opening, share)}".strip())
    return "\n\n".join(parts)


def _fits(db: Session, workspace_id: uuid.UUID, topic: str, notebook: Notebook | None, titles: list[str],
          topic_names: list[str]) -> tuple[bool, str]:
    """Does a topic no post is about still belong with the notebook? A failed call says no: a plain overview."""
    try:
        out = run.predict(TopicFitsNotebook, db=db, workspace_id=workspace_id, lm=fast_lm(), topic=topic,
                          notebook_title=(notebook.title if notebook else "") or "",
                          notebook_summary=(notebook.summary if notebook else "") or "",
                          post_titles=titles[:TITLES_SHOWN], topic_names=topic_names)
    except Exception:
        log.warning("Video topic check failed: making a plain overview", exc_info=True)
        return False, ""
    return out.get("verdict") == "related", re.sub(r"\s+", " ", str(out.get("angle") or "")).strip()[:300]


def topic_material(db: Session, workspace_id: uuid.UUID, notebook: Notebook | None, docs: list[Document], topic: str,
                   *, suggested: bool = False, topic_names: list[str] | None = None) -> TopicMaterial:
    """The material for a video on `topic` from these posts (newest first). `suggested`: one of the notebook's own focus
    cards, which always belongs with it."""
    corpus = Corpus(workspace_id)
    allowed = {d.path: d.title for d in docs if d.path}
    manifest = corpus.sync(tuple(allowed))
    try:
        pre = prefetch(corpus, allowed, manifest, topic, DEEP_TOP_K, DEEP_PER_POST)
    except Exception:  # a ranking problem only costs the head start, as in the chat
        log.warning("Video prefetch failed", exc_info=True)
        pre = None

    # Coverage of all the topic's words, not only of those found somewhere in the notebook as in the chat: "my first
    # hire and team culture" is not covered by a post that only mentions a first hire.
    covered = pre.coverage * len(pre.terms) / len(pre.asked) if pre is not None and pre.asked else 0.0
    if pre is not None and pre.passages and covered >= FAST_PATH_MIN_COVERAGE:
        log.info("video material: fast path, topic %r covered %.0f%% by %d passage(s)", topic, covered * 100,
                 len(pre.passages))
        return TopicMaterial(plain(pre.text), "focused", "fast",
                             list(dict.fromkeys(p.path for _, p in pre.passages)))

    if pre is None or not pre.overview:  # some of its words are in the posts: the agent looks for it
        try:
            res = research(corpus, allowed, f"What do my posts say about {topic}? Cover everything they say about it.",
                           notebook_title=notebook.title if notebook else "")
            cites = [] if res.unsupported else res.citations
        except Exception:
            log.warning("Video research agent failed", exc_info=True)
            cites = []
        text, paths = _cited(corpus, allowed, cites)
        if text:
            extra = plain(pre.text) if pre is not None and pre.passages else ""
            log.info("video material: research agent, %d citation(s) in %d post(s)", len(cites), len(paths))
            return TopicMaterial("\n\n".join(t for t in (plain(text), extra) if t), "focused", "agent", paths)

    text = overview(corpus, allowed, (notebook.summary if notebook else "") or "")
    if suggested:
        related, angle = True, ""
    else:
        related, angle = _fits(db, workspace_id, topic, notebook, list(allowed.values()), topic_names or [])
    log.info("video material: nothing found for %r, %s overview", topic, "themed" if related else "plain")
    return TopicMaterial(text, "themed_overview" if related else "overview", "overview", list(allowed), angle)

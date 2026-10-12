"""Flashcards (always) and quizzes (above ARTIFACT_MAX_POSTS posts) from the ideas already extracted from each post, the same stored
ideas the Mind Constellation is drawn from. Instead of sending post text, a small random sample of those ideas goes to the model: each
as one line with the post and the lines it came from, so the model can cite them and the existing check can verify the lines.
Nothing here extracts anything and no post text is read: a post with no stored ideas yet is represented by a short opening, at most
a few of them. A sample of ARTIFACT_IDEA_SAMPLE ideas is about 1,500 tokens whatever the size of the selection."""

import math
import random
import re
import uuid

from sqlalchemy.orm import Session

from app.config import settings
from app.corpus import Corpus
from app.models import Document
from app.pipeline.generate import ideas_fresh
from app.pipeline.passages import passages_for

IDEAS_PER_POST = 2  # so a few posts cannot fill the sample (more when the selection is small, to fill it)
OPENING_BUDGET = 800  # characters of a post's opening, for a post with no stored ideas
MAX_OPENINGS = 3  # posts with no stored ideas represented by their opening
CHAT_BUDGET = 12_000  # characters of chat transcripts kept (the end of each) when chats are picked as well

FORMAT_NOTE = ("Each item below is a key idea from one post, written as: IDEA [path lines a-b] label: note. The path and lines say "
               "where in the post the idea comes from. When a question or card comes from an idea, cite that path and those lines.")

_STOP = {"the", "and", "for", "with", "that", "this", "from", "how", "what", "why", "are", "was", "about", "your", "you",
         "into", "over", "does", "can", "not", "but", "all", "any", "its", "their", "them", "will", "have", "has"}


def _tokens(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]{3,}", (text or "").lower()) if w not in _STOP}


def has_ideas(docs: list[Document]) -> int:
    """How many of the posts have their ideas stored and current."""
    return sum(1 for d in docs if ideas_fresh(d))


def _line(doc: Document, idea: dict) -> str:
    """One stored idea as one line, tagged with where it came from (its first cited range, when it has one)."""
    where = doc.path
    for ref in idea.get("sources") or []:
        try:
            a, b = int(ref["line_start"]), int(ref["line_end"])
        except (KeyError, TypeError, ValueError):
            continue
        where = f"{doc.path} lines {a}-{max(a, b)}"
        break
    label, note = (idea.get("label") or "").strip(), (idea.get("note") or "").strip()
    return f"IDEA [{where}] {label}: {note}"


def sample(db: Session, workspace_id: uuid.UUID, docs: list[Document], topic: str = "", chats: list[str] | None = None,
           size: int | None = None, rng: random.Random | None = None) -> list[str]:
    """The material for one call: the format note, a random sample of the posts' stored ideas, a few short openings for posts with
    none, and the end of any chats. With a topic, ideas that match it come first. A fresh draw each time unless `rng` is given."""
    rng = rng or random.Random()
    size = size or max(settings.artifact_idea_sample, 1)
    wanted = _tokens(topic)
    have = [d for d in docs if ideas_fresh(d)]
    per_post = max(IDEAS_PER_POST, math.ceil(size / max(len(have), 1)))
    matching: list[tuple[Document, dict]] = []
    rest: list[tuple[Document, dict]] = []
    for d in have:
        mine = [i for i in (d.metadata_json or {}).get("ideas") or [] if (i.get("label") or "").strip()]
        rng.shuffle(mine)
        for idea in mine[:per_post]:
            hit = wanted and wanted & _tokens(" ".join([idea.get("label", ""), idea.get("note", ""), d.title]))
            (matching if hit else rest).append((d, idea))
    rng.shuffle(matching)
    rng.shuffle(rest)
    chosen = (matching + rest)[:size]
    rng.shuffle(chosen)  # not grouped by relevance or by post
    out = [FORMAT_NOTE] + [_line(d, i) for d, i in chosen]
    bare = [d for d in docs if not ideas_fresh(d)]
    if bare:
        corpus = Corpus(workspace_id)
        for d in rng.sample(bare, min(MAX_OPENINGS, len(bare))):
            out.extend(passages_for(corpus, [d], budget_chars=OPENING_BUDGET))
    if chats:
        share = CHAT_BUDGET // len(chats)
        out += [t[-share:] for t in chats]
    return out

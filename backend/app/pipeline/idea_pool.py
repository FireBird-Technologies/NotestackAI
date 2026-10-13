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
from app.corpus import Corpus, CorpusError
from app.models import Document
from app.pipeline.generate import ideas_fresh
from app.pipeline.passages import _body_start

IDEAS_PER_POST = 2  # so a few posts cannot fill the sample (more when the selection is small, to fill it)
OPENING_BUDGET = 800  # characters of one random stretch of a post, for a post with no stored ideas
MAX_OPENINGS = 3  # posts with no stored ideas represented by a random stretch of their text
CHAT_BUDGET = 12_000  # characters of chat transcripts kept (the end of each) when chats are picked as well

FORMAT_NOTE = ("Each item below is a key idea from one post, written as: IDEA [path lines a-b] label: note. The path and lines say "
               "where in the post the idea comes from. When a question or card comes from an idea, cite that path and those lines. "
               "An item that starts with FILE is a stretch of a post's own text, each line numbered `n|`: cite its path and those numbers.")

TEXT_NOTE = ("Each item below is a stretch of one post's own text: its path, then lines numbered `n|`. For every item you write, "
             "give sources: the path and the line numbers (line_start, line_end) of the lines it comes from.")

FOCUS_SHARE = 0.7  # when the writer names a post: this share of the material is that post, the rest the other posts
FOCUS_CHUNKS = 3  # stretches of text from each named post, on top of all of its stored ideas (a post stores at most 8)
CHUNK_BUDGET = 1400  # characters in one stretch
SMALL_SELECTION = 2  # this many posts or fewer: read their text, not their (at most 8 each) stored ideas
SMALL_TOTAL = 10_000  # characters of text in all for such a selection
_ONLY = {"only", "just", "solely", "exclusively"}

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


def shared_notes(material: list[str]) -> int:
    """How many leading items are a note for the model, which every half of a split gets, not material to deal out."""
    return 1 if material and material[0] in (FORMAT_NOTE, TEXT_NOTE) else 0


def mentioned(docs: list[Document], topic: str) -> list[Document]:
    """The posts the writer's focus names: its whole title in the text, or most of the title's words (a one word title must be a
    real word). "mostly the Overhang post" names The Overhang. Plain words that name no post name none."""
    text, wanted = (topic or "").lower(), _tokens(topic)
    if not wanted:
        return []
    out = []
    for d in docs:
        title = _tokens(d.title)
        whole = len((d.title or "").strip()) >= 4 and (d.title or "").strip().lower() in text
        most = title and len(title & wanted) / len(title) >= 0.6 and (len(title) >= 2 or max(map(len, title)) >= 5)
        if whole or most:
            out.append(d)
    return out


def _only(topic: str) -> bool:
    """"only this post", "just the Overhang": the named posts and nothing else."""
    return bool(_ONLY & set(re.findall(r"[a-z]+", (topic or "").lower())))


def _chunks(corpus: Corpus, doc: Document, count: int, budget: int, rng: random.Random) -> list[str]:
    """`count` stretches of one post, each from a different part of it (the post is cut into `count` parts, one stretch from each)."""
    out = [c for i in range(count) if (c := _random_chunk(corpus, doc, budget, rng, part=(i, count)))]
    return out


def spread_text(workspace_id: uuid.UUID, docs: list[Document], topic: str = "", rng: random.Random | None = None,
                total: int = SMALL_TOTAL) -> list[str]:
    """For one or two posts: their own text instead of their few stored ideas, as stretches from all over each post, a fresh
    draw each time. A post the focus names gets FOCUS_SHARE of it (all of it when the focus says only/just)."""
    rng = rng or random.Random()
    corpus = Corpus(workspace_id)
    focus = mentioned(docs, topic)
    others = [d for d in docs if d not in focus]
    if not focus or not others:
        shares = {d.id: 1 / max(len(docs), 1) for d in docs}
    elif _only(topic):
        shares = {d.id: 1 / len(focus) for d in focus}
    else:
        shares = {**{d.id: FOCUS_SHARE / len(focus) for d in focus}, **{d.id: (1 - FOCUS_SHARE) / len(others) for d in others}}
    out: list[str] = [TEXT_NOTE]
    for d in docs:
        if d.id in shares:
            out += _chunks(corpus, d, max(1, round(total * shares[d.id] / CHUNK_BUDGET)), CHUNK_BUDGET, rng)
    return out


def _random_chunk(corpus: Corpus, doc: Document, budget: int, rng: random.Random, part: tuple[int, int] = (0, 1)) -> str | None:
    """A stretch of the post from anywhere in its body, not only the start: whole lines from a random one, numbered as in the
    file so a cited line is still the right one. A fresh stretch each time, so two sets from one post cover different parts."""
    try:
        lines = corpus.read_lines(doc.path)
    except CorpusError:
        return None
    first = _body_start(lines)
    body = [n for n, line in enumerate(lines, start=1) if n > first and line.strip()]
    if not body:
        return None
    i, of = part  # begin somewhere in the i-th of `of` equal parts of the post
    lo, hi = len(body) * i // of, max(len(body) * (i + 1) // of, len(body) * i // of + 1)
    start = rng.randrange(lo, min(hi, len(body)))
    out, used = [], 0
    for n in body[start:] + body[:start]:  # runs on from the end of the post back to its start if the budget is not used up
        entry = f"{n}| {lines[n - 1]}"
        if out and used + len(entry) > budget:
            break
        out.append(entry[:budget])
        used += len(entry) + 1
    return f"FILE {doc.path} ({doc.title})\n" + "\n".join(out)


def sample(db: Session, workspace_id: uuid.UUID, docs: list[Document], topic: str = "", chats: list[str] | None = None,
           size: int | None = None, rng: random.Random | None = None) -> list[str]:
    """The material for one call: the format note, a random sample of the posts' stored ideas, a few short openings for posts with
    none, and the end of any chats. With a topic, ideas that match it come first. A fresh draw each time unless `rng` is given."""
    rng = rng or random.Random()
    size = size or max(settings.artifact_idea_sample, 1)
    wanted = _tokens(topic)
    focus = mentioned(docs, topic)  # posts the writer named: all their ideas and some of their text, the others fill the rest
    only = bool(focus) and _only(topic)
    have = [d for d in docs if ideas_fresh(d) and d not in focus]
    per_post = max(IDEAS_PER_POST, math.ceil(size / max(len(have), 1)))
    matching: list[tuple[Document, dict]] = []
    rest: list[tuple[Document, dict]] = []
    named: list[tuple[Document, dict]] = []
    for d in docs:
        if not ideas_fresh(d) or (only and d not in focus):
            continue
        mine = [i for i in (d.metadata_json or {}).get("ideas") or [] if (i.get("label") or "").strip()]
        rng.shuffle(mine)
        if d in focus:
            named += [(d, i) for i in mine]
            continue
        for idea in mine[:per_post]:
            hit = wanted and wanted & _tokens(" ".join([idea.get("label", ""), idea.get("note", ""), d.title]))
            (matching if hit else rest).append((d, idea))
    rng.shuffle(matching)
    rng.shuffle(rest)
    room = size if not focus else max(round(size * (1 - FOCUS_SHARE)), 0)  # what the other posts may fill
    chosen = named + (matching + rest)[:room]
    rng.shuffle(chosen)  # not grouped by relevance or by post
    out = [FORMAT_NOTE] + [_line(d, i) for d, i in chosen]
    corpus = Corpus(workspace_id) if (focus or any(not ideas_fresh(d) for d in docs)) else None
    for d in focus:  # a post stores few ideas: the named one also gives stretches of its own text
        out += _chunks(corpus, d, FOCUS_CHUNKS, CHUNK_BUDGET, rng)
    bare = [d for d in docs if not ideas_fresh(d) and d not in focus and not only]
    if bare:
        for d in rng.sample(bare, min(MAX_OPENINGS, len(bare))):
            chunk = _random_chunk(corpus, d, OPENING_BUDGET, rng)
            if chunk:
                out.append(chunk)
    if chats:
        share = CHAT_BUDGET // len(chats)
        out += [t[-share:] for t in chats]
    return out

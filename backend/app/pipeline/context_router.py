"""What the answer writer reads, decided by the notebook's size (CHAT_ROUTER).

Tier A: the notebook fits CHAT_FULL_NOTEBOOK_TOKENS, so every post goes into the prompt with its line numbers. There
        is nothing to search, so nothing can be missed.
Tier B: a bigger notebook. The question and a few rewordings (one fast-model call) are ranked against the posts'
        passages and cards (prefetch.retrieve), and the best posts go in whole while they fit CHAT_EVIDENCE_TOKENS,
        otherwise their matching sections. A question about the notebook as a whole gets every post's card instead.
Tier C: the research agent (research.py), only when the writer could not answer from A or B.

Everything here reads the local disk cache (sync first) and makes at most one model call (expand_query)."""

import logging
from dataclasses import dataclass, field
from pathlib import PurePosixPath

import dspy

from app.config import settings
from app.corpus import Corpus, CorpusError
from app.llm.provider import fast_lm, track_usage
from app.pipeline.passages import _body_start
from app.pipeline.prefetch import Passage, Retrieval, _render, openings

log = logging.getLogger(__name__)

CHARS_PER_TOKEN = 4  # a rough English average: the budgets are guards, not exact counts
MAX_POSTS = 10  # Tier B never sends more posts than this, however small they are
WHOLE_POST_SHARE = 0.5  # a post is sent whole only if it takes at most this share of the budget
MIN_ROOM_CHARS = 600  # stop filling when less than this is left
AGENT_PREFETCH_CHARS = 12_000  # what of Tier B's evidence the agent is handed when it takes over


def newest_first(allowed: dict[str, str]) -> list[tuple[str, str]]:
    """Posts by the date in their file name (sources/<site>/<yyyy-mm-dd>-<slug>.md), newest first."""
    return sorted(allowed.items(), key=lambda item: PurePosixPath(item[0]).name, reverse=True)


def notebook_tokens(corpus: Corpus, allowed: dict[str, str]) -> int:
    total = 0
    for path in allowed:
        try:
            total += corpus._local(path).stat().st_size
        except (OSError, CorpusError):
            continue
    return total // CHARS_PER_TOKEN


def numbered_post(corpus: Corpus, path: str, title: str) -> str:
    """One post as the writer reads it: a FILE line, then its body with real line numbers (citable)."""
    try:
        lines = corpus.read_lines(path)
    except CorpusError:
        return ""
    first = _body_start(lines)
    body = "\n".join(f"{n}| {line}" for n, line in enumerate(lines, start=1) if n > first and line.strip())
    return f"FILE {path} ({title})\n{body}"


def tier_a_evidence(corpus: Corpus, allowed: dict[str, str]) -> str:
    """Every post, newest first. The notebook text comes first in the prompt so a provider's prefix cache can reuse
    it for the next question in the same notebook."""
    posts = [numbered_post(corpus, path, title) for path, title in newest_first(allowed)]
    return "All posts in this notebook (citable, with line numbers):\n\n" + "\n\n".join(p for p in posts if p)


@dataclass
class Evidence:
    text: str = ""
    posts: list[str] = field(default_factory=list)  # posts that went in, in order
    whole: int = 0  # how many of them went in whole


def tier_b_evidence(corpus: Corpus, allowed: dict[str, str], found: Retrieval, budget_chars: int) -> Evidence:
    """The best posts, whole while they fit; otherwise each one's matching sections (with the passages around)."""
    out = Evidence()
    parts: list[str] = []
    room = budget_chars
    for path in found.posts[:MAX_POSTS]:
        if room < MIN_ROOM_CHARS:
            break
        title = allowed.get(path, path)
        whole = numbered_post(corpus, path, title)
        if whole and len(whole) <= room and len(whole) <= budget_chars * WHOLE_POST_SHARE:
            parts.append(whole)
            room -= len(whole)
            out.posts.append(path)
            out.whole += 1
            continue
        sections: list[str] = []
        seen: set[int] = set()
        for p in found.passages.get(path, []):
            run: list[Passage] = [q for q in (p.section or [p]) if id(q) not in seen]
            text = _render(run) if run else ""
            if not text:
                continue
            if len(text) > room:  # a long section: the match and its neighbour only
                run = [q for q in [p, p.next] if q is not None and id(q) not in seen]
                text = _render(run)
                if len(text) > room:
                    continue
            sections.append(text)
            seen.update(id(q) for q in run)
            room -= len(text)
        if sections:
            parts.append(f"From {path} ({title}):\n" + "\n\n".join(sections))
            out.posts.append(path)
    out.text = "\n\n".join(parts)
    return out


def overview_evidence(corpus: Corpus, allowed: dict[str, str], cards: dict[str, dict], budget_chars: int) -> str:
    """For a question about the notebook as a whole: every post's card (to see what each post is about) and the
    openings of the newest posts (what an answer can cite)."""
    rows = []
    for path, title in newest_first(allowed):
        card = cards.get(path)
        if card:
            rows.append(f"- {path} | {title} | {card.get('summary', '')} | topics: {', '.join(card.get('topics') or [])}")
        else:
            rows.append(f"- {path} | {title}")
    listing = "\n".join(rows)[: budget_chars // 2]
    room = max(budget_chars - len(listing), MIN_ROOM_CHARS)
    return ("What every post is about (post cards: NOT citable, use them to see the whole notebook):\n" + listing
            + "\n\nThe opening passage of the newest posts (citable, with line numbers):\n\n"
            + openings(corpus, newest_first(allowed), room))


class ExpandQuery(dspy.Signature):
    """Turn a writer's chat message into searches over their own posts. standalone: the message as a full question
    (resolve "it", "that" or "why" from the conversation). keywords: 3 to 5 short searches in other words a post might
    use for the same thing: synonyms, the plain-language version, related terms, spelling variants of names."""

    message: str = dspy.InputField()
    conversation: str = dspy.InputField()
    standalone: str = dspy.OutputField()
    keywords: list[str] = dspy.OutputField()


def expand_query(message: str, conversation: str) -> tuple[list[str], int, int]:
    """[standalone question, keyword searches...], with the tokens used. Raises on failure; the caller then searches
    with the message alone."""
    lm = fast_lm()
    with track_usage(lm) as usage, dspy.context(lm=lm):
        pred = dspy.Predict(ExpandQuery)(message=message, conversation=conversation,
                                         config={"timeout": settings.chat_fast_timeout_seconds})
    queries = [(pred.standalone or "").strip(), *[str(k).strip() for k in (pred.keywords or [])][:5]]
    return [q for q in dict.fromkeys(queries) if q], usage.prompt_tokens, usage.completion_tokens

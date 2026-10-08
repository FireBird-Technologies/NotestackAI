"""The evidence a themed report section is written from. Plain code, no model.

A section is about one or more themes (report_themes.py) and its depth (report_blueprint.py) says how much room it has. What
the writer gets, from the posts that have ideas in those themes:

  - the posts that say the most about them (most of the section's themes first, then most ideas) as the writer wrote them: numbered
    lines taken from around the lines the ideas came from, with the start of the post for context; a short post that is mostly about
    the theme goes in whole. Several posts, each with an equal share, so a section blends posts and does not walk through one;
  - every other post in the themes as the short summaries already stored for it (label, note, points, and the lines to cite);
  - nothing raw for a brief section: summaries only.

Nothing is cited in the report, so the text carries no line numbers and no paths: a post is named by its title."""

import logging
import math
import uuid
from dataclasses import dataclass, field

from app.corpus import Corpus
from app.models import Document
from app.pipeline.passages import _body_start
from app.pipeline.report_blueprint import Section
from app.pipeline.report_themes import Idea, Theme

BUDGETS = {"deep": 32_000, "standard": 16_000, "brief": 4_000}  # characters of evidence (about 8k, 4k and 1k tokens)
RAW_POSTS = {"deep": 5, "standard": 3, "brief": 0}  # posts read as written, at most
RAW_SHARE = 0.75  # of the budget when other posts are summarised too
WHOLE_POST_CHARS = 10_000  # a post this short, mostly about the theme, goes in whole (about 2,500 tokens)
WHOLE_POST_SHARE = 0.5
MARGIN = 6  # lines kept around the lines an idea came from
LEAD_LINES = 6  # lines kept from the start of a post, for context
JOIN_GAP = 2  # windows this close are one
SUMMARY_DETAILS = 2

log = logging.getLogger(__name__)


@dataclass
class Evidence:
    blocks: list[str] = field(default_factory=list)
    posts: list[str] = field(default_factory=list)  # paths of every post used
    raw_posts: int = 0  # how many of them were read as written


def _merge(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for a, b in sorted(ranges):
        if out and a <= out[-1][1] + JOIN_GAP:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _text(lines: list[str], a: int, b: int) -> list[str]:
    return [lines[n - 1] for n in range(a, min(b, len(lines)) + 1) if lines[n - 1].strip()]


def _idea_ranges(d: Document, ideas: list[Idea], total: int, first: int) -> list[tuple[int, int]]:
    out = []
    for idea in ideas:
        for s in idea.sources:
            try:
                a, b = int(s["line_start"]), int(s["line_end"])
            except (KeyError, TypeError, ValueError):
                continue
            if s.get("path") == d.path and total:
                out.append((max(first + 1, a - MARGIN), min(total, max(a, b) + MARGIN)))
    return out


def raw_post(corpus: Corpus, d: Document, ideas: list[Idea], names: list[str], cap: int) -> str | None:
    """One post as written: the whole of it when it is short and mostly about the section's themes, else the lead and the windows
    around its ideas' lines, merged, cut to `cap` characters (the windows that fit, in order of the post). None if unreadable."""
    try:
        lines = corpus.read_lines(d.path)
    except Exception:
        log.warning("report evidence: cannot read post %s, its summary stands in", d.path, exc_info=True)
        return None
    first = _body_start(lines)  # lines before this are the file's header
    head = f"POST {d.title} [themes: {', '.join(names)}]"
    stored = len((d.metadata_json or {}).get("ideas") or []) or 1
    if len(d.clean_text or "") <= WHOLE_POST_CHARS and len(ideas) / stored >= WHOLE_POST_SHARE:
        whole = "\n".join(_text(lines, first + 1, len(lines)))
        if len(head) + len(whole) <= cap:
            log.debug("report evidence: whole post %s (%d chars)", d.path, len(whole))
            return f"{head}\n{whole}"
    ranges = _idea_ranges(d, ideas, len(lines), first)
    windows = _merge([(first + 1, min(len(lines), first + LEAD_LINES))] + ranges)
    parts, used = [], len(head)
    for a, b in windows:
        text = "\n".join(_text(lines, a, b))
        if not text:
            continue
        if parts and used + len(text) + 6 > cap:
            break
        parts.append(text[: max(cap - used, 200)] if not parts else text)
        used += len(parts[-1]) + 6
    return f"{head}\n" + "\n[...]\n".join(parts) if parts else None


def _summary_line(idea: Idea, theme_name: str) -> str:
    points = "; ".join(f"{x.get('label', '')}: {x.get('note', '')}".strip(": ") for x in idea.details[:SUMMARY_DETAILS]
                       if isinstance(x, dict))
    return f'- {idea.label}: {idea.note}' + (f" ({points})" if points else "") + f' (from "{idea.doc.title}", {theme_name})'


def build(corpus: Corpus, section: Section, themes: dict[str, Theme], budget: int | None = None) -> Evidence:
    """The evidence for one body or synthesis section: raw posts first, then summaries of the rest, within `budget` characters."""
    budget = budget or BUDGETS.get(section.depth, BUDGETS["standard"])
    items: list[tuple[Theme, Idea]] = [(themes[t], i) for t in section.theme_ids if t in themes for i in themes[t].ideas]
    out = Evidence()
    if not items:
        log.warning("report evidence: section=%r has no ideas (themes %s)", section.heading, section.theme_ids)
        return out
    by_doc: dict[uuid.UUID, list[tuple[Theme, Idea]]] = {}
    for t, i in items:
        by_doc.setdefault(i.doc.id, []).append((t, i))

    def key(entries: list[tuple[Theme, Idea]]) -> tuple:
        d = entries[0][1].doc
        stamp = d.published_at.timestamp() if d.published_at else 0
        return (-len({t.id for t, _ in entries}), -len(entries), -stamp)

    ranked = sorted(by_doc.values(), key=key)
    wanted = RAW_POSTS.get(section.depth, 0)
    raw_budget = (budget if len(ranked) <= wanted else int(budget * RAW_SHARE)) if wanted else 0
    each = raw_budget // max(min(wanted, len(ranked)), 1)
    rest: list[list[tuple[Theme, Idea]]] = []
    for entries in ranked:
        if out.raw_posts < wanted:
            d = entries[0][1].doc
            names = list(dict.fromkeys(t.name for t, _ in entries))
            block = raw_post(corpus, d, [i for _, i in entries], names, each)
            if block is not None:  # an unreadable post is passed over: the next one takes its place, its summary stands in
                out.blocks.append(block)
                out.posts.append(d.path)
                out.raw_posts += 1
                continue
        rest.append(entries)

    summary_budget = max(budget - sum(len(b) for b in out.blocks), 0)
    lists = [[_summary_line(i, t.name) for t, i in entries] for entries in rest]
    lines, used, rank = [], 0, 0
    while any(rank < len(x) for x in lists):
        for x in lists:
            if rank < len(x) and used + len(x[rank]) <= summary_budget:
                lines.append(x[rank])
                used += len(x[rank]) + 1
        rank += 1
        if used >= summary_budget:
            break
    if lines:
        out.blocks.append("SUMMARIES of other posts\n" + "\n".join(lines))
    out.posts += [e[0][1].doc.path for e in rest if e[0][1].doc.path not in out.posts]
    log.info("report evidence: section=%r depth=%s themes=%s ideas=%d posts=%d raw_posts=%d summarised_posts=%d summary_lines=%d "
             "chars=%d budget=%d", section.heading, section.depth, section.theme_ids, len(items), len(by_doc), out.raw_posts,
             len(rest), len(lines), sum(len(b) for b in out.blocks), budget)
    return out


def scale_budgets(sections: list[Section], total: int) -> dict[str, int]:
    """Section heading -> budget, the standard budgets scaled down together when they add up to more than `total`."""
    wanted = {s.heading: BUDGETS.get(s.depth, BUDGETS["standard"]) for s in sections if s.role in ("body", "synthesis")}
    factor = min(1.0, total / max(sum(wanted.values()), 1))
    return {h: max(int(math.floor(b * factor)), 1_000) for h, b in wanted.items()}

"""Reports: a written document (or an interactive one, with visuals) made from a notebook's posts or chats.

Every report is stored as `blocks`, even a plain document (a few prose blocks), so the same page can show, extend and
share either kind. Each block is {"id", "type", ...}: `prose` has Markdown `text`. A report cites nothing: it carries the
list of the posts it was made from (`sources`) and the instructions it was written to (`instructions`), which the page shows
together in a drop-down. (`citations` stays in the content, empty, for the older reports that have them.)"""

import logging
import re
import time
import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.corpus import Corpus
from app.infographics.themes import theme_id
from app.llm import run
from app.llm.provider import report_lm, report_section_lm
from app.llm.signatures import (
    PlanInteractiveReport,
    WriteReport,
    WriteReportSection,
    WriteThemedReport,
    WriteThemedSection,
)
from app.models import Artifact, Document, Job, Notebook
from app.pipeline import report_blueprint, report_evidence, report_themes
from app.pipeline.flashcards import make_cards
from app.pipeline.generate import NothingToDo, mind_map_content
from app.pipeline.material import Material, load_material
from app.pipeline.quiz import make_questions
from app.services.artifacts import start_artifact
from app.services.jobs import update_job
from app.services.renderer import PermanentJobError
from app.services.report_templates import default_instructions

EMBED_KINDS = ("mind_map", "flashcards", "quiz", "infographic")  # every visual a reader can add with one click
MAX_PLANNED_VISUALS = 4  # suggestions an interactive report's plan can make
MAX_SECTIONS = 8
SAME_LANGUAGE = "the same language as the sources"  # no language picked: write as the material is written
BLOCK_CARDS, BLOCK_QUESTIONS = 8, 5  # a visual inside a report is a taste of the full thing

log = logging.getLogger(__name__)

MARKER = re.compile(r"\s*\[\d+\](?:\[\d+\])*")


QUIZ_HEADING = re.compile(r"\b(quiz|test yourself|check your understanding|practice questions|review questions|self[- ]?check)\b", re.I)
FLASHCARD_HEADING = re.compile(r"\bflash ?cards?\b", re.I)


def visual_kind(heading: str) -> str | None:
    """The visual a section heading really is ("Quick quiz" is a quiz), or None for an ordinary section."""
    if QUIZ_HEADING.search(heading):
        return "quiz"
    if FLASHCARD_HEADING.search(heading):
        return "flashcards"
    return None


MOVED_BRIEF = {"quiz": "Check understanding of the key ideas in this report.",
               "flashcards": "Learn the key terms and facts from this report."}


def merge_suggestions(*groups: list[dict]) -> list[dict]:
    """Suggestions from several places, one per section and kind, renumbered."""
    seen, out = set(), []
    for g in groups:
        for s in g:
            key = (s["after_block_id"], s["kind"])
            if key not in seen:
                seen.add(key)
                out.append({**s, "id": f"s{len(out) + 1}"})
    return out[:MAX_PLANNED_VISUALS + 2]


FALLBACK_BRIEFS = {
    "infographic": ("A one page picture of the main ideas of this report.", "A quick picture of the whole report."),
    "flashcards": (MOVED_BRIEF["flashcards"], "Cards to learn the key terms and facts."),
    "quiz": (MOVED_BRIEF["quiz"], "A short quiz to check understanding."),
    "mind_map": ("How the main ideas of this report connect.", "See how the ideas fit together."),
}
MIN_SUGGESTIONS = 3  # a report always offers at least this many visuals (fewer only when fewer kinds are allowed)


def fill_suggestions(suggestions: list[dict], blocks: list[dict], kinds: list[str]) -> list[dict]:
    """An interactive report always offers something to add (a document never does). Whatever the plan or the writer suggested is
    kept; then an infographic is added if there is none, and flashcards, a quiz and a mind map in turn until there are
    MIN_SUGGESTIONS, each after a different section. Plain code, so it never depends on the model remembering to suggest."""
    prose = [b for b in blocks if b.get("type") == "prose"]
    if not prose:
        return suggestions
    inner = prose[1:-1] or prose  # not the introduction or the summary, when there are others
    place = {"infographic": inner[-1]["id"], "flashcards": inner[0]["id"], "quiz": inner[len(inner) // 2]["id"],
             "mind_map": prose[0]["id"]}
    out = list(suggestions)
    have = {s["kind"] for s in out}
    for kind in ("infographic", "flashcards", "quiz", "mind_map"):
        if kind in kinds and kind not in have and (kind == "infographic" or len(out) < MIN_SUGGESTIONS):
            brief, why = FALLBACK_BRIEFS[kind]
            out.append({"id": "", "after_block_id": place[kind], "kind": kind, "brief": brief, "why": why})
            have.add(kind)
            log.info("report: no %s suggested by the plan, offering one after %s", kind, place[kind])
    return out


def split_prose(markdown: str) -> list[dict]:
    """Markdown cut into prose blocks at each "## " heading, so a block is one section and can be followed by a visual."""
    parts = re.split(r"(?m)^(?=## )", markdown.strip())
    blocks = []
    for part in parts:
        if part.strip():
            blocks.append({"type": "prose", "text": part.strip()})
    return blocks


def number_blocks(blocks: list[dict]) -> list[dict]:
    for i, b in enumerate(blocks, start=1):
        b["id"] = f"b{i}"
    return blocks


def source_rows(material: Material) -> list[dict]:
    """The posts a report was made from, for its Sources list: titles and the posts' own web addresses."""
    return source_rows_for(material.docs)


def source_rows_for(docs: list[Document]) -> list[dict]:
    return [{"title": d.title, "url": d.url, "document_id": str(d.id)} for d in docs]


def write_document(db: Session, workspace_id: uuid.UUID, job: Job | None, material: Material, instructions: str,
                   language: str) -> tuple[str, str]:
    """(title, Markdown) for a written report. Nothing is cited; a marker the model wrote anyway is removed."""
    out = run.predict(WriteReport, db=db, workspace_id=workspace_id, job=job, lm=report_lm(), title=material.title,
                      material=material.text, request=instructions, language=language)
    markdown = (out.get("markdown") or "").strip()
    if not markdown:
        raise NothingToDo("The report came back empty. Try again, or describe it differently.")
    return (out.get("report_title") or material.title).strip(), MARKER.sub("", markdown)


def write_interactive(db: Session, workspace_id: uuid.UUID, job: Job, material: Material, instructions: str,
                      language: str) -> tuple[str, list[dict], list[dict]] | None:
    """(title, blocks, suggestions) for an interactive report: a plan of sections, each written on its
    own (in parallel). The plan also says where a visual would fit; those spots come back as suggestions, and nothing
    is built until the reader clicks Add. None when planning fails, so the caller can write a plain document."""
    kinds = [k for k in EMBED_KINDS if k != "mind_map" or not material.is_chat]
    update_job(db, job, progress=0.25, message="Planning the report")
    try:
        plan = run.predict(PlanInteractiveReport, db=db, workspace_id=workspace_id, job=job, lm=report_lm(),
                           title=material.title, material=material.text, request=instructions,
                           allowed_kinds=kinds, language=language)
    except Exception:
        log.warning("report plan failed", exc_info=True)
        return None
    sections = [x for x in plan.get("sections") or [] if (x.get("heading") or "").strip()][:MAX_SECTIONS]
    if len(sections) < 2:
        return None
    report_title = (plan.get("report_title") or material.title).strip()

    # A planned section that is really a quiz or flashcards is not written as text: it becomes a suggestion.
    kept_secs: list[dict] = []
    moved: list[tuple[int, str, dict]] = []
    for x in sections:
        kind = visual_kind(x["heading"])
        if kind and kind in kinds and kept_secs:
            moved.append((len(kept_secs) - 1, kind, x))
        else:
            kept_secs.append(x)
    sections = kept_secs

    update_job(db, job, progress=0.4, message=f"Writing {len(sections)} sections")
    written = run.predict_many(
        WriteReportSection,
        [{"title": material.title, "report_title": report_title, "heading": x["heading"].strip(),
          "brief": (x.get("brief") or "").strip(), "request": instructions, "material": material.text,
          "language": language} for x in sections],
        db=db, workspace_id=workspace_id, lm=report_lm())

    blocks: list[dict] = []
    suggestions: list[dict] = []
    used_kinds: set[str] = set()
    anchor: dict[int, str] = {}  # planned section number -> the block it became
    for n, (sec, out) in enumerate(zip(sections, written, strict=True)):
        body = MARKER.sub("", ((out or {}).get("markdown") or "").strip())
        if not body:
            continue
        block = {"type": "prose", "text": f"## {sec['heading'].strip()}\n\n{body}"}
        blocks.append(block)
        number_blocks(blocks)
        anchor[n] = blocks[-1]["id"]
        embed = sec.get("embed")
        if embed and len(suggestions) < MAX_PLANNED_VISUALS and embed.get("kind") in kinds \
                and embed["kind"] not in used_kinds and (embed.get("brief") or "").strip():
            used_kinds.add(embed["kind"])
            suggestions.append({"id": f"s{len(suggestions) + 1}", "after_block_id": blocks[-1]["id"],
                                "kind": embed["kind"], "brief": embed["brief"].strip()[:300],
                                "why": (embed.get("why") or "").strip()[:300]})
    if not any(b["type"] == "prose" for b in blocks):
        return None
    for idx, kind, sec in moved:
        after = anchor.get(idx) or blocks[0]["id"]
        suggestions.append({"id": "", "after_block_id": after, "kind": kind,
                            "brief": (sec.get("brief") or MOVED_BRIEF[kind]).strip()[:300],
                            "why": "Offered here for you to add, not written into the text."})
    return report_title, blocks, merge_suggestions(fill_suggestions(suggestions, blocks, kinds))


# A report built around themes (report_themes.py, report_blueprint.py, report_evidence.py)

EVIDENCE_TOTAL = 100_000  # characters of evidence in all for a report written in one piece (about 25k tokens)
DIGEST_CHARS = 300  # of each written section, for the introduction and the summary that are written after them


@dataclass
class Themed:
    title: str
    blocks: list[dict]
    suggestions: list[dict]
    source: dict
    sources: list[dict]
    plan: dict
    failed: list[str] = field(default_factory=list)


@dataclass
class ThemedRun:
    """What the steps of a themed report share."""
    db: Session
    workspace_id: uuid.UUID
    job: Job
    docs: list[Document]
    corpus: Corpus
    bp: report_blueprint.Blueprint
    themes: list[report_themes.Theme]
    instructions: str
    language: str
    title: str

    @property
    def by_id(self) -> dict[str, report_themes.Theme]:
        return {t.id: t for t in self.themes}

    def names(self, s: report_blueprint.Section) -> list[str]:
        by_id = self.by_id
        return [by_id[i].name for i in s.theme_ids if i in by_id]

    def sections_info(self) -> list[dict]:
        return [{"heading": s.heading, "role": s.role, "depth": s.depth, "theme_ids": s.theme_ids, "must_cover": s.must_cover}
                for s in self.bp.sections]

    def finish(self, title: str, blocks: list[dict], suggestions: list[dict], used_posts: list[str],
               failed: list[str]) -> Themed:
        """The Sources list is every post the report was made from: the ones read as written and the ones summarised."""
        used = [d for d in self.docs if d.path in set(used_posts)] or self.docs
        log.info("report sources: job=%s posts_total=%d posts_used=%d", self.job.id, len(self.docs), len(used))
        plan = {"planner": "themes", "storyline": self.bp.storyline, "posts_total": len(self.docs), "posts_used": len(used),
                "themes": [report_themes.theme_summary(t) for t in self.themes], "sections": self.sections_info(),
                "connections": self.bp.connections}
        return Themed(title=title, blocks=blocks, suggestions=suggestions, plan=plan, failed=failed,
                      source={"kind": "posts", "document_ids": [str(d.id) for d in self.docs], "count": len(self.docs),
                              "read": len(used), "total": len(self.docs)},
                      sources=source_rows_for(used))


def themed_docs(db: Session, artifact: Artifact, params: dict) -> list[Document]:
    """The posts a themed report would read, or [] when the report is made the usual way: chats, a small selection, or the
    legacy planner."""
    if settings.report_planner != "themes" or params.get("chat_ids"):
        log.info("report route: legacy artifact=%s reason=%s", artifact.id,
                 "chats picked" if params.get("chat_ids") else f"REPORT_PLANNER={settings.report_planner}")
        return []
    docs = report_themes.select_docs(db, artifact.workspace_id, artifact.notebook_id, params)
    if len(docs) <= report_themes.SMALL_SELECTION:
        log.info("report route: legacy artifact=%s reason=small selection (%d posts, themes need more than %d)", artifact.id,
                 len(docs), report_themes.SMALL_SELECTION)
        return []
    return docs


def themed_title(db: Session, artifact: Artifact, params: dict, docs: list[Document]) -> str:
    """What the report is about, named the way load_material names its source."""
    nb = db.get(Notebook, artifact.notebook_id) if artifact.notebook_id else None
    if nb and not params.get("document_ids"):
        return nb.title
    return docs[0].title + (f" + {len(docs) - 1} more" if len(docs) > 1 else "")


def _digest(markdown: str) -> str:
    """The start of a written section, for the sections written after it to know what it says."""
    text = MARKER.sub("", re.sub(r"(?m)^#+\s*", "", markdown))
    return re.sub(r"\s+", " ", text).strip()[:DIGEST_CHARS]


def _section_header(n: int, s: report_blueprint.Section, names: list[str]) -> str:
    return (f"SECTION {n}: {s.heading} (role: {s.role}, depth: {s.depth})\nSays: {s.brief}\n"
            f"Must cover: {'; '.join(s.must_cover) or '(see what it says)'}\nThemes: {', '.join(names) or '(the whole report)'}")


def _section_input(ctx: ThemedRun, s: report_blueprint.Section, evidence: list[str]) -> dict:
    """Everything WriteThemedSection is given. What every section shares comes first in the signature."""
    must = list(s.must_cover)
    if s.role == "summary" and ctx.names(s):
        must.append(f"Restate the main points about: {', '.join(ctx.names(s))}")
    return {"storyline": ctx.bp.storyline, "outline": report_blueprint.outline(ctx.bp),
            "connections": report_blueprint.connection_lines(ctx.bp, ctx.themes), "request": ctx.instructions,
            "language": ctx.language, "heading": s.heading, "role": s.role, "depth": s.depth, "brief": s.brief,
            "must_cover": must, "covered_elsewhere": s.covered_elsewhere,
            "bridges": report_blueprint.connection_lines(ctx.bp, ctx.themes, s.heading), "evidence": evidence}


def _write_sections(ctx: ThemedRun, inputs: list[dict]) -> list[dict | None]:
    """WriteThemedSection for each input, together; one that failed or came back empty gets one more try (another temperature)."""
    kw = {"db": ctx.db, "workspace_id": ctx.workspace_id}
    started = time.monotonic()
    outs = run.predict_many(WriteThemedSection, inputs, lm=report_section_lm(), **kw)
    again = [k for k, o in enumerate(outs) if not ((o or {}).get("markdown") or "").strip()]
    log.info("report sections written: asked=%d ok=%d failed=%d seconds=%.1f", len(inputs), len(inputs) - len(again), len(again),
             time.monotonic() - started)
    if again:
        log.warning("report sections failed, trying again: %s", [inputs[k]["heading"] for k in again])
        redo = run.predict_many(WriteThemedSection, [inputs[k] for k in again], lm=report_section_lm(retry=True), **kw)
        for k, o in zip(again, redo, strict=True):
            outs[k] = o
        gone = [inputs[k]["heading"] for k in again if not ((outs[k] or {}).get("markdown") or "").strip()]
        log.info("report sections retried: asked=%d recovered=%d still_failed=%s", len(again), len(again) - len(gone), gone)
    return outs


def _themed_document(ctx: ThemedRun) -> Themed | None:
    """The whole report in one piece: the plan and every section's evidence go to one writer, so one voice writes it all."""
    budgets = report_evidence.scale_budgets(ctx.bp.sections, EVIDENCE_TOTAL)
    parts: list[str] = []
    used: list[str] = []
    for n, s in enumerate(ctx.bp.sections, start=1):
        head = _section_header(n, s, ctx.names(s))
        if s.role in ("body", "synthesis"):
            ev = report_evidence.build(ctx.corpus, s, ctx.by_id, budgets.get(s.heading))
            used += ev.posts
            if ev.blocks:
                head += "\nEvidence:\n" + "\n\n".join(ev.blocks)
        parts.append(head)
    report_themes.progress(ctx.db, ctx.job, 0.5, "Writing the report")
    log.info("report document: writing in one piece sections=%d evidence_chars=%d (budget %d) posts_used=%d", len(parts),
             sum(len(p) for p in parts), EVIDENCE_TOTAL, len(set(used)))
    started = time.monotonic()
    out = run.predict(WriteThemedReport, db=ctx.db, workspace_id=ctx.workspace_id, job=ctx.job, lm=report_lm(),
                      title=ctx.title, storyline=ctx.bp.storyline, request=ctx.instructions, language=ctx.language,
                      connections=report_blueprint.connection_lines(ctx.bp, ctx.themes), sections=parts)
    markdown = MARKER.sub("", (out.get("markdown") or "").strip())
    if not markdown:
        log.warning("report document came back empty, reading the posts instead")
        return None
    log.info("report document written: chars=%d seconds=%.1f", len(markdown), time.monotonic() - started)
    return ctx.finish((out.get("report_title") or ctx.bp.title).strip(), number_blocks(split_prose(markdown)), [], used, [])


def _themed_interactive(ctx: ThemedRun, moved: list[tuple[report_blueprint.Section, str, report_blueprint.Section]]) -> Themed | None:
    """Wave 1: the body sections together, each given the storyline, the outline, what the others cover and only its own
    evidence. Wave 2: the introduction and the summary, written from what wave 1 produced."""
    sections = ctx.bp.sections
    body = [(n, s) for n, s in enumerate(sections) if s.role in ("body", "synthesis")]
    frame = [(n, s) for n, s in enumerate(sections) if s.role in ("intro", "summary")]
    used: list[str] = []
    inputs = []
    for _, s in body:
        ev = report_evidence.build(ctx.corpus, s, ctx.by_id)
        used += ev.posts
        inputs.append(_section_input(ctx, s, ev.blocks))
    report_themes.progress(ctx.db, ctx.job, 0.45, f"Writing {len(body)} sections")
    log.info("report wave 1: body sections=%d evidence_chars=%s", len(body), [sum(len(b) for b in i["evidence"]) for i in inputs])
    written: dict[int, dict] = {}
    for (n, _), out in zip(body, _write_sections(ctx, inputs), strict=True):
        if ((out or {}).get("markdown") or "").strip():
            written[n] = out
    if not written:
        log.warning("report wave 1 wrote nothing, reading the posts instead")
        return None
    digests = [f"{s.heading}: {_digest(written[n]['markdown'])}" for n, s in body if n in written]
    report_themes.progress(ctx.db, ctx.job, 0.8, "Writing the introduction and summary")
    log.info("report wave 2: intro/summary sections=%d digests=%d", len(frame), len(digests))
    for (n, _), out in zip(frame, _write_sections(ctx, [_section_input(ctx, s, digests) for _, s in frame]), strict=True):
        if ((out or {}).get("markdown") or "").strip():
            written[n] = out

    blocks: list[dict] = []
    suggestions: list[dict] = []
    anchor: dict[int, str] = {}
    used_kinds: set[str] = set()
    for n, s in enumerate(sections):
        out = written.get(n)
        if not out:
            continue
        blocks.append({"type": "prose", "text": f"## {s.heading}\n\n{MARKER.sub('', out['markdown'].strip())}"})
        number_blocks(blocks)
        anchor[id(s)] = blocks[-1]["id"]
        embed = s.embed
        if embed and len(suggestions) < MAX_PLANNED_VISUALS and embed.get("kind") in EMBED_KINDS \
                and embed["kind"] not in used_kinds and (embed.get("brief") or "").strip():
            used_kinds.add(embed["kind"])
            suggestions.append({"id": f"s{len(suggestions) + 1}", "after_block_id": blocks[-1]["id"], "kind": embed["kind"],
                                "brief": embed["brief"].strip()[:300], "why": (embed.get("why") or "").strip()[:300]})
    for after, kind, sec in moved:
        suggestions.append({"id": "", "after_block_id": anchor.get(id(after)) or blocks[0]["id"], "kind": kind,
                            "brief": (sec.brief or MOVED_BRIEF[kind]).strip()[:300],
                            "why": "Offered here for you to add, not written into the text."})
    failed = [s.heading for n, s in enumerate(sections) if n not in written]
    if failed:
        log.warning("report sections left out after a retry: %s", failed)
    log.info("report interactive written: blocks=%d suggestions=%d moved_to_suggestions=%d failed=%d", len(blocks),
             len(suggestions), len(moved), len(failed))
    suggestions = fill_suggestions(suggestions, blocks, list(EMBED_KINDS))
    return ctx.finish(ctx.bp.title, blocks, merge_suggestions(suggestions), used, failed)


def write_themed(db: Session, workspace_id: uuid.UUID, job: Job, docs: list[Document], title: str, instructions: str,
                 language: str, interactive: bool) -> Themed | None:
    """The report from the posts' themes: group their stored ideas into weighted themes, plan the whole report, build each
    section's evidence from several posts, then write. A document is written in one piece from the plan; an interactive report
    section by section, each knowing the storyline, the outline and what the others cover, with the introduction and the
    summary written last from what the sections say. None when any step cannot be done (too few ideas, no usable plan, nothing
    written), so the caller reads the posts as a report always did. Never makes a report fail."""
    started = time.monotonic()
    log.info("themed report starting: job=%s workspace=%s format=%s posts=%d language=%r", job.id, workspace_id,
             "interactive" if interactive else "document", len(docs), language)
    try:
        report_themes.progress(db, job, 0.05, f"Reading {len(docs)} posts")
        report_themes.ensure_ideas(db, job, workspace_id, docs)
        share = report_themes.fresh_share(docs)
        if share < report_themes.MIN_FRESH_SHARE:
            log.warning("themed report not possible, reading the posts instead: job=%s only %.0f%% of %d posts have ideas "
                        "(need %.0f%%)", job.id, share * 100, len(docs), report_themes.MIN_FRESH_SHARE * 100)
            return None
        corpus = Corpus(workspace_id)
        corpus.sync()
        ideas = report_themes.collect_ideas(docs, corpus)
        report_themes.progress(db, job, 0.2, f"Finding the themes in {len(docs)} posts")
        themes, relations = report_themes.group_themes(db, job, workspace_id, title, instructions, ideas)
        report_themes.progress(db, job, 0.3, "Planning the report")
        kinds = list(EMBED_KINDS) if interactive else []
        bp = report_blueprint.plan_blueprint(db, job, workspace_id, title, instructions, themes, relations, kinds, language)
        log.info("themed report planned: job=%s themes=%d sections=%d seconds=%.1f", job.id, len(themes), len(bp.sections),
                 time.monotonic() - started)
        moved: list[tuple[report_blueprint.Section, str, report_blueprint.Section]] = []
        if interactive:  # a planned section that is really a quiz or flashcards is a suggestion, not text
            kept: list[report_blueprint.Section] = []
            for s in bp.sections:
                kind = visual_kind(s.heading)
                if kind and kept:
                    log.info("report section %r is a %s, so it becomes a suggestion after %r", s.heading, kind, kept[-1].heading)
                    moved.append((kept[-1], kind, s))
                    if kept[-1].role == "body":  # what the section was about is still said, in the section before it
                        kept[-1].theme_ids += [i for i in s.theme_ids if i not in kept[-1].theme_ids]
                else:
                    kept.append(s)
            bp.sections = kept
        if len(bp.sections) < 2:
            log.warning("themed report not possible, reading the posts instead: job=%s fewer than two sections left", job.id)
            return None
        ctx = ThemedRun(db, workspace_id, job, docs, corpus, bp, themes, instructions, language, title)
        themed = _themed_interactive(ctx, moved) if interactive else _themed_document(ctx)
        if themed:
            log.info("themed report done: job=%s posts_total=%d posts_used=%d blocks=%d suggestions=%d failed=%d seconds=%.1f",
                     job.id, len(docs), themed.plan["posts_used"], len(themed.blocks), len(themed.suggestions),
                     len(themed.failed), time.monotonic() - started)
        else:
            log.warning("themed report wrote nothing, reading the posts instead: job=%s", job.id)
        return themed
    except (report_themes.ThemesUnavailable, report_blueprint.BlueprintUnavailable) as exc:
        log.warning("themed report not possible, reading the posts instead: job=%s reason=%s", job.id, exc)
    except Exception:
        db.rollback()
        log.warning("themed report failed, reading the posts instead: job=%s", job.id, exc_info=True)
    return None


def build_report(db: Session, job: Job, artifact: Artifact) -> dict:
    params = job.params
    topic = (params.get("topic") or "").strip()
    language = (params.get("language") or "").strip() or SAME_LANGUAGE
    report_format = "interactive" if params.get("report_format") == "interactive" else "document"
    # Posts with ideas stored are read through their themes, however many are picked; chats and small selections as always.
    docs = themed_docs(db, artifact, params)
    material = None if docs else load_material(db, artifact.workspace_id, artifact.notebook_id, params, job=job, what="report")
    about = topic or (themed_title(db, artifact, params, docs) if docs else material.title)
    instructions = (params.get("instructions") or "").strip() or default_instructions(
        report_format, params.get("template_id"), about)

    themed = write_themed(db, artifact.workspace_id, job, docs, themed_title(db, artifact, params, docs), instructions, language,
                          report_format == "interactive") if docs else None
    log.info("report: job=%s artifact=%s format=%s way=%s", job.id, artifact.id, report_format,
             "themes" if themed else "legacy (posts read as text)")
    if themed:
        extra = {"plan": themed.plan, **({"failed_sections": themed.failed} if themed.failed else {})}
        title, blocks, suggestions = themed.title, themed.blocks, themed.suggestions
        source, sources = themed.source, themed.sources
    else:
        material = material or load_material(db, artifact.workspace_id, artifact.notebook_id, params, job=job, what="report")
        extra = {}
        made = write_interactive(db, artifact.workspace_id, job, material, instructions, language) \
            if report_format == "interactive" else None
        if made:
            title, blocks, suggestions = made
        else:
            # A document, or an interactive report whose plan came back unusable: write it as one piece. Never a failure.
            report_format = "document"
            update_job(db, job, progress=0.3, message="Writing the report")
            title, markdown = write_document(db, artifact.workspace_id, job, material, instructions, language)
            blocks = number_blocks(split_prose(markdown))
            suggestions = []  # visuals are offered in interactive reports only, never in a document
        source, sources = material.source, source_rows(material)
    artifact.content_json = {
        "title": title, "format": report_format, "template_id": params.get("template_id"),
        "instructions": instructions, "language": language, "topic": topic, "source": source,
        "blocks": blocks, "suggestions": suggestions, "suggestions_offered": True, "citations": [], "sources": sources, **extra,
    }
    artifact.status = "ready"
    db.commit()
    return {"artifact_id": str(artifact.id)}


# Adding a visual to a finished report


def _source_params(source: dict) -> dict:
    """The job params that load a report's own source again."""
    return {"chat_ids": source.get("chat_ids") or [], "document_ids": source.get("document_ids") or []}


def copy_block(kind: str, existing: Artifact) -> dict:
    """A visual's content taken from an artifact the user already made (a Mind Constellation, a quiz or flashcards)."""
    c = existing.content_json or {}
    if kind == "mind_map" and c.get("root"):
        return {"title": c.get("title"), "root": c["root"], "node_count": c.get("node_count"),
                "post_count": c.get("post_count")}
    if kind == "quiz" and c.get("questions"):
        return {"title": c.get("title"), "questions": c["questions"]}
    if kind == "flashcards" and c.get("cards"):
        return {"title": c.get("title"), "cards": c["cards"]}
    if kind == "infographic" and c.get("content"):  # the picture itself is shared, not copied
        return {"title": c.get("title"), "artifact_id": str(existing.id), "theme": c.get("theme")}
    raise NothingToDo("That one has nothing to add.")


def make_block(db: Session, job: Job, report: Artifact, kind: str, brief: str, theme: str | None = None) -> dict:
    """A new visual about `brief`, built from the report's own sources."""
    source = (report.content_json or {})["source"]
    if kind == "infographic":
        # A picture is drawn by the renderer, so it is its own infographic (listed in the Library, counted in the
        # plan) that the block points at; the report page shows it once it is ready.
        title = f"Infographic: {brief[:60] or report.content_json.get('title', '')}"
        child, _ = start_artifact(db, report.workspace_id, "infographic", title=title,
                                  notebook_id=report.notebook_id,
                                  params={**_source_params(source), "theme": theme_id(theme), "instructions": brief[:600]})
        return {"title": f"Infographic: {brief[:60]}", "artifact_id": str(child.id), "theme": theme_id(theme)}
    material = load_material(db, report.workspace_id, report.notebook_id, _source_params(source), job=job, what="report")
    language = (report.content_json or {}).get("language") or SAME_LANGUAGE
    update_job(db, job, progress=0.4, message="Building it")
    if kind == "mind_map":
        if material.is_chat:
            raise NothingToDo("A Mind Constellation needs posts, not chats.")
        c = mind_map_content(db, job, report.workspace_id, material.title, material.docs, brief)
        return {"title": c["title"], "root": c["root"], "node_count": c["node_count"], "post_count": c["post_count"]}
    if kind == "flashcards":
        cards = make_cards(db, report.workspace_id, material, topic=brief, count=BLOCK_CARDS, language=language, job=job)
        if not cards:
            raise NothingToDo("The sources did not give enough to make cards from.")
        return {"title": f"Flashcards: {brief[:60]}", "cards": cards}
    questions = make_questions(db, report.workspace_id, material, topic=brief, difficulty="medium",
                               types=["multiple_choice", "multiple_select", "fill_blank"], count=BLOCK_QUESTIONS,
                               language=language, job=job)
    if not questions:
        raise NothingToDo("The sources did not give enough to ask about.")
    return {"title": f"Test yourself: {brief[:60]}", "questions": questions}


def insert_block(content: dict, block: dict, after: str | None, suggestion_id: str | None) -> dict:
    """The report's content with the block placed after `after` (or last), the suggestion it answers removed, and
    nothing else changed. Block ids stay unique."""
    blocks = list(content.get("blocks") or [])
    used = {b["id"] for b in blocks}
    n = len(blocks) + 1
    while f"b{n}" in used:
        n += 1
    block = {**block, "id": f"b{n}", "after": after}
    at = next((i + 1 for i, b in enumerate(blocks) if b["id"] == after), len(blocks))
    # Keep the block with the visuals already hanging off the same section, in the order they were added.
    while at < len(blocks) and blocks[at]["type"] != "prose" and blocks[at].get("after") == after:
        at += 1
    blocks.insert(at, block)
    suggestions = [s for s in content.get("suggestions") or [] if s["id"] != suggestion_id]
    return {**content, "blocks": blocks, "suggestions": suggestions}


def handle_report_block(db: Session, job: Job) -> dict:
    """Worker job: add one visual (new, or copied from an existing artifact) to a report."""
    report = db.get(Artifact, uuid.UUID(job.params["artifact_id"]))
    if not report or report.type != "report":
        return {}
    p = job.params
    kind = p.get("kind")
    if kind not in EMBED_KINDS:
        raise PermanentJobError("Unknown kind of visual.")
    try:
        if p.get("existing_artifact_id"):
            existing = db.get(Artifact, uuid.UUID(p["existing_artifact_id"]))
            if not existing or existing.workspace_id != report.workspace_id or existing.type != kind \
                    or existing.status != "ready":
                raise NothingToDo("That one is not available.")
            block = copy_block(kind, existing)
        else:
            block = make_block(db, job, report, kind, (p.get("brief") or "").strip(), p.get("theme"))
            keep_visual(db, report, {"type": kind, **block})  # a new one also lands in the notebook's Studio list
    except NothingToDo as exc:
        raise PermanentJobError(str(exc)) from exc
    # Several visuals can be built at once and each takes a while: lock the report and read it again here, so this
    # one is added to what the others have already put in, not to the copy read before the slow part.
    db.refresh(report, with_for_update=True)
    report.content_json = insert_block(report.content_json or {}, {"type": kind, **block}, p.get("after_block_id"),
                                       p.get("suggestion_id"))
    db.commit()
    return {"artifact_id": str(report.id)}


def keep_visual(db: Session, report: Artifact, block: dict) -> Artifact | None:
    """A mind map, flashcards or quiz made inside a report would exist only as that block. It is also saved as an
    artifact of its own in the notebook, so it shows in the Studio list and "use one you already made" offers it
    again after the block is removed. Content that is already saved is not saved twice."""
    kind = block.get("type")
    source = (report.content_json or {}).get("source") or {}
    if kind == "flashcards" and block.get("cards"):
        key, content = "cards", {"cards": block["cards"], "card_count": len(block["cards"])}
    elif kind == "quiz" and block.get("questions"):
        key, content = "questions", {"questions": block["questions"], "question_count": len(block["questions"])}
    elif kind == "mind_map" and block.get("root"):
        key, content = "root", {"root": block["root"], "node_count": block.get("node_count"),
                                "post_count": block.get("post_count"),
                                "document_ids": source.get("document_ids") or []}
    else:
        return None  # an infographic already is its own artifact
    same = db.scalars(select(Artifact).where(Artifact.workspace_id == report.workspace_id, Artifact.type == kind,
                                             Artifact.notebook_id == report.notebook_id))
    if any((a.content_json or {}).get(key) == content[key] for a in same):
        return None
    saved = Artifact(workspace_id=report.workspace_id, notebook_id=report.notebook_id, type=kind, status="ready",
                     content_json={"title": block.get("title") or kind, "source": source, **content})
    db.add(saved)
    db.commit()
    return saved


def remove_block(content: dict, block_id: str) -> dict | None:
    """The content without that visual (prose cannot be removed), with the offer to add it again restored, or None
    when there is no such visual."""
    blocks = list(content.get("blocks") or [])
    removed = next((b for b in blocks if b["id"] == block_id and b["type"] != "prose"), None)
    if not removed:
        return None
    keep = [b for b in blocks if b["id"] != block_id]
    suggestions = list(content.get("suggestions") or [])
    kind = removed["type"]
    if kind in FALLBACK_BRIEFS and not any(s["kind"] == kind for s in suggestions):
        brief, why = FALLBACK_BRIEFS[kind]
        suggestions.append({"id": "", "after_block_id": removed.get("after"), "kind": kind, "brief": brief, "why": why})
    return {**content, "blocks": keep, "suggestions": suggestions}

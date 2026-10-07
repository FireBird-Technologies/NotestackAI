"""Reports: a written document (or an interactive one, with visuals) made from a notebook's posts or chats.

Every report is stored as `blocks`, even a plain document (a few prose blocks), so the same page can show, extend and
share either kind. Each block is {"id", "type", ...}: `prose` has Markdown `text` whose [n] markers point into the
report's `citations`."""

import logging
import re
import uuid

from sqlalchemy.orm import Session

from app.llm import run
from app.llm.provider import fast_lm, report_lm
from app.llm.signatures import (
    PlanInteractiveReport,
    SuggestEmbeds,
    WriteReport,
    WriteReportSection,
)
from app.models import Artifact, Job
from app.pipeline.flashcards import make_cards
from app.pipeline.generate import NothingToDo, mind_map_content
from app.pipeline.material import Material, load_material
from app.pipeline.quiz import make_questions
from app.pipeline.passages import as_citations
from app.pipeline.research import verify_citations
from app.infographics.themes import theme_id
from app.services.artifacts import start_artifact
from app.services.jobs import update_job
from app.services.renderer import PermanentJobError
from app.services.report_templates import default_instructions

SUGGEST_KINDS = ("mind_map", "flashcards", "quiz", "infographic")  # what the AI suggests for a document report
EMBED_KINDS = SUGGEST_KINDS  # every visual a reader can add with one click
MAX_PLANNED_VISUALS = 4  # suggestions an interactive report's plan can make
MAX_SECTIONS = 8
SAME_LANGUAGE = "the same language as the sources"  # no language picked: write as the material is written
MAX_SUGGESTIONS = 4
BLOCK_CARDS, BLOCK_QUESTIONS = 8, 5  # a visual inside a report is a taste of the full thing

log = logging.getLogger(__name__)

MARKER = re.compile(r"\s*\[\d+\](?:\[\d+\])*")


QUIZ_HEADING = re.compile(r"\b(quiz|test yourself|check your understanding|practice questions|review questions|self[- ]?check)\b", re.I)
FLASHCARD_HEADING = re.compile(r"\bflash ?cards?\b", re.I)
ASKED_FOR_VISUAL = re.compile(r"\b(quiz|flash ?cards?|practice questions)\b", re.I)


def visual_kind(heading: str) -> str | None:
    """The visual a section heading really is ("Quick quiz" is a quiz), or None for an ordinary section."""
    if QUIZ_HEADING.search(heading):
        return "quiz"
    if FLASHCARD_HEADING.search(heading):
        return "flashcards"
    return None


MOVED_BRIEF = {"quiz": "Check understanding of the key ideas in this report.",
               "flashcards": "Learn the key terms and facts from this report."}


def pull_visual_sections(blocks: list[dict], kinds: list[str]) -> tuple[list[dict], list[dict]]:
    """A section written as a quiz or flashcards is not part of the text: it is taken out and offered as a suggestion
    after the section before it, for the reader to add. Never takes out every section."""
    kept: list[dict] = []
    moved: list[tuple[int, str]] = []
    for b in blocks:
        first = b["text"].split("\n", 1)[0] if b["type"] == "prose" else ""
        kind = visual_kind(first.lstrip("# ").strip()) if first.startswith("#") else None
        if kind and kind in kinds and kept:
            moved.append((len(kept) - 1, kind))
        else:
            kept.append(b)
    number_blocks(kept)
    return kept, [{"id": f"s{i}", "after_block_id": kept[idx]["id"], "kind": kind, "brief": MOVED_BRIEF[kind],
                   "why": "Offered here for you to add, not written into the text."}
                  for i, (idx, kind) in enumerate(moved, start=1)]


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


def citation_rows(cites, material: Material) -> list[dict]:
    by_path = {d.path: d for d in material.docs}
    return [{"marker": c.marker, "path": c.path, "line_start": c.line_start, "line_end": c.line_end,
             "span": c.quote, "title": by_path[c.path].title, "url": by_path[c.path].url,
             "document_id": str(by_path[c.path].id)}
            for c in cites if c.path in by_path]


def source_rows(material: Material) -> list[dict]:
    """Where the report came from, for the public page's Sources button: titles and the posts' own web addresses."""
    return [{"title": d.title, "url": d.url, "document_id": str(d.id)} for d in material.docs]


def write_document(db: Session, workspace_id: uuid.UUID, job: Job | None, material: Material, instructions: str,
                   language: str) -> tuple[str, str, list[dict]]:
    """(title, Markdown, citation rows) for a written report. Citations are checked against the posts' lines and
    renumbered 1..n; a chat has none, so any marker the model wrote is removed."""
    out = run.predict(WriteReport, db=db, workspace_id=workspace_id, job=job, lm=report_lm(), title=material.title,
                      material=material.text, request=instructions, language=language)
    markdown = (out.get("markdown") or "").strip()
    if not markdown:
        raise NothingToDo("The report came back empty. Try again, or describe it differently.")
    if material.tools is None:
        return (out.get("report_title") or material.title).strip(), MARKER.sub("", markdown), []
    text, cites = verify_citations(material.tools, markdown, as_citations(out.get("citations")))
    return (out.get("report_title") or material.title).strip(), text, citation_rows(cites, material)


def allowed_kinds(material_or_source: Material | dict) -> list[str]:
    """Which visuals fit this source: a mind map is drawn from posts' stored ideas, so a chat gets cards and a quiz."""
    has_posts = bool(material_or_source.docs) if isinstance(material_or_source, Material) \
        else bool(material_or_source.get("document_ids"))
    return [k for k in SUGGEST_KINDS if k != "mind_map" or has_posts]


def suggest_embeds(db: Session, workspace_id: uuid.UUID, job: Job | None, blocks: list[dict],
                   kinds: list[str]) -> list[dict]:
    """Up to MAX_SUGGESTIONS places for a visual: after which section, what kind, what it covers, why. Never fails
    the report: no suggestions is a fine answer."""
    sections = []
    for b in blocks:
        if b["type"] != "prose":
            continue
        first, _, rest = b["text"].partition("\n")
        heading = first.lstrip("# ").strip() if first.startswith("#") else ""
        start = re.sub(r"\s+", " ", rest or first)[:240]
        sections.append(f"{b['id']} | {heading or 'Introduction'}: {start}")
    if len(sections) < 2:
        return []
    try:
        out = run.predict(SuggestEmbeds, db=db, workspace_id=workspace_id, job=job, lm=fast_lm(), sections=sections,
                          allowed_kinds=kinds)
    except Exception:
        return []
    ids = {b["id"] for b in blocks}
    taken: set[tuple[str, str]] = {(b.get("after") or "", b["type"]) for b in blocks if b["type"] != "prose"}
    found = []
    for s in out.get("suggestions") or []:
        key = (s.get("after_block_id"), s.get("kind"))
        if s.get("after_block_id") not in ids or s.get("kind") not in kinds or key in taken or not (s.get("brief") or "").strip():
            continue
        taken.add(key)
        found.append({"id": f"s{len(found) + 1}", "after_block_id": s["after_block_id"], "kind": s["kind"],
                      "brief": s["brief"].strip()[:300], "why": (s.get("why") or "").strip()[:300]})
    return found[:MAX_SUGGESTIONS]


def shift_markers(text: str, offset: int) -> str:
    """[n] markers renumbered to [n + offset], so sections written apart share one citation list."""
    return re.sub(r"\[(\d+)\]", lambda m: f"[{int(m.group(1)) + offset}]", text) if offset else text


def write_interactive(db: Session, workspace_id: uuid.UUID, job: Job, material: Material, instructions: str,
                      language: str) -> tuple[str, list[dict], list[dict], list[dict]] | None:
    """(title, blocks, citation rows, suggestions) for an interactive report: a plan of sections, each written on its
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
    citations: list[dict] = []
    suggestions: list[dict] = []
    used_kinds: set[str] = set()
    anchor: dict[int, str] = {}  # planned section number -> the block it became
    for n, (sec, out) in enumerate(zip(sections, written, strict=True)):
        body = ((out or {}).get("markdown") or "").strip()
        if not body:
            continue
        if material.tools is None:
            body = MARKER.sub("", body)
        else:
            body, cites = verify_citations(material.tools, body, as_citations((out or {}).get("citations")))
            offset = len(citations)
            body = shift_markers(body, offset)
            citations += [{**c, "marker": c["marker"] + offset} for c in citation_rows(cites, material)]
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
    return report_title, blocks, citations, merge_suggestions(suggestions)


def build_report(db: Session, job: Job, artifact: Artifact) -> dict:
    params = job.params
    topic = (params.get("topic") or "").strip()
    language = (params.get("language") or "").strip() or SAME_LANGUAGE
    report_format = "interactive" if params.get("report_format") == "interactive" else "document"
    material = load_material(db, artifact.workspace_id, artifact.notebook_id, params, job=job, what="report")
    instructions = (params.get("instructions") or "").strip() or default_instructions(
        report_format, params.get("template_id"), topic or material.title)

    made = write_interactive(db, artifact.workspace_id, job, material, instructions, language) \
        if report_format == "interactive" else None
    if made:
        title, blocks, citations, suggestions = made
    else:
        # A document, or an interactive report whose plan came back unusable: write it as one piece. Never a failure.
        report_format = "document"
        update_job(db, job, progress=0.3, message="Writing the report")
        title, markdown, citations = write_document(db, artifact.workspace_id, job, material, instructions, language)
        blocks = number_blocks(split_prose(markdown))
        kinds = allowed_kinds(material)
        pulled: list[dict] = []
        if not ASKED_FOR_VISUAL.search(instructions):  # a quiz section the reader did not ask for becomes a suggestion
            blocks, pulled = pull_visual_sections(blocks, kinds)
        update_job(db, job, progress=0.9, message="Finding places for visuals")
        suggestions = merge_suggestions(pulled, suggest_embeds(db, artifact.workspace_id, job, blocks, kinds))
    artifact.content_json = {
        "title": title, "format": report_format, "template_id": params.get("template_id"),
        "instructions": instructions, "language": language, "topic": topic, "source": material.source,
        "blocks": blocks, "suggestions": suggestions, "citations": citations, "sources": source_rows(material),
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
    if kind == "infographic" and existing.storage_key:  # the picture itself is shared, not copied
        return {"title": c.get("title"), "artifact_id": str(existing.id), "theme": c.get("theme")}
    raise NothingToDo("That one has nothing to add.")


def make_block(db: Session, job: Job, report: Artifact, kind: str, brief: str, theme: str | None = None) -> dict:
    """A new visual about `brief`, built from the report's own sources."""
    source = (report.content_json or {})["source"]
    if kind == "infographic":
        # A picture is drawn by the renderer, so it is its own infographic (listed in the Library, counted in the
        # plan) that the block points at; the report page shows it once it is ready.
        child, _ = start_artifact(db, report.workspace_id, "infographic", title=f"Infographic: {brief[:60] or report.content_json.get('title', '')}",
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
    except NothingToDo as exc:
        raise PermanentJobError(str(exc)) from exc
    report.content_json = insert_block(report.content_json or {}, {"type": kind, **block}, p.get("after_block_id"),
                                       p.get("suggestion_id"))
    db.commit()
    return {"artifact_id": str(report.id)}


def remove_block(content: dict, block_id: str) -> dict | None:
    """The content without that visual (prose cannot be removed), or None when there is no such visual."""
    blocks = list(content.get("blocks") or [])
    keep = [b for b in blocks if not (b["id"] == block_id and b["type"] != "prose")]
    return None if len(keep) == len(blocks) else {**content, "blocks": keep}

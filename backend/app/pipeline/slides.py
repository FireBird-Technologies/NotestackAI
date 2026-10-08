"""Slide decks. The model plans the deck (OutlineDeck), writes each content slide from the lines it cites
(WriteSlide, in parallel), has every claim checked against those lines (CheckSlide), and writes the conclusion from
the finished slides (WriteClosing). The opening slide and the agenda come from the outline. Code then lays the deck
out (app.slides): the model never writes markup, positions or colours, and only the deck's words are stored."""

import logging
import re
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.llm import run
from app.llm.provider import fast_lm, report_lm
from app.llm.signatures import CheckRequest, CheckSlide, OutlineDeck, WriteClosing, WriteSlide
from app.models import Artifact, Job
from app.pipeline.generate import NothingToDo
from app.pipeline.material import Material, load_material
from app.pipeline.report import SAME_LANGUAGE
from app.services.jobs import update_job
from app.slides.build import finish
from app.slides.content import FORMATS, LENGTHS, clamp_deck, clamp_slide, plain
from app.slides.layout import seed_of
from app.slides.themes import theme_id

log = logging.getLogger(__name__)

CONTENT_LAYOUTS = ("section", "points", "two_column", "stat", "quote")
SOURCE_BUDGET = 7_000  # characters of cited lines one slide is written from (a PDF's lines can be whole pages)
CONTEXT_BUDGET = 9_000  # characters a slide without usable citations is written from


def content_range(length: str) -> tuple[int, int]:
    """How many content slides a deck of this length has: its total minus the opening, the closing and (above the
    short length) the agenda."""
    lo, hi = LENGTHS[length]
    fixed = 3 if has_agenda(length) else 2
    return lo - fixed, hi - fixed


def has_agenda(length: str) -> bool:
    return length != "short"


def _missed(db: Session, job: Job, artifact: Artifact, request: str, plans: list[dict]) -> list[str]:
    """What the request asked for that the planned slides do not do (empty when nothing is missing or the check fails)."""
    if not request or not plans:
        return []
    try:
        out = run.predict(CheckRequest, db=db, workspace_id=artifact.workspace_id, job=job, lm=fast_lm(), request=request,
                          slides=[f"{p.get('heading')}: {p.get('purpose') or ''}" for p in plans])
    except Exception:
        return []
    return [plain(a.get("ask")) for a in out.get("asks") or [] if isinstance(a, dict) and a.get("covered") is False
            and plain(a.get("ask"))]


def _outline(db: Session, job: Job, artifact: Artifact, material: Material, fmt: str, length: str, request: str,
             language: str) -> dict:
    lo, hi = content_range(length)
    count = f"{lo} to {hi}" + (", including 2 to 4 section slides that divide the deck into parts" if length == "long" else "")
    ask = request or "(none)"
    best: dict = {}
    for attempt in range(2):
        try:
            out = run.predict(OutlineDeck, db=db, workspace_id=artifact.workspace_id, job=job, lm=report_lm(),
                              title=material.title, material=material.text, request=ask, deck_format=fmt,
                              slide_count=count, language=language)
        except Exception:
            if attempt:
                raise
            continue
        outline = out.get("outline") or {}
        plans = [p for p in outline.get("slides") or []
                 if isinstance(p, dict) and p.get("layout") in CONTENT_LAYOUTS and plain(p.get("heading"))]
        outline["slides"] = plans
        if len(plans) > len(best.get("slides") or []):
            best = outline
        if lo <= len(plans):
            break
        ask = f"{request or '(none)'}\n\nPlan between {lo} and {hi} content slides."
    plans = best.get("slides") or []
    if len(plans) < lo:
        raise NothingToDo(f"The sources picked do not have enough in them for a {'short' if length == 'short' else 'full'} "
                          "deck. Add posts, or choose Short.")
    # The request decides what the deck is about: when the outline misses something it asked for, plan once more with
    # the missing asks spelled out (kept only if the new outline is still long enough).
    missed = _missed(db, job, artifact, request, plans)
    if missed:
        retry = f"{request}\n\nThe previous outline missed these asks; plan slides for them as far as the material supports: " \
                + "; ".join(missed)
        try:
            out = run.predict(OutlineDeck, db=db, workspace_id=artifact.workspace_id, job=job, lm=report_lm(),
                              title=material.title, material=material.text, request=retry, deck_format=fmt,
                              slide_count=count, language=language)
            again = out.get("outline") or {}
            again_plans = [p for p in again.get("slides") or []
                           if isinstance(p, dict) and p.get("layout") in CONTENT_LAYOUTS and plain(p.get("heading"))]
            if len(again_plans) >= lo:
                best, plans = {**again, "slides": again_plans}, again_plans
        except Exception:
            pass  # keep the first outline
    # Too many: keep the first and last (the argument's start and end) and drop from the middle.
    while len(plans) > hi:
        plans.pop(len(plans) // 2)
    best["slides"] = plans
    return best


def _source_lines(material: Material, refs: list[dict]) -> list[str]:
    """What one slide is written from: the lines it cites with a little around them, or the material itself."""
    out, used = [], 0
    if material.tools:
        for r in refs:
            text = material.tools.quote(r["path"], max(1, r["line_start"] - 2), r["line_end"] + 6) or r["quote"]
            block = f"FILE {r['path']} ({r.get('title') or ''}) from line {max(1, r['line_start'] - 2)}\n{text}"
            if used + len(block) > SOURCE_BUDGET and out:
                break
            out.append(block[:SOURCE_BUDGET])
            used += len(block)
    if out:
        return out
    budget = CONTEXT_BUDGET // max(len(material.text), 1)
    return [t[:budget] for t in material.text]


def _norm(text: str) -> str:
    return re.sub(r"[^\w%$€£]+", " ", text.lower()).strip()


def _fallback_slide(plan: dict, sources: list[str]) -> dict:
    """A slide written by code when the model could not write one: its planned heading and its first source lines."""
    body = " ".join(re.sub(r"^\s*\d+\|\s?", "", line) for s in sources for line in s.splitlines()[1:])
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", body) if len(s.strip()) > 30][:3]
    return {"layout": "points" if len(sentences) >= 2 else "section", "heading": plan.get("heading"),
            "kicker": "", "lead": plan.get("purpose") or "", "points": [{"term": "", "text": s} for s in sentences],
            "notes": plan.get("purpose") or ""}


def _claims(slide: dict) -> list[tuple[tuple, str]]:
    """Every checkable statement on a slide, with where it lives."""
    out: list[tuple[tuple, str]] = []
    if slide.get("layout") == "section" and slide.get("heading"):  # a section's heading is its claim
        out.append((("heading",), slide["heading"]))
    if slide.get("lead"):
        out.append((("lead",), slide["lead"]))
    for i, p in enumerate(slide.get("points") or []):
        if p.get("text"):  # the term is context; only the sentence is checked and rewritten
            out.append((("points", i), f"{p['term']}: {p['text']}" if p.get("term") else p["text"]))
    for side in ("left", "right"):
        for i, item in enumerate((slide.get(side) or {}).get("items") or []):
            out.append(((side, i), item))
    stat = slide.get("stat") or {}
    if stat.get("value") and stat.get("label"):
        out.append((("stat",), f"{stat['value']} {stat['label']}"))
    return out


def _apply_checks(slide: dict, claims: list[tuple[tuple, str]], checks: list[dict]) -> None:
    """Replace unsupported claims with their fix, or remove them."""
    drop: dict[str, set[int]] = {"points": set(), "left": set(), "right": set()}
    for c in checks or []:
        try:
            n = int(c.get("n")) - 1
        except (TypeError, ValueError):
            continue
        if not 0 <= n < len(claims) or c.get("supported") is not False:
            continue
        where, _ = claims[n]
        fix = plain(c.get("fix"))
        if where[0] == "heading":
            if fix:
                slide["heading"] = fix
        elif where[0] == "lead":
            slide["lead"] = fix
        elif where[0] == "points":
            term = slide["points"][where[1]].get("term") or ""
            if term and fix.lower().startswith(term.lower()):  # the fix repeated the name: keep only the sentence
                fix = fix[len(term):].lstrip(" :.-")
            elif term and re.match(r"^[^:.!?]{1,40}:\s", fix):  # or put a label of its own before it
                fix = fix.split(":", 1)[1].strip()
            if fix:
                slide["points"][where[1]]["text"] = fix[:1].upper() + fix[1:]
            else:
                drop["points"].add(where[1])
        elif where[0] in ("left", "right"):
            if fix:
                slide[where[0]]["items"][where[1]] = fix
            else:
                drop[where[0]].add(where[1])
        elif where[0] == "stat":
            slide["stat"] = None  # a number is never rewritten: it is in the sources as it is, or it goes
    slide["points"] = [p for i, p in enumerate(slide.get("points") or []) if i not in drop["points"]]
    for side in ("left", "right"):
        if slide.get(side):
            slide[side]["items"] = [t for i, t in enumerate(slide[side]["items"]) if i not in drop[side]]


def _verbatim(slide: dict, sources: list[str]) -> None:
    """A quote must be in the sources word for word and a number as written; otherwise it is removed."""
    text = _norm(" ".join(re.sub(r"^\s*\d+\|\s?", "", line) for s in sources for line in s.splitlines()))
    quote = slide.get("quote") or {}
    if quote.get("text") and _norm(quote["text"]) not in text:
        slide["quote"] = None
    stat = slide.get("stat") or {}
    if stat.get("value") and _norm(stat["value"]) not in text:
        slide["stat"] = None


def _summary(slide: dict) -> str:
    bits = [slide.get("heading") or "", slide.get("lead") or ""]
    bits += [f"{p.get('term') or ''} {p.get('text') or ''}".strip() for p in slide.get("points") or []]
    for side in ("left", "right"):
        col = slide.get(side) or {}
        if col.get("items"):
            bits.append(f"{col.get('label') or ''}: " + "; ".join(col["items"]))
    if (slide.get("stat") or {}).get("value"):
        bits.append(f"{slide['stat']['value']} {slide['stat'].get('label') or ''}")
    if (slide.get("quote") or {}).get("text"):
        bits.append(f"“{slide['quote']['text']}”")
    return " | ".join(b for b in bits if b)


def _check_frame(db: Session, job: Job, ws: uuid.UUID, slides: list[dict], subtitle: str, takeaways: list[str],
                 last_line: str) -> tuple[str, list[str], str]:
    """The opening's subtitle, the takeaways and the closing line say only what the (already checked) slides say:
    each is checked against them, and fixed or removed when it does not."""
    claims = ([("subtitle", subtitle)] if subtitle else []) + [("takeaway", t) for t in takeaways] + \
             ([("closing", last_line)] if last_line else [])
    if not claims:
        return subtitle, takeaways, last_line
    try:
        out = run.predict(CheckSlide, db=db, workspace_id=ws, job=job, lm=fast_lm(),
                          claims=[f"{n + 1}. {t}" for n, (_, t) in enumerate(claims)],
                          source_lines=[_summary(s) for s in slides])
    except Exception:
        return subtitle, takeaways, last_line
    verdict: dict[int, str | None] = {}  # claim index -> its fix ("" to remove)
    for c in out.get("checks") or []:
        try:
            n = int(c.get("n")) - 1
        except (TypeError, ValueError):
            continue
        if 0 <= n < len(claims) and c.get("supported") is False:
            verdict[n] = plain(c.get("fix"))
    kept = [verdict.get(n, text) for n, (_, text) in enumerate(claims)]
    subtitle = kept.pop(0) if subtitle else ""
    last_line = kept.pop() if last_line else ""
    return subtitle, [t for t in kept if t] or [s["heading"] for s in slides[:3]], last_line


def _previous_variants(db: Session, artifact: Artifact) -> list[tuple[str, str]]:
    """The layout and variant of each slide in the notebook's last deck, so this one can look different."""
    if not artifact.notebook_id:
        return []
    last = db.scalars(select(Artifact).where(Artifact.notebook_id == artifact.notebook_id, Artifact.type == "slide_deck",
                                             Artifact.status == "ready", Artifact.id != artifact.id)
                      .order_by(Artifact.created_at.desc()).limit(1)).first()
    slides = (((last.content_json or {}).get("deck") or {}).get("slides") or []) if last else []
    return [(s.get("layout"), s.get("variant")) for s in slides if isinstance(s, dict)]


def build_slide_deck(db: Session, job: Job, artifact: Artifact) -> dict:
    params = job.params
    ws = artifact.workspace_id
    fmt = params.get("deck_format") if params.get("deck_format") in FORMATS else "detailed"
    length = params.get("deck_length") if params.get("deck_length") in LENGTHS else "default"
    theme = theme_id(params.get("theme"))
    language = (params.get("language") or "").strip() or SAME_LANGUAGE
    request = (params.get("instructions") or "").strip()
    material = load_material(db, ws, artifact.notebook_id, params, job=job, what="slide deck")

    update_job(db, job, progress=0.2, message="Planning the story")
    outline = _outline(db, job, artifact, material, fmt, length, request, language)
    plans = outline["slides"]
    refs = [material.refs(p.get("sources")) for p in plans]
    sources = [_source_lines(material, r) for r in refs]
    lines = [f"{i + 2}. {p['heading']}" for i, p in enumerate(plans)]
    total = len(plans) + (3 if has_agenda(length) else 2)

    update_job(db, job, progress=0.35, message=f"Writing {len(plans)} slides")
    first = 3 if has_agenda(length) else 2  # where content starts, counting from 1

    def inputs(i: int) -> dict:
        return {"deck_title": outline.get("title") or material.title, "outline": lines,
                "position": f"Slide {first + i} of {total}", "layout": plans[i]["layout"],
                "heading": plans[i]["heading"], "purpose": plans[i].get("purpose") or "", "deck_format": fmt,
                "request": request or "(none)", "source_lines": sources[i], "language": language}

    written = run.predict_many(WriteSlide, [inputs(i) for i in range(len(plans))], db=db, workspace_id=ws, lm=report_lm())
    missing = [i for i, w in enumerate(written) if not (w and w.get("slide"))]
    if missing:  # one more try for the slides that failed
        again = run.predict_many(WriteSlide, [inputs(i) for i in missing], db=db, workspace_id=ws, lm=report_lm())
        for i, w in zip(missing, again, strict=True):
            written[i] = w
    slides = []
    for i, w in enumerate(written):
        s = (w or {}).get("slide") or _fallback_slide(plans[i], sources[i])
        s = dict(s)
        s["layout"] = plans[i]["layout"] if not s.get("layout") else s["layout"]
        s["heading"] = s.get("heading") or plans[i]["heading"]
        cited = material.refs(s.get("sources")) if material.tools else []
        s["sources"] = cited or refs[i]
        _verbatim(s, sources[i])
        slides.append(s)

    update_job(db, job, progress=0.6, message="Checking every slide against your posts")
    claims = [_claims(s) for s in slides]
    todo = [i for i, c in enumerate(claims) if c]
    checked = run.predict_many(
        CheckSlide, [{"claims": [f"{n + 1}. {t}" for n, (_, t) in enumerate(claims[i])], "source_lines": sources[i]}
                     for i in todo], db=db, workspace_id=ws, lm=fast_lm())
    for i, out in zip(todo, checked, strict=True):
        if out:
            _apply_checks(slides[i], claims[i], out.get("checks") or [])

    # A slide left with only its heading (its number or quote was not in the posts, its claims did not hold) says
    # nothing checked: it goes, as long as the deck keeps its length.
    lo = content_range(length)[0]
    for i in reversed(range(len(slides))):
        bare = (clamp_slide({**slides[i], "layout": slides[i].get("layout")}, fmt) or {}).get("layout") == "section"
        if bare and plans[i]["layout"] != "section" and len(slides) > lo:
            del slides[i]
    # Two slides with the same heading (a part's title repeated by its first slide): the section one goes.
    for i in reversed(range(len(slides))):
        same = [j for j, o in enumerate(slides) if j != i and _norm(o.get("heading") or "") == _norm(slides[i].get("heading") or "")]
        if same and slides[i].get("layout") == "section" and len(slides) > lo:
            del slides[i]

    update_job(db, job, progress=0.8, message="Writing the conclusion")
    closing: dict = {}
    for _ in range(2):  # one more try: a failed call would leave the deck without its real conclusion
        try:
            closing = run.predict(WriteClosing, db=db, workspace_id=ws, job=job, lm=fast_lm(),
                                  deck_title=outline.get("title") or material.title, slides=[_summary(s) for s in slides],
                                  deck_format=fmt, request=request or "(none)", language=language).get("closing") or {}
        except Exception:
            log.warning("WriteClosing failed", exc_info=True)
            closing = {}
        if closing.get("takeaways"):
            break
    takeaways = closing.get("takeaways") or [s["heading"] for s in slides[:3]]
    subtitle = outline.get("subtitle") or ""
    subtitle, takeaways, last_line = _check_frame(db, job, ws, slides, subtitle, takeaways, closing.get("closing") or "")

    opening = {"layout": "title", "kicker": outline.get("opening_kicker") or "", "heading": outline.get("title") or material.title,
               "lead": subtitle, "notes": subtitle}
    deck_slides = [opening]
    if has_agenda(length):
        # A long deck's agenda lists its parts (its section slides); otherwise every slide.
        parts = [s for s in slides if s.get("layout") == "section"]
        listed = parts if len(parts) >= 2 else slides
        deck_slides.append({"layout": "agenda", "kicker": "", "heading": outline.get("agenda_heading") or "Agenda",
                            "points": [{"term": "", "text": s["heading"]} for s in listed]})
    deck_slides += slides
    deck_slides.append({"layout": "closing", "kicker": closing.get("kicker") or "",
                        "heading": closing.get("heading") or opening["heading"], "takeaways": takeaways,
                        "closing": last_line or opening["lead"], "notes": closing.get("notes") or ""})

    update_job(db, job, progress=0.9, message="Laying out the slides")
    deck = clamp_deck({"title": opening["heading"], "subtitle": opening["lead"], "slides": deck_slides}, fmt)
    if not deck or len(deck["slides"]) < LENGTHS[length][0]:
        raise NothingToDo("The deck came out too thin to show. Try other posts or add a description.")
    seed = artifact.id.hex if isinstance(artifact.id, uuid.UUID) else str(artifact.id)
    deck = finish(deck, theme, fmt, seed_of(seed), _previous_variants(db, artifact))

    artifact.content_json = {**(artifact.content_json or {}), "title": f"Slide deck: {deck['title']}"[:140],
                             "theme": theme, "format": fmt, "length": length,
                             "language": params.get("language") or "", "instructions": request,
                             "source": material.source, "seed": seed, "deck": deck}
    artifact.storage_key = None
    artifact.status = "ready"
    db.commit()
    return {"artifact_id": str(artifact.id), "slides": len(deck["slides"])}

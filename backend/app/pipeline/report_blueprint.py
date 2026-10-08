"""The plan of a themed report, made before any of it is written.

One model call (PlanReportBlueprint) sees the themes with their weights and the reader's request, never the posts, and plans the
whole report: a storyline, the sections in order (what each is about, how deep, what it must cover), and which section bridges which
themes. Code then checks the plan against the weights, because a plan that forgets a major theme or gives a footnote the room of a
main theme is wrong however well it reads: every major or asked-for theme gets a section, depth follows the theme's tier, a body
theme belongs to one section, and what other sections own is worked out here, not left to the model."""

import logging
import time
import uuid
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.llm import run
from app.llm.provider import report_plan_lm
from app.llm.signatures import PlanReportBlueprint
from app.models import Job
from app.pipeline.report_themes import Theme

log = logging.getLogger(__name__)

MAX_SECTIONS = 8
MAX_CONNECTIONS = 6
ROLES = ("intro", "body", "synthesis", "summary")
MORE_HEADING = "More to know"  # where the themes no section took are gathered


class BlueprintUnavailable(Exception):
    """The plan was not usable: the caller reads the posts as before."""


@dataclass
class Section:
    heading: str
    role: str
    brief: str
    theme_ids: list[str]
    depth: str = "standard"
    must_cover: list[str] = field(default_factory=list)
    embed: dict | None = None
    covered_elsewhere: list[str] = field(default_factory=list)


@dataclass
class Blueprint:
    title: str
    storyline: str
    sections: list[Section]
    connections: list[dict]  # {"theme_ids": [...], "relation": str, "section": heading}


def theme_lines(themes: list[Theme]) -> list[str]:
    """The themes as the planner reads them: id | name | tier | weight | posts | asked for: summary, then a few of their ideas."""
    return [f"{t.id} | {t.name} | {t.tier} | {t.weight:.2f} | {len(t.doc_ids)} posts | "
            f"{'asked for' if t.pinned else 'not asked for'}: {t.summary} (e.g. {'; '.join(i.label for i in t.ideas[:3])})"
            for t in themes]


def relation_lines(relations: list[dict]) -> list[str]:
    return [f"{r['a']} <-> {r['b']}: {r['relation']}" for r in relations]


def derived_depth(section: Section, by_id: dict[str, Theme]) -> str:
    """How deep a section goes follows its heaviest theme, whatever the model wrote: the weights are the plan's reason to exist."""
    if section.role in ("intro", "summary"):
        return "brief"
    tiers = {by_id[i].tier + ("!" if by_id[i].pinned else "") for i in section.theme_ids if i in by_id}
    if any(t.startswith("major") or t.endswith("!") for t in tiers):
        return "deep"
    if section.role == "synthesis" or any(t.startswith("medium") for t in tiers):
        return "standard"
    return "brief"


def _first_index(sections: list[Section], role: str) -> int | None:
    return next((n for n, s in enumerate(sections) if s.role == role), None)


def _in_reading_order(sections: list[Section]) -> list[Section]:
    """The intro first, the summary last, whatever order the model gave them in. One of each."""
    intro = [s for s in sections if s.role == "intro"][:1]
    summary = [s for s in sections if s.role == "summary"][-1:]
    return intro + [s for s in sections if s.role in ("body", "synthesis")] + summary


def repair(bp: Blueprint, themes: list[Theme]) -> Blueprint:
    """Make the plan agree with the weights. Raises BlueprintUnavailable when fewer than two sections remain."""
    by_id = {t.id: t for t in themes}
    sections = [s for s in bp.sections if s.heading.strip()]
    planned = len(sections)

    # A body theme is the subject of one section; unknown ids go.
    seen: set[str] = set()
    for s in sections:
        s.theme_ids = [i for n, i in enumerate(s.theme_ids) if i in by_id and i not in s.theme_ids[:n]]
        if s.role == "body":
            s.theme_ids = [i for i in s.theme_ids if i not in seen]
            seen.update(s.theme_ids)
    before = len(sections)
    sections = [s for s in sections if s.role != "body" or s.theme_ids]
    if len(sections) < before:
        log.info("report blueprint: dropped %d body sections with no theme of their own", before - len(sections))
    sections = _in_reading_order(sections)

    def insert(section: Section) -> None:
        at = _first_index(sections, "summary")
        sections.insert(len(sections) if at is None else at, section)

    # Every major or asked-for theme has a section; whatever else no section took is gathered into one.
    for t in sorted(themes, key=lambda t: -t.weight):
        if t.id not in seen and (t.tier == "major" or t.pinned):
            log.info("report blueprint: no section for %s theme %s (%s), added one", "asked-for" if t.pinned else t.tier, t.id,
                     t.name)
            insert(Section(heading=t.name, role="body", brief=t.summary, theme_ids=[t.id], depth="deep"))
            seen.add(t.id)
    rest = [t.id for t in sorted(themes, key=lambda t: -t.weight) if t.id not in seen]
    if rest:
        log.info("report blueprint: themes in no section %s go to %r", rest, MORE_HEADING)
        more = next((s for s in sections if s.role == "body" and s.heading == MORE_HEADING), None)
        if more:
            more.theme_ids += rest
        else:
            insert(Section(heading=MORE_HEADING, role="body", theme_ids=rest, depth="brief",
                           brief="The smaller themes in the posts, in a line or two each."))
        seen.update(rest)

    # Too many sections: the lightest body sections (never one holding a major or asked-for theme) are gathered into one brief
    # section, so a footnote never shares a section with a main theme.
    def weight(s: Section) -> float:
        return sum(by_id[i].weight for i in s.theme_ids)

    def protected(s: Section) -> bool:
        return any(by_id[i].tier == "major" or by_id[i].pinned for i in s.theme_ids)

    while len(sections) > MAX_SECTIONS:
        more = next((s for s in sections if s.role == "body" and s.heading == MORE_HEADING), None)
        candidates = [s for s in sections if s.role == "body" and not protected(s) and s is not more]
        if not candidates:
            break
        lightest = min(candidates, key=weight)
        log.info("report blueprint: %d sections, over the %d allowed: merging %r (themes %s) into %r", len(sections),
                 MAX_SECTIONS, lightest.heading, lightest.theme_ids, MORE_HEADING)
        if more:
            more.theme_ids += lightest.theme_ids
            sections.remove(lightest)
        else:
            lightest.heading, lightest.must_cover = MORE_HEADING, []
            lightest.brief = "The smaller themes in the posts, in a line or two each."

    # intro first, summary last, depth from the weights, the summary restates the main themes.
    sections = _in_reading_order(sections)
    for s in [s for s in sections if s.role == "summary"]:
        s.theme_ids = [t.id for t in themes if t.tier == "major" or t.pinned] or s.theme_ids
    for s in sections:
        s.depth = derived_depth(s, by_id)
    if len(sections) < 2:
        log.warning("report blueprint unusable: sections=%d planned=%d", len(sections), planned)
        raise BlueprintUnavailable("the plan has fewer than two sections")

    # What the other body sections own, so no section writes another's points. The intro and summary may touch everything.
    for s in sections:
        s.covered_elsewhere = [] if s.role in ("intro", "summary") else [
            f"{o.heading}: {'; '.join(o.must_cover) or o.brief}"[:240] for o in sections
            if o is not s and o.role in ("body", "synthesis")]

    headings = {s.heading.lower(): s.heading for s in sections}
    connections = []
    for c in bp.connections:
        ids = [i for i in c.get("theme_ids") or [] if i in by_id]
        relation = (c.get("relation") or "").strip()
        if len(ids) < 2 or not relation:
            continue
        home = headings.get(str(c.get("section", "")).strip().lower()) or next(
            (s.heading for s in sections if s.role in ("body", "synthesis") and set(ids) & set(s.theme_ids)), None)
        if home:
            connections.append({"theme_ids": ids, "relation": relation[:200], "section": home})
    log.info("report blueprint checked: planned=%d final=%d connections=%d/%d", planned, len(sections), len(connections),
             len(bp.connections))
    for n, s in enumerate(sections, start=1):
        log.info("report section %d: heading=%r role=%s depth=%s themes=%s must_cover=%d embed=%s", n, s.heading, s.role, s.depth,
                 s.theme_ids, len(s.must_cover), (s.embed or {}).get("kind"))
    return Blueprint(title=bp.title, storyline=bp.storyline, sections=sections, connections=connections[:MAX_CONNECTIONS])


def plan_blueprint(db: Session, job: Job | None, workspace_id: uuid.UUID, title: str, request: str,
                   themes: list[Theme], relations: list[dict], kinds: list[str], language: str) -> Blueprint:
    """The checked plan for these themes. Raises BlueprintUnavailable (or whatever the model call raised) when there is none."""
    log.info("report blueprint: asking the model workspace=%s themes=%d relations=%d allowed_visuals=%s", workspace_id, len(themes),
             len(relations), kinds)
    started = time.monotonic()
    out = run.predict(PlanReportBlueprint, db=db, workspace_id=workspace_id, job=job, lm=report_plan_lm(), title=title,
                      request=request, themes=theme_lines(themes), relations=relation_lines(relations), allowed_kinds=kinds,
                      language=language, max_sections=MAX_SECTIONS)
    sections = []
    for s in out.get("sections") or []:
        heading = (s.get("heading") or "").strip()
        if heading:
            sections.append(Section(
                heading=heading, role=s.get("role") if s.get("role") in ROLES else "body", brief=(s.get("brief") or "").strip(),
                theme_ids=[str(i) for i in s.get("theme_ids") or []], depth=s.get("depth") or "standard",
                must_cover=[str(p).strip() for p in s.get("must_cover") or [] if str(p).strip()][:4], embed=s.get("embed")))
    log.info("report blueprint: model answered sections=%d connections=%d seconds=%.1f", len(sections),
             len(out.get("connections") or []), time.monotonic() - started)
    bp = Blueprint(title=(out.get("report_title") or title).strip(), storyline=(out.get("storyline") or "").strip(),
                   sections=sections, connections=out.get("connections") or [])
    return repair(bp, themes)


def outline(bp: Blueprint) -> list[str]:
    """Every section as every writer sees it: number, heading, role, what it says."""
    return [f"{n}. {s.heading} ({s.role}): {s.brief}" for n, s in enumerate(bp.sections, start=1)]


def connection_lines(bp: Blueprint, themes: list[Theme], heading: str | None = None) -> list[str]:
    """The connections (all of them, or the ones one section bridges) as 'Pricing + Hiring: how they connect (section)'."""
    names = {t.id: t.name for t in themes}
    return [f"{' + '.join(names[i] for i in c['theme_ids'])}: {c['relation']} (bridged in: {c['section']})"
            for c in bp.connections if heading is None or c["section"] == heading]

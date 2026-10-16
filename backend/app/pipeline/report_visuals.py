"""Source-grounded charts, tables and timelines for interactive reports.

The model may point out promising data, but it cannot author the data that reaches a report. Every cell and point is
checked against verified corpus lines; an unverifiable candidate is discarded as a whole.
"""

import logging
import re
import unicodedata
import uuid

from sqlalchemy.orm import Session

from app.llm import run
from app.llm.provider import report_lm
from app.llm.signatures import ExtractReportVisuals
from app.models import Document, Job
from app.pipeline.material import Material

log = logging.getLogger(__name__)

MAX_CANDIDATES = 3
MAX_POINTS = 30
MAX_ROWS = 40
MAX_COLUMNS = 8
DATASET_SCHEMA = 1
NUMBER = re.compile(
    r"^\s*(?:[$£€₹]\s*)?(?P<number>[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)"
    r"\s*(?P<scale>k|m|b|t|thousand|million|billion|trillion)?\s*(?P<unit>[a-z]{1,12})?\s*(?P<percent>%)?\s*$",
    re.I,
)
DATE = re.compile(r"(?:\b(?:19|20)\d{2}\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|"
                  r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|"
                  r"sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b)", re.I)
FILE = re.compile(r"^FILE (.+?) \(.+\)$")
NUMBERED = re.compile(r"^(\d+)\|\s?(.*)$")


def _plain(value: object) -> str:
    """Comparable source text without typographic punctuation or repeated whitespace."""
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = "".join(char for char in text if unicodedata.category(char) != "Cf")
    text = text.replace("−", "-").replace("–", "-").replace("—", "-")
    return " ".join(text.casefold().split()).strip(" \t\r\n.,;:()[]{}")


def _in_source(value: object, quotes: list[str]) -> bool:
    needle = _plain(value)
    return bool(needle) and any(needle in _plain(q) for q in quotes)


def _number(value: object) -> float | None:
    """A display number as a finite JSON number; currency and percent signs remain in the block's unit/display fields."""
    raw = "".join(char for char in unicodedata.normalize("NFKC", str(value or ""))
                  if unicodedata.category(char) != "Cf").replace("−", "-")
    match = NUMBER.fullmatch(raw)
    if not match:
        return None
    try:
        parsed = float(match.group("number").replace(",", ""))
    except ValueError:
        return None
    scales = {"k": 1_000, "thousand": 1_000, "m": 1_000_000, "million": 1_000_000,
              "b": 1_000_000_000, "billion": 1_000_000_000,
              "t": 1_000_000_000_000, "trillion": 1_000_000_000_000}
    parsed *= scales.get((match.group("scale") or "").casefold(), 1)
    return parsed if abs(parsed) != float("inf") and parsed == parsed else None


def _adornment(value: object) -> str:
    raw = str(value or "")
    currency = next((symbol for symbol in "$£€₹" if symbol in raw), "")
    return f"{currency}{'%' if '%' in raw else ''}"


def _refs(material: Material, raw: object) -> list[dict]:
    refs = material.refs(raw if isinstance(raw, list) else [])
    return refs[:4]


def _chart(candidate: dict, material: Material) -> dict | None:
    kind = candidate.get("kind")
    points = []
    source_refs = []
    adornments: set[str] = set()
    units = str(candidate.get("unit") or "").strip()
    meta_refs = _refs(material, candidate.get("sources"))
    all_quotes = [r["quote"] for r in meta_refs]
    for point in (candidate.get("points") or [])[:MAX_POINTS]:
        if not isinstance(point, dict):
            return None
        refs = _refs(material, point.get("sources"))
        quotes = [r["quote"] for r in refs]
        label, shown = str(point.get("label") or "").strip(), str(point.get("value") or "").strip()
        value = _number(shown)
        if not refs or not label or value is None or not _in_source(label, quotes) or not _in_source(shown, quotes):
            return None
        if point.get("detail") and not _in_source(point["detail"], quotes):
            return None
        points.append({"label": label[:160], "value": value, "display_value": shown[:80],
                       "detail": str(point.get("detail") or "")[:300]})
        adornments.add(_adornment(shown))
        source_refs.extend(refs)
        all_quotes.extend(quotes)
    if len(points) < 2 or len(adornments) > 1 or (kind == "pie" and (any(p["value"] < 0 for p in points)
                                                                       or sum(p["value"] for p in points) <= 0)):
        return None
    title = str(candidate.get("title") or "").strip()
    x_label, y_label = str(candidate.get("x_label") or "").strip(), str(candidate.get("y_label") or "").strip()
    return {"type": "plot", "title": (title if _in_source(title, all_quotes) else "Source data")[:160],
            "plot_kind": kind, "x_label": (x_label if _in_source(x_label, all_quotes) else "Category")[:80],
            "y_label": (y_label if _in_source(y_label, all_quotes) else "Value")[:80],
            "unit": (units if _in_source(units, all_quotes) else "")[:40], "points": points,
            "source_refs": _dedupe_refs(meta_refs + source_refs)}


def _timeline(candidate: dict, material: Material) -> dict | None:
    events, source_refs = [], []
    meta_refs = _refs(material, candidate.get("sources"))
    all_quotes = [r["quote"] for r in meta_refs]
    for point in (candidate.get("points") or [])[:MAX_POINTS]:
        if not isinstance(point, dict):
            return None
        refs = _refs(material, point.get("sources"))
        quotes = [r["quote"] for r in refs]
        title, when = str(point.get("label") or "").strip(), str(point.get("value") or "").strip()
        detail = str(point.get("detail") or "").strip()
        if not refs or not title or not when or not DATE.search(when) or not _in_source(title, quotes) \
                or not _in_source(when, quotes):
            return None
        if detail and not _in_source(detail, quotes):
            return None
        events.append({"when": when[:80], "title": title[:200], "detail": detail[:500]})
        source_refs.extend(refs)
        all_quotes.extend(quotes)
    if len(events) < 2:
        return None
    title = str(candidate.get("title") or "").strip()
    return {"type": "timeline", "title": (title if _in_source(title, all_quotes) else "Source timeline")[:160],
            "events": events, "source_refs": _dedupe_refs(meta_refs + source_refs)}


def _table(candidate: dict, material: Material) -> dict | None:
    headers = [str(x).strip()[:120] for x in (candidate.get("headers") or [])[:MAX_COLUMNS] if str(x).strip()]
    raw_rows = [row for row in (candidate.get("rows") or [])[:MAX_ROWS] if isinstance(row, dict)]
    if len(headers) < 2 and raw_rows:
        width = len(raw_rows[0].get("cells") or [])
        headers = (["Metric", "Value"] if width == 2 else [f"Column {n}" for n in range(1, width + 1)])[:MAX_COLUMNS]
    if len(headers) < 2:
        return None
    rows, source_refs = [], []
    meta_refs = _refs(material, candidate.get("sources"))
    all_quotes = [r["quote"] for r in meta_refs]
    for row in raw_rows:
        cells = [str(x).strip()[:400] for x in (row.get("cells") or [])[:MAX_COLUMNS]]
        refs = _refs(material, row.get("sources"))
        quotes = [r["quote"] for r in refs]
        if len(cells) != len(headers) or not refs or any(not cell or not _in_source(cell, quotes) for cell in cells):
            return None
        rows.append(cells)
        source_refs.extend(refs)
        all_quotes.extend(quotes)
    if len(rows) < 2:
        return None
    generated_headers = headers == ["Metric", "Value"] or all(h.startswith("Column ") for h in headers)
    if not generated_headers and any(not _in_source(header, all_quotes) for header in headers):
        return None
    title = str(candidate.get("title") or "").strip()
    return {"type": "table", "title": (title if _in_source(title, all_quotes) else "Source table")[:160],
            "headers": headers, "rows": rows, "source_refs": _dedupe_refs(meta_refs + source_refs)}


def _dedupe_refs(refs: list[dict]) -> list[dict]:
    out, seen = [], set()
    for ref in refs:
        key = (ref.get("document_id"), ref.get("line_start"), ref.get("line_end"))
        if key in seen:
            continue
        seen.add(key)
        out.append({k: ref.get(k) for k in ("document_id", "path", "title", "line_start", "line_end")})
    return out[:20]


def _candidate_refs(candidate: dict, material: Material) -> list[dict]:
    """Every verified source range used by a raw candidate, including point- and row-level evidence."""
    refs = _refs(material, candidate.get("sources"))
    for item in [*(candidate.get("points") or []), *(candidate.get("rows") or [])]:
        if isinstance(item, dict):
            refs.extend(_refs(material, item.get("sources")))
    out, seen = [], set()
    for ref in refs:
        key = (ref.get("document_id"), ref.get("line_start"), ref.get("line_end"))
        if key not in seen:
            seen.add(key)
            out.append(ref)
    return out[:20]


def _meaning(candidate: dict, material: Material) -> dict:
    """Keep the dataset's sourced meaning as well as its normalized Plotly values."""
    refs = _candidate_refs(candidate, material)
    quotes = [str(r.get("quote") or "").strip() for r in refs if str(r.get("quote") or "").strip()]

    def sourced(name: str) -> str:
        value = str(candidate.get(name) or "").strip()
        return value[:500] if value and _in_source(value, quotes) else ""

    qualifiers = [str(q).strip()[:300] for q in candidate.get("qualifiers") or []
                  if str(q).strip() and _in_source(q, quotes)]
    excerpts = list(dict.fromkeys(quotes))[:6]
    return {
        "description": sourced("description") or (excerpts[0][:500] if excerpts else ""),
        "metric": sourced("metric"),
        "dimension": sourced("dimension"),
        "population": sourced("population"),
        "qualifiers": qualifiers[:8],
        "source_excerpts": excerpts,
    }


def _candidate_item(candidate: dict, material: Material, candidate_id: str) -> dict | None:
    kind = candidate.get("kind")
    block = _table(candidate, material) if kind == "table" else _timeline(candidate, material) if kind == "timeline" \
        else _chart(candidate, material) if kind in ("bar", "line", "scatter", "pie") else None
    return {"id": candidate_id, "block": block, "meaning": _meaning(candidate, material)} if block else None


def _duplicate(items: list[dict], block: dict) -> bool:
    return any(item["block"].get("type") == block.get("type")
               and item["block"].get("rows") == block.get("rows")
               and item["block"].get("points") == block.get("points")
               and item["block"].get("events") == block.get("events") for item in items)


def _cells(line: str) -> list[str]:
    text = line.strip()
    if "|" not in text:
        return []
    return [cell.strip() for cell in text.strip("|").split("|")]


def _explicit_table_candidates(material: Material) -> list[dict]:
    """Markdown tables survive scraping with their source line numbers, so recognize them without asking a model."""
    # With several sources, a literal table may belong to a topic the report did not choose. Let the focus-aware model
    # decide relevance in that case; a single-source report has no cross-topic ambiguity.
    if len(material.docs) != 1:
        return []
    found = []
    for passage in material.text:
        lines = passage.splitlines()
        match = FILE.match(lines[0]) if lines else None
        if not match:
            continue
        path = match.group(1)
        numbered = [(int(m.group(1)), m.group(2)) for line in lines[1:] if (m := NUMBERED.match(line))]
        for i in range(len(numbered) - 3):
            header_no, header_line = numbered[i]
            _, divider_line = numbered[i + 1]
            headers, dividers = _cells(header_line), _cells(divider_line)
            if len(headers) < 2 or len(headers) != len(dividers) \
                    or any(not re.fullmatch(r":?-{3,}:?", cell) for cell in dividers):
                continue
            rows = []
            for line_no, row_line in numbered[i + 2:]:
                cells = _cells(row_line)
                if len(cells) != len(headers):
                    break
                rows.append({"cells": cells, "sources": [{"path": path, "line_start": line_no, "line_end": line_no}]})
            if len(rows) < 2:
                continue
            candidate = {"kind": "table", "title": "", "headers": headers, "rows": rows,
                         "sources": [{"path": path, "line_start": header_no, "line_end": header_no}]}
            if _table(candidate, material):
                found.append(candidate)
            if len(found) >= MAX_CANDIDATES:
                return found
    return found


def _explicit_tables(material: Material) -> list[dict]:
    out = []
    for candidate in _explicit_table_candidates(material):
        item = _candidate_item(candidate, material, f"v{len(out) + 1}")
        if item:
            out.append(item)
    return out


def cache_post_datasets(document: Document, material: Material, raw_candidates: list[dict] | None) -> list[dict]:
    """Validate and serialize datasets discovered while this post's ideas are extracted."""
    out = []
    candidates = [*_explicit_table_candidates(material), *(raw_candidates or [])]
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        item = _candidate_item(candidate, material, f"d{len(out) + 1}")
        if not item or _duplicate(out, item["block"]):
            continue
        source_docs = {str(r.get("document_id")) for r in item["block"].get("source_refs") or []}
        if source_docs != {str(document.id)}:
            continue
        out.append({"schema_version": DATASET_SCHEMA, "document_id": str(document.id),
                    "content_hash": document.content_hash or "", "raw": candidate,
                    "block": item["block"], "meaning": item["meaning"]})
        if len(out) >= MAX_CANDIDATES:
            break
    return out


def cached_candidates(material: Material, focus: str = "") -> list[dict]:
    """Revalidate current per-post dataset caches against the source lines before a report may use them."""
    ranked = []
    focus_words = {w for w in re.findall(r"[a-z0-9]+", focus.casefold()) if len(w) > 2}
    for document in material.docs:
        md = getattr(document, "metadata_json", None) or {}
        content_hash = getattr(document, "content_hash", None) or ""
        document_id = str(getattr(document, "id", ""))
        if md.get("datasets_hash") != content_hash or md.get("datasets_schema") != DATASET_SCHEMA:
            continue
        for cached in md.get("datasets") or []:
            if not isinstance(cached, dict) or cached.get("document_id") != document_id \
                    or cached.get("content_hash") != content_hash:
                continue
            raw = cached.get("raw")
            if not isinstance(raw, dict):
                continue
            item = _candidate_item(raw, material, "")
            if not item:
                log.info("discarded stale cached dataset document=%s", document_id)
                continue
            source_docs = {str(r.get("document_id")) for r in item["block"].get("source_refs") or []}
            if source_docs != {document_id}:
                continue
            searchable = " ".join([
                str(item["block"].get("title") or ""), str(item["block"].get("x_label") or ""),
                str(item["block"].get("y_label") or ""), *(str(x) for x in item["meaning"].values()),
            ])
            words = {w for w in re.findall(r"[a-z0-9]+", searchable.casefold()) if len(w) > 2}
            ranked.append((len(focus_words & words), item))
    # A zero-overlap cache may be unrelated to this particular report. Let the focus-aware report scan decide instead.
    if focus_words and any(score > 0 for score, _ in ranked):
        ranked = [entry for entry in ranked if entry[0] > 0]
    elif focus_words:
        return []
    ranked.sort(key=lambda entry: entry[0], reverse=True)
    out = []
    for _, item in ranked:
        if not _duplicate(out, item["block"]):
            item["id"] = f"v{len(out) + 1}"
            out.append(item)
        if len(out) >= MAX_CANDIDATES:
            break
    return out


def extract(db: Session, workspace_id: uuid.UUID, job: Job, material: Material, focus: str = "") -> list[dict]:
    """Validated candidate blocks. Chat-only material has no verifiable line references, so it deliberately yields none."""
    if not material.docs or not material.text or material.mode != "passages":
        return []
    out = cached_candidates(material, focus)
    for candidate in _explicit_table_candidates(material):
        item = _candidate_item(candidate, material, f"v{len(out) + 1}")
        if item and not _duplicate(out, item["block"]):
            out.append(item)
        if len(out) >= MAX_CANDIDATES:
            return out
    try:
        raw = run.predict(ExtractReportVisuals, db=db, workspace_id=workspace_id, job=job, lm=report_lm(),
                          material=material.text, focus=focus or material.title)
    except Exception:
        log.warning("report visual extraction failed; continuing without data visuals", exc_info=True)
        return out
    for candidate in (raw.get("candidates") or [])[:MAX_CANDIDATES - len(out)]:
        if not isinstance(candidate, dict):
            continue
        item = _candidate_item(candidate, material, f"v{len(out) + 1}")
        if item:
            if not _duplicate(out, item["block"]):
                out.append(item)
        else:
            log.info("discarded unverified report visual candidate kind=%r title=%r", candidate.get("kind"),
                     candidate.get("title"))
    return out


def suggestions(candidates: list[dict], blocks: list[dict]) -> list[dict]:
    """Place validated data visuals through the report; no candidate means no data suggestion."""
    prose = [b for b in blocks if b.get("type") == "prose"]
    if not prose:
        return []
    inner = prose[1:-1] or prose
    out = []
    for n, candidate in enumerate(candidates):
        block = candidate["block"]
        kind = block["type"]
        label = "plot" if kind == "plot" else kind
        out.append({"id": "", "after_block_id": inner[min(n, len(inner) - 1)]["id"], "kind": label,
                    "candidate_id": candidate["id"], "brief": block.get("title") or "Source data",
                    "why": "The selected sources contain verified data for this view."})
    return out


def opportunity_lines(candidates: list[dict]) -> list[str]:
    """Compact, already-validated datasets for a report planner."""
    out = []
    for candidate in candidates:
        block = candidate.get("block") or {}
        kind = block.get("type")
        if kind == "plot":
            values = "; ".join(f"{p.get('label')} = {p.get('display_value') or p.get('value')}"
                               for p in (block.get("points") or [])[:12])
            shape = f"{block.get('plot_kind', 'bar')} plot"
        elif kind == "table":
            values = "; ".join(" | ".join(str(cell) for cell in row)
                               for row in (block.get("rows") or [])[:6])
            shape = "table"
        elif kind == "timeline":
            values = "; ".join(f"{e.get('when')}: {e.get('title')}"
                               for e in (block.get("events") or [])[:8])
            shape = "timeline"
        else:
            continue
        meaning = candidate.get("meaning") or {}
        semantic = "; ".join(f"{key}={meaning.get(key)}" for key in ("description", "metric", "dimension", "population")
                             if meaning.get(key))
        qualifiers = "; ".join(str(x) for x in meaning.get("qualifiers") or [])
        meaning_part = f" | meaning: {semantic}" if semantic else ""
        if qualifiers:
            meaning_part += f"; qualifiers={qualifiers}"
        themes = ",".join(str(x) for x in candidate.get("theme_ids") or [])
        theme_part = f" | themes={themes}" if themes else ""
        line = f"{candidate.get('id')} | {shape} | {block.get('title') or 'Source data'}{theme_part}{meaning_part} | {values}"
        out.append(line[:1800])
    return out


def evidence(candidate: dict | None) -> list[str]:
    """Validated facts a section writer may discuss so its prose and visual stay aligned."""
    lines = opportunity_lines([candidate]) if candidate else []
    return [f"VERIFIED DATA FOR THIS SECTION: {lines[0]}"] if lines else []


def candidate_by_id(candidates: list[dict], candidate_id: object) -> dict | None:
    return next((c for c in candidates if c.get("id") == candidate_id), None)


def assign_themes(candidates: list[dict], themes: list[object]) -> None:
    """Give each verified dataset one primary theme, using exact source ownership first and wording second."""
    for candidate in candidates:
        block = candidate.get("block") or {}
        source_docs = {str(r.get("document_id")) for r in block.get("source_refs") or [] if r.get("document_id")}
        data_text = " ".join([str(block.get("title") or ""), str(block.get("x_label") or ""),
                              str(block.get("y_label") or ""),
                              " ".join(str(p.get("label") or "") for p in block.get("points") or []),
                              " ".join(str(h) for h in block.get("headers") or [])])
        data_words = {w for w in re.findall(r"[a-z0-9]+", data_text.casefold()) if len(w) > 2}

        def score(theme: object, source_docs: set[str] = source_docs, data_words: set[str] = data_words) -> int:
            theme_docs = {str(x) for x in getattr(theme, "doc_ids", set())}
            ideas = getattr(theme, "ideas", [])
            theme_text = " ".join([str(getattr(theme, "name", "")), str(getattr(theme, "summary", "")),
                                   *[str(getattr(i, "label", "")) for i in ideas[:20]]])
            theme_words = {w for w in re.findall(r"[a-z0-9]+", theme_text.casefold()) if len(w) > 2}
            return 10 * len(source_docs & theme_docs) + len(data_words & theme_words)

        ranked = [(score(theme), theme) for theme in themes]
        if ranked:
            best_score, best = max(ranked, key=lambda item: item[0])
            candidate["theme_ids"] = [str(best.id)] if best_score > 0 else []


def best_section(candidate: dict, sections: list[dict]) -> int | None:
    """Choose the most relevant body section when a planner omitted a relevant candidate id."""
    if not sections:
        return None
    block = candidate.get("block") or {}
    data = " ".join([str(block.get("title") or ""), str(block.get("x_label") or ""),
                     str(block.get("y_label") or ""),
                     " ".join(str(p.get("label") or "") for p in block.get("points") or []),
                     " ".join(str(h) for h in block.get("headers") or [])])
    words = {w for w in re.findall(r"[a-z0-9]+", data.casefold()) if len(w) > 2}

    def score(section: dict) -> int:
        text = (f"{section.get('heading', '')} {section.get('brief', '')} "
                f"{' '.join(section.get('must_cover') or [])} {section.get('text', '')}")
        theme_match = bool(set(candidate.get("theme_ids") or []) & set(section.get("theme_ids") or []))
        return (100 if theme_match else 0) + len(words & {w for w in re.findall(
            r"[a-z0-9]+", text.casefold()) if len(w) > 2})

    return max(range(len(sections)), key=lambda i: score(sections[i]))


def candidate_block(content: dict, suggestion_id: str | None, kind: str) -> dict | None:
    """Resolve a click through the stored suggestion, preventing clients from choosing hidden or unrelated data."""
    suggestion = next((s for s in content.get("suggestions") or [] if s.get("id") == suggestion_id), None)
    if not suggestion or suggestion.get("kind") != kind or not suggestion.get("candidate_id"):
        return None
    candidate = next((c for c in content.get("visual_candidates") or []
                      if c.get("id") == suggestion["candidate_id"]), None)
    block = candidate.get("block") if isinstance(candidate, dict) else None
    return dict(block) if isinstance(block, dict) and block.get("type") == kind else None

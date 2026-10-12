"""What a deck says, in one fixed shape. Model output is never trusted: every slide is coerced to the same keys (empty
defaults for what it lacks), stripped to plain text, cut to the format's limits, and moved to a simpler layout when
it lacks what its own layout needs. Whatever goes in, what comes out can always be drawn."""

import re

LAYOUTS = ("title", "agenda", "section", "points", "two_column", "stat", "quote", "closing")
FORMATS = ("detailed", "presenter")
LENGTHS = {"short": (6, 8), "default": (9, 11), "long": (12, 16)}  # slides in the deck, opening and closing included

# Characters per field. Detailed slides explain; presenter slides only cue the speaker.
LIMITS = {
    "detailed": {"title": 80, "subtitle": 170, "kicker": 32, "heading": 90, "lead": 240, "term": 44, "text": 220,
                 "points": (2, 5), "label": 40, "item": 120, "items": 4, "value": 16, "stat_label": 120,
                 "quote": 260, "by": 70, "takeaway": 150, "takeaways": 3, "closing": 140, "agenda": 64,
                 "agenda_items": 14, "notes": 1500},
    "presenter": {"title": 70, "subtitle": 130, "kicker": 32, "heading": 64, "lead": 130, "term": 36, "text": 80,
                  "points": (2, 4), "label": 32, "item": 70, "items": 4, "value": 16, "stat_label": 90,
                  "quote": 200, "by": 70, "takeaway": 90, "takeaways": 3, "closing": 110, "agenda": 56,
                  "agenda_items": 14, "notes": 1500},
}

_TAGS = re.compile(r"<[^>]*>")
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_MD_EMPH = re.compile(r"(\*\*|__|\*|`|~~)")
_MD_LEAD = re.compile(r"^\s*(?:#{1,6}\s+|[-*+•]\s+|\d{1,2}[.)]\s+|>\s*)")
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_CITE = re.compile(r"\s*\[\d+\]")
_SPACE = re.compile(r"\s+")


def plain(value: object) -> str:
    """One line of plain text: no markup, markdown, citation markers, control characters or em dashes."""
    if value is None or isinstance(value, dict | list | tuple | set):
        return ""
    s = _CTRL.sub(" ", str(value))
    s = _MD_LINK.sub(r"\1", _TAGS.sub(" ", s))
    s = _MD_LEAD.sub("", s)
    s = _CITE.sub("", _MD_EMPH.sub("", s))
    s = s.replace("—", ", ").replace("–", "-").replace("&nbsp;", " ")
    s = _SPACE.sub(" ", s).strip()
    return s.replace(" ,", ",").strip(" ,;")


def clip(value: object, limit: int) -> str:
    """Plain text of at most `limit` characters. A longer text ends at its last full sentence when one fits well,
    otherwise at a word, with an ellipsis."""
    s = plain(value)
    if len(s) <= limit:
        return s
    head = s[:limit]
    end = max(head.rfind(". "), head.rfind("! "), head.rfind("? "))
    if end >= limit * 0.55:
        return head[: end + 1]
    # No sentence ends in reach: end at the last clause instead (", ensuring..." dropped), as a full stop.
    clause = max(head.rfind(", "), head.rfind("; "), head.rfind(" and "), head.rfind(" while "), head.rfind(" which "))
    if clause >= limit * 0.6:
        return head[:clause].rstrip(" ,;:-") + "."
    cut = head[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:.-") or head[: limit - 1]
    return cut + "…"


def _dict(value: object) -> dict:
    if hasattr(value, "model_dump"):
        value = value.model_dump()
    return value if isinstance(value, dict) else {}


def _list(value: object) -> list:
    return list(value) if isinstance(value, list | tuple) else []


def _sources(raw: object) -> list[dict]:
    out = []
    for r in _list(raw):
        r = _dict(r)
        try:
            start, end = int(r["line_start"]), int(r["line_end"])
        except (KeyError, TypeError, ValueError):
            continue
        path = plain(r.get("path"))
        if not path:
            continue
        item = {"path": path, "line_start": start, "line_end": max(start, end)}
        for key in ("title", "document_id"):
            if r.get(key):
                item[key] = plain(r[key])[:200]
        if r.get("quote"):
            item["quote"] = clip(r["quote"], 400)
        out.append(item)
    return out[:8]


def _points(raw: object, lim: dict) -> list[dict]:
    out = []
    for p in _list(raw):
        if isinstance(p, str):
            p = {"term": "", "text": p}
        p = _dict(p)
        term, text = clip(p.get("term"), lim["term"]), clip(p.get("text"), lim["text"])
        if not text and term:  # a bare term is the point itself
            term, text = "", clip(p.get("term"), lim["text"])
        if text:
            out.append({"term": term, "text": text})
    return out


def _column(raw: object, lim: dict) -> dict:
    c = _dict(raw)
    items = [t for t in (clip(i, lim["item"]) for i in _list(c.get("items"))) if t][: lim["items"]]
    return {"label": clip(c.get("label"), lim["label"]), "items": items}


_LIMIT_KEY = {"kicker": "kicker", "heading": "heading", "lead": "lead", "closing": "closing", "stat.value": "value",
              "stat.label": "stat_label", "quote.text": "quote", "quote.by": "by", "left.label": "label",
              "right.label": "label", "left.items": "item", "right.items": "item", "points.term": "term",
              "points.text": "text", "takeaways": "takeaway"}


def field_limit(layout: str, field: str, fmt: str) -> int:
    """How many characters `field` may hold on a slide of this layout: what clamp_slide cuts it to."""
    lim = LIMITS[fmt if fmt in FORMATS else "detailed"]
    key = re.sub(r"\.\d+", "", field)  # "points.2.text" -> "points.text"
    if layout == "title" and key in ("heading", "lead"):
        return lim["title" if key == "heading" else "subtitle"]
    if layout == "agenda" and key == "points.text":
        return lim["agenda"]
    return lim[_LIMIT_KEY[key]]


def empty_slide(layout: str = "points") -> dict:
    return {"layout": layout, "variant": "", "kicker": "", "heading": "", "lead": "", "points": [],
            "left": {"label": "", "items": []}, "right": {"label": "", "items": []},
            "stat": {"value": "", "label": ""}, "quote": {"text": "", "by": ""}, "takeaways": [], "closing": "",
            "notes": "", "sources": [], "shrink": 0}


def clamp_slide(raw: object, fmt: str) -> dict | None:
    """One slide in the fixed shape, or None when nothing on it can be shown."""
    lim = LIMITS[fmt if fmt in FORMATS else "detailed"]
    r = _dict(raw)
    s = empty_slide(r.get("layout") if r.get("layout") in LAYOUTS else "points")
    s["variant"] = plain(r.get("variant"))[:4].lower()
    s["kicker"] = clip(r.get("kicker"), lim["kicker"])
    s["heading"] = clip(r.get("heading"), lim["title"] if s["layout"] == "title" else lim["heading"])
    s["lead"] = clip(r.get("lead"), lim["subtitle"] if s["layout"] == "title" else lim["lead"])
    lo, hi = lim["points"]
    points = _points(r.get("points"), lim)
    if s["layout"] == "agenda":
        s["points"] = [{"term": "", "text": clip(p["text"], lim["agenda"])} for p in points][: lim["agenda_items"]]
    else:
        s["points"] = points[:hi]
    s["left"], s["right"] = _column(r.get("left"), lim), _column(r.get("right"), lim)
    stat = _dict(r.get("stat"))
    s["stat"] = {"value": clip(stat.get("value"), lim["value"]), "label": clip(stat.get("label"), lim["stat_label"])}
    quote = _dict(r.get("quote"))
    s["quote"] = {"text": clip(quote.get("text"), lim["quote"]).strip("\"'“”"), "by": clip(quote.get("by"), lim["by"])}
    s["takeaways"] = [t for t in (clip(t, lim["takeaway"]) for t in _list(r.get("takeaways"))) if t][: lim["takeaways"]]
    s["closing"] = clip(r.get("closing"), lim["closing"])
    s["notes"] = clip(r.get("notes"), lim["notes"])
    s["sources"] = _sources(r.get("sources"))
    try:
        s["shrink"] = max(0, min(int(r.get("shrink") or 0), 4))
    except (TypeError, ValueError):
        s["shrink"] = 0

    # A layout missing what it needs becomes a simpler one, so the drawing never meets an empty slot.
    lay = s["layout"]
    if lay == "two_column" and not (s["left"]["items"] and s["right"]["items"]):
        merged = [{"term": "", "text": t} for t in s["left"]["items"] + s["right"]["items"]]
        s["points"] = s["points"] or merged[:hi]
        lay = "points"
    if lay == "stat" and not (s["stat"]["value"] and s["stat"]["label"]):
        lay = "points"
    if lay == "quote" and not s["quote"]["text"]:
        lay = "points"
    if lay == "agenda" and len(s["points"]) < 2:
        lay = "section"
    if lay == "closing" and not s["takeaways"] and not s["closing"]:
        lay = "section"
    if lay == "points" and len(s["points"]) < lo:
        if s["points"] and not s["lead"]:  # one point: say it as the slide's lead
            s["lead"] = clip(s["points"][0]["text"], lim["lead"])
        s["points"] = []
        lay = "section"
    if lay != s["layout"]:
        s["variant"] = ""
    s["layout"] = lay
    if not s["heading"]:
        s["heading"] = s["kicker"] or (s["closing"] if lay == "closing" else "")
    if not s["heading"] and lay not in ("quote", "closing"):
        return None
    return s


def clamp_deck(raw: object, fmt: str) -> dict | None:
    """The deck in the fixed shape, or None when it has no slide that can be shown."""
    r = _dict(raw)
    lim = LIMITS[fmt if fmt in FORMATS else "detailed"]
    slides = [s for s in (clamp_slide(x, fmt) for x in _list(r.get("slides"))) if s]
    if not slides:
        return None
    title = clip(r.get("title"), lim["title"]) or (slides[0]["heading"] if slides[0]["layout"] == "title" else "") or "Slide deck"
    return {"title": title, "subtitle": clip(r.get("subtitle"), lim["subtitle"]), "slides": slides}

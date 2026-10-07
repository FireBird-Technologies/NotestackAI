"""Where everything on a slide goes. Each theme has its own composition for every layout variant (GEOMETRY), the
variant of each slide is picked by code (assign_variants), and compose() turns one slide into placed elements: boxes
in pixels on the 1920 x 1080 canvas, each with its text and font size. The HTML and the PowerPoint both draw these
same elements, so the two always match.

Text is measured here before it is placed: every text box gets the largest font size at which its text fits, and
text that cannot fit even at the smallest size is shortened. Nothing is ever drawn outside its box."""

import copy
import math
import random
import re
from dataclasses import dataclass, field

from app.slides.content import LIMITS, clip
from app.slides.metrics import WIDTHS
from app.slides.themes import theme_id

# --- geometry -------------------------------------------------------------------------------------------------------
# A block is (x, y, w, h[, align[, valign[, kind]]]). `kind` says how a body, a column or the closing line is drawn.
# Dark space: cinematic, centred openers and closers, asymmetric splits. Light space: editorial, left aligned, top
# anchored, mirrored splits.

GEOMETRY: dict[str, dict[str, dict[str, dict[str, tuple]]]] = {
    "dark-space": {
        "title": {
            "a": {"kicker": (360, 258, 1200, 40, "center"), "heading": (160, 312, 1600, 300, "center", "middle"),
                  "lead": (360, 636, 1200, 130, "center")},
            "b": {"kicker": (140, 512, 1100, 40), "heading": (140, 562, 1150, 290, "left", "bottom"),
                  "lead": (140, 872, 1000, 120)},
            "c": {"kicker": (140, 286, 860, 40), "heading": (140, 340, 880, 400, "left", "middle"),
                  "lead": (140, 762, 860, 150)},
        },
        "agenda": {
            "a": {"kicker": (140, 160, 700, 40), "heading": (140, 212, 700, 420),
                  "body": (960, 140, 820, 820, "left", "middle", "agenda_list")},
            "b": {"kicker": (360, 110, 1200, 40, "center"), "heading": (260, 160, 1400, 130, "center", "middle"),
                  "body": (220, 340, 1480, 620, "left", "top", "agenda_grid")},
        },
        "section": {
            "a": {"kicker": (360, 368, 1200, 40, "center"), "heading": (210, 420, 1500, 240, "center", "middle"),
                  "lead": (410, 684, 1100, 150, "center")},
            "b": {"kicker": (140, 552, 1100, 40), "heading": (140, 604, 1300, 240, "left", "bottom"),
                  "lead": (140, 864, 1100, 120)},
        },
        "points": {
            "a": {"kicker": (140, 100, 1300, 40), "heading": (140, 150, 1360, 150), "lead": (140, 314, 1300, 110),
                  "body": (140, 446, 1300, 534, "left", "top", "list")},
            "b": {"kicker": (140, 160, 640, 40), "heading": (140, 212, 640, 500), "lead": (140, 730, 640, 240),
                  "body": (880, 130, 900, 840, "left", "middle", "list")},
            "c": {"kicker": (140, 100, 1640, 40), "heading": (140, 150, 1640, 140), "lead": (140, 302, 1640, 100),
                  "body": (140, 432, 1640, 548, "left", "top", "cards")},
            "d": {"kicker": (140, 160, 700, 40), "heading": (140, 212, 700, 430), "lead": (140, 662, 700, 300),
                  "body": (930, 110, 850, 860, "left", "middle", "timeline_v")},
        },
        "two_column": {
            "a": {"kicker": (140, 100, 1640, 40), "heading": (140, 150, 1640, 140), "lead": (140, 302, 1640, 100),
                  "left": (140, 432, 790, 548, "left", "top", "col"), "right": (990, 432, 790, 548, "left", "top", "col")},
            "b": {"kicker": (360, 90, 1200, 40, "center"), "heading": (210, 140, 1500, 130, "center", "middle"),
                  "lead": (360, 282, 1200, 90, "center"),
                  "left": (140, 410, 780, 570, "left", "top", "panel"), "right": (1000, 410, 780, 570, "left", "top", "panel")},
        },
        "stat": {
            "a": {"kicker": (360, 120, 1200, 40, "center"), "heading": (260, 170, 1400, 130, "center", "middle"),
                  "value": (160, 318, 1600, 300, "center", "middle"), "label": (360, 630, 1200, 120, "center"),
                  "lead": (410, 776, 1100, 180, "center")},
            "b": {"kicker": (140, 150, 820, 40), "value": (140, 206, 820, 420, "left", "middle"),
                  "label": (140, 650, 820, 300), "heading": (1060, 160, 720, 290, "left", "bottom"),
                  "lead": (1060, 480, 720, 480)},
        },
        "quote": {
            "a": {"kicker": (360, 150, 1200, 40, "center"), "quote": (210, 214, 1500, 500, "center", "middle"),
                  "by": (360, 740, 1200, 60, "center"), "heading": (360, 846, 1200, 110, "center")},
            "b": {"kicker": (140, 150, 640, 40), "heading": (140, 202, 640, 400), "lead": (140, 630, 640, 320),
                  "quote": (900, 160, 880, 640, "left", "middle"), "by": (900, 820, 880, 60)},
        },
        "closing": {
            "a": {"kicker": (360, 90, 1200, 40, "center"), "heading": (210, 140, 1500, 120, "center", "middle"),
                  "body": (140, 300, 1640, 430, "center", "top", "take_arc"),
                  "closing": (260, 760, 1400, 190, "center", "middle", "line")},
            "b": {"kicker": (140, 100, 1640, 40), "heading": (140, 150, 1640, 120),
                  "body": (140, 308, 1640, 450, "left", "top", "take_cols"),
                  "closing": (140, 800, 1640, 170, "left", "middle", "band")},
            "c": {"kicker": (140, 190, 820, 40), "closing": (140, 244, 820, 600, "left", "middle", "big"),
                  "heading": (1060, 150, 720, 110), "body": (1060, 290, 720, 680, "left", "top", "take_stack")},
        },
    },
    "light-space": {
        "title": {
            "a": {"kicker": (140, 318, 1150, 40), "heading": (140, 368, 1150, 350), "lead": (140, 738, 1000, 150)},
            "b": {"kicker": (140, 120, 1640, 40), "heading": (140, 174, 1640, 430, "left", "bottom"), "lead": (140, 640, 1150, 170)},
            "c": {"kicker": (360, 326, 1200, 40, "center"), "heading": (300, 378, 1320, 270, "center", "middle"),
                  "lead": (410, 670, 1100, 130, "center")},
        },
        "agenda": {
            "a": {"kicker": (140, 110, 1640, 40), "heading": (140, 160, 1640, 130),
                  "body": (140, 336, 1640, 630, "left", "top", "agenda_grid")},
            "b": {"kicker": (140, 376, 640, 40), "heading": (140, 428, 640, 320),
                  "body": (900, 130, 880, 840, "left", "middle", "agenda_list")},
        },
        "section": {
            "a": {"kicker": (140, 408, 1300, 40), "heading": (140, 460, 1300, 240), "lead": (140, 716, 1100, 150)},
            "b": {"kicker": (620, 408, 1160, 40, "right"), "heading": (480, 460, 1300, 240, "right"),
                  "lead": (680, 716, 1100, 150, "right")},
        },
        "points": {
            "a": {"kicker": (140, 100, 1640, 40), "heading": (140, 150, 1640, 140), "lead": (140, 302, 1500, 100),
                  "body": (140, 432, 1640, 548, "left", "top", "list2")},
            "b": {"kicker": (1180, 160, 600, 40), "heading": (1180, 212, 600, 500), "lead": (1180, 730, 600, 240),
                  "body": (140, 130, 940, 840, "left", "middle", "list")},
            "c": {"kicker": (140, 100, 1640, 40), "heading": (140, 150, 1640, 140), "lead": (140, 302, 1640, 100),
                  "body": (140, 432, 1640, 548, "left", "top", "cards")},
            "d": {"kicker": (140, 100, 1640, 40), "heading": (140, 150, 1640, 140), "lead": (140, 302, 1640, 100),
                  "body": (140, 440, 1640, 540, "left", "top", "timeline_h")},
        },
        "two_column": {
            "a": {"kicker": (140, 100, 1640, 40), "heading": (140, 150, 1640, 140), "lead": (140, 302, 1640, 100),
                  "left": (140, 432, 790, 548, "left", "top", "panel"), "right": (990, 432, 790, 548, "left", "top", "panel")},
            "b": {"kicker": (140, 160, 560, 40), "heading": (140, 212, 560, 420), "lead": (140, 650, 560, 320),
                  "left": (780, 130, 1000, 400, "left", "top", "col"), "right": (780, 566, 1000, 400, "left", "top", "col")},
        },
        "stat": {
            "a": {"kicker": (140, 100, 1640, 40), "heading": (140, 150, 1640, 140),
                  "value": (140, 330, 900, 360, "left", "middle"), "label": (140, 700, 900, 260),
                  "lead": (1120, 360, 660, 600)},
            "b": {"kicker": (360, 130, 1200, 40, "center"), "value": (260, 186, 1400, 320, "center", "middle"),
                  "label": (360, 526, 1200, 120, "center"), "heading": (260, 690, 1400, 110, "center", "middle"),
                  "lead": (410, 820, 1100, 150, "center")},
        },
        "quote": {
            "a": {"kicker": (140, 100, 1640, 40), "heading": (140, 150, 1640, 110),
                  "quote": (250, 300, 1430, 470, "left", "middle"), "by": (250, 796, 1430, 60)},
            "b": {"kicker": (620, 130, 1160, 40, "right"), "heading": (620, 180, 1160, 110, "right"),
                  "quote": (420, 330, 1360, 450, "right", "middle"), "by": (620, 806, 1160, 60, "right")},
        },
        "closing": {
            "a": {"kicker": (140, 100, 1640, 40), "heading": (140, 150, 1640, 120),
                  "body": (140, 318, 1640, 440, "left", "top", "take_cols"),
                  "closing": (140, 800, 1640, 170, "left", "middle", "band")},
            "b": {"kicker": (140, 110, 1640, 40), "closing": (140, 160, 1500, 390, "left", "top", "big"),
                  "heading": (140, 590, 1640, 80), "body": (140, 690, 1640, 290, "left", "top", "take_row")},
            "c": {"kicker": (360, 130, 1200, 40, "center"), "heading": (260, 180, 1400, 110, "center", "middle"),
                  "body": (410, 330, 1100, 410, "left", "top", "take_stack"),
                  "closing": (260, 772, 1400, 180, "center", "middle", "line")},
        },
    },
}

VARIANTS = {layout: tuple(GEOMETRY["dark-space"][layout]) for layout in GEOMETRY["dark-space"]}


def block(theme: str, layout: str, variant: str, name: str) -> tuple | None:
    g = GEOMETRY[theme_id(theme)][layout].get(variant) or next(iter(GEOMETRY[theme_id(theme)][layout].values()))
    b = g.get(name)
    if not b:
        return None
    x, y, w, h, *rest = b
    return (x, y, w, h, rest[0] if rest else "left", rest[1] if len(rest) > 1 else "top", rest[2] if len(rest) > 2 else "")


# --- picking variants -----------------------------------------------------------------------------------------------

def _fits(slide: dict, theme: str, variant: str) -> bool:
    """Whether a variant suits this slide's content (a card row needs 3 or 4 points, a timeline 3 to 5)."""
    layout = slide["layout"]
    n = len(slide["points"])
    kind = (block(theme, layout, variant, "body") or (0, 0, 0, 0, "", "", ""))[6]
    if kind == "cards":
        return 3 <= n <= 4
    if kind in ("timeline_v", "timeline_h"):
        return 3 <= n <= 5
    if kind == "list2":
        return n >= 3
    if kind == "agenda_list":
        return n <= 7
    return True


def assign_variants(slides: list[dict], theme: str, seed: int, previous: list[tuple[str, str]] | None = None) -> None:
    """Give every slide a variant, in place. Only variants that suit the slide are considered; the previous slide's
    layout and variant is never repeated; variants not used yet in this deck come first; and the variant the last deck
    in the notebook had at the same position is avoided. Ties are broken by `seed` (the deck's own id), so every new
    deck differs while one deck always draws the same."""
    theme = theme_id(theme)
    rnd = random.Random(seed)
    used: dict[tuple[str, str], int] = {}
    before: tuple[str, str] | None = None
    previous = previous or []
    for i, s in enumerate(slides):
        options = [v for v in VARIANTS[s["layout"]] if _fits(s, theme, v)] or list(VARIANTS[s["layout"]])
        fresh = [v for v in options if (s["layout"], v) != before]
        if not fresh:  # the only variant that suits it was just used: any other one draws it too, so never repeat
            fresh = [v for v in VARIANTS[s["layout"]] if (s["layout"], v) != before] or options
        last_time = previous[i] if i < len(previous) else None

        scores = {v: (used.get((s["layout"], v), 0), 1 if last_time == (s["layout"], v) else 0, rnd.random())
                  for v in fresh}
        choice = min(fresh, key=scores.__getitem__)
        s["variant"] = choice
        used[(s["layout"], choice)] = used.get((s["layout"], choice), 0) + 1
        before = (s["layout"], choice)


# --- measuring text -------------------------------------------------------------------------------------------------

def _char_w(c: str, font: str, bold: bool) -> float:
    """Advance of one character in em, from the fonts' measured widths, padded a little so real text is never wider."""
    if font == "mono":
        return 0.62
    table = WIDTHS["display_bold" if font == "display" else "body_bold" if bold else "body"]
    w = table.get(c)
    if w is None:
        w = 1.0 if ord(c) >= 0x2E80 else 0.64  # full width scripts, and anything else not measured
    return w * 1.03


@dataclass
class Run:
    text: str
    bold: bool = False
    color: str = "ink"


def _lines(runs: list[Run], width: float, size: float, font: str, upper: bool, track: float) -> int:
    """Lines a paragraph wraps to in `width` pixels."""
    words: list[tuple[str, bool]] = []
    for r in runs:
        t = r.text.upper() if upper else r.text
        words += [(w, r.bold) for w in t.split(" ") if w]
    if not words:
        return 0
    space = (_char_w(" ", font, False) + track) * size
    lines, x = 1, 0.0
    for word, bold in words:
        ww = sum((_char_w(c, font, bold) + track) * size for c in word)
        if ww > width:  # a word longer than the line breaks anywhere
            extra = x + (space if x else 0) + ww
            lines += int(extra // width)
            x = extra % width
            continue
        need = ww if x == 0 else x + space + ww
        if need <= width:
            x = need
        else:
            lines += 1
            x = ww
    return lines


# --- placed elements ------------------------------------------------------------------------------------------------

@dataclass
class El:
    kind: str  # text | rect | circle | line
    role: str
    x: float
    y: float
    w: float
    h: float
    paras: list[list[Run]] = field(default_factory=list)
    size: float = 0
    lh: float = 1.3
    font: str = "body"  # display | body | mono
    align: str = "left"
    valign: str = "top"
    upper: bool = False
    track: float = 0.0  # letter spacing in em
    gap: float = 0.0  # space between paragraphs, in px
    fill: str | None = None  # palette key
    stroke: str | None = None
    stroke_w: float = 0
    radius: float = 0
    opacity: float = 1.0

    def text_height(self) -> float:
        return text_height(self.paras, self.w, self.size, self.lh, self.font, self.upper, self.track, self.gap)


def text_height(paras: list[list[Run]], width: float, size: float, lh: float, font: str, upper: bool = False,
                track: float = 0.0, gap: float = 0.0) -> float:
    n = [_lines(p, width, size, font, upper, track) for p in paras]
    used = [k for k in n if k]
    return sum(k * size * lh for k in used) + max(len(used) - 1, 0) * gap


SCALES = (1.0, 0.92, 0.85, 0.78, 0.72, 0.66, 0.6, 0.55)
GROW = (1.4, 1.28, 1.18, 1.08)  # sparse content is drawn larger, so a slide with little on it is not half empty


def _scales(start: int, grow: bool = False) -> tuple[float, ...]:
    """Scales to try, largest first: from `start` down, with the growing ones first when allowed and not shrunk."""
    return (GROW + SCALES) if grow and start == 0 else SCALES[start:]

# Base font sizes in px, by format. Presenter slides carry fewer words, so they are drawn larger.
TYPE = {
    "detailed": {"kicker": 22, "heading": 60, "title": 100, "section": 80, "lead": 30, "title_lead": 34, "point": 28,
                 "card_term": 30, "card_text": 25, "value": 220, "label": 34, "quote": 52, "by": 24, "take": 28,
                 "closing": 46, "closing_big": 66, "agenda": 32, "col_label": 28, "col_item": 27, "num": 22,
                 "footer": 18},
    "presenter": {"kicker": 24, "heading": 72, "title": 112, "section": 92, "lead": 36, "title_lead": 38,
                  "point": 40, "card_term": 34, "card_text": 34, "value": 260, "label": 40, "quote": 60, "by": 26,
                  "take": 36, "closing": 56, "closing_big": 78, "agenda": 36, "col_label": 30, "col_item": 36,
                  "num": 24, "footer": 18},
}


def _fit_size(paras: list[list[Run]], width: float, height: float, base: float, lh: float, font: str,
              start: int, upper: bool = False, track: float = 0.0, gap_em: float = 0.0, grow: bool = False) -> float | None:
    """The largest size (base times a scale, from `start` down) at which the paragraphs fit the box, or None."""
    for scale in _scales(start, grow):
        size = round(base * scale, 1)
        if text_height(paras, width, size, lh, font, upper, track, size * gap_em) <= height:
            return size
    return None


class NoFit(Exception):
    """Text that does not fit even at the smallest size: the caller shortens it and tries again."""

    def __init__(self, field_name: str, index: int | None = None):
        super().__init__(field_name)
        self.field_name = field_name
        self.index = index


@dataclass
class Composed:
    slide: dict  # the slide as drawn (text shortened when it had to be)
    elements: list[El]
    seed: int


def _text(role: str, rect: tuple, paras: list[list[Run]], base: float, start: int, *, font: str = "body",
          lh: float = 1.35, upper: bool = False, track: float = 0.0, gap_em: float = 0.0, field_name: str = "",
          index: int | None = None, grow: bool = False) -> El:
    x, y, w, h, align, valign = rect[:6]
    size = _fit_size(paras, w, h, base, lh, font, start, upper, track, gap_em, grow)
    if size is None:
        raise NoFit(field_name or role, index)
    return El("text", role, x, y, w, h, paras=paras, size=size, lh=lh, font=font, align=align, valign=valign,
              upper=upper, track=track, gap=size * gap_em)


def _point_runs(p: dict, fmt: str) -> list[Run]:
    if p["term"] and fmt == "detailed":
        return [Run(p["term"] + ".", True, "ink"), Run(" " + p["text"], False, "mute")]
    return [Run(p["text"], False, "ink")]


def _body(els: list[El], s: dict, rect: tuple, kind: str, fmt: str, t: dict, start: int, dark: bool) -> None:
    """The slide's main content: points, agenda items or takeaways, drawn as `kind`."""
    x, y, w, h, _align, valign, _ = rect
    pts = s["points"]

    if kind in ("list", "list2", "agenda_list", "agenda_grid", "take_stack"):
        if kind in ("agenda_list", "agenda_grid"):
            items = [[Run(p["text"], False, "ink")] for p in pts]
            base, numbered = t["agenda"], True
        elif kind == "take_stack":
            items = [[Run(tx, False, "ink")] for tx in s["takeaways"]]
            base, numbered = t["take"], True
        else:
            items = [_point_runs(p, fmt) for p in pts]
            base, numbered = t["point"], False
        cols = 2 if kind in ("list2", "agenda_grid") and len(items) >= 3 else 1
        per = math.ceil(len(items) / cols)
        col_gap = 70
        cw = (w - col_gap * (cols - 1)) / cols
        indent = 78 if numbered else 44
        tw = cw - indent
        # One size for every item: the largest at which the tallest column fits with breathing room between items.
        size = None
        for scale in _scales(start, True):
            sz = round(base * scale, 1)
            gap = sz * 0.9
            heights = [text_height([it], tw, sz, 1.38, "body") for it in items]
            tallest = max(sum(heights[c * per:(c + 1) * per]) + gap * (len(heights[c * per:(c + 1) * per]) - 1)
                          for c in range(cols))
            if tallest <= h:
                size = sz
                break
        if size is None:
            raise NoFit("takeaways" if kind == "take_stack" else "points")
        heights = [text_height([it], tw, size, 1.38, "body") for it in items]
        for c in range(cols):
            chunk = list(range(c * per, min((c + 1) * per, len(items))))
            total = sum(heights[i] for i in chunk)
            free = h - total
            gap = min(free / max(len(chunk) - 1, 1), size * 2.2) if len(chunk) > 1 else 0
            block_h = total + gap * max(len(chunk) - 1, 0)
            cy = y + (h - block_h) / 2 if valign == "middle" else y
            cx = x + c * (cw + col_gap)
            for i in chunk:
                ih = heights[i]
                if numbered:
                    els.append(El("text", "num", cx, cy + size * 0.12, 64, size * 1.3, paras=[[Run(f"{i + 1:02d}", True, "accent")]],
                                  size=round(size * 0.82, 1), lh=1.2, font="mono"))
                else:
                    d = size * 0.34
                    els.append(El("circle", "dot", cx + 4, cy + size * 0.69 - d / 2, d, d, fill="accent"))
                els.append(El("text", "item", cx + indent, cy, tw, ih + 2, paras=[items[i]], size=size, lh=1.38))
                if numbered and kind != "take_stack" and i != chunk[-1]:
                    els.append(El("line", "rule", cx + indent, cy + ih + gap / 2, tw, 0, stroke="line", stroke_w=1.5))
                cy += ih + gap
        return

    if kind in ("cards", "take_cols", "take_row", "take_arc"):
        if kind == "cards":
            cells = [(p["term"] if fmt == "detailed" else "", p["text"]) for p in pts]
        else:
            cells = [("", tx) for tx in s["takeaways"]]
        n = max(len(cells), 1)
        gap = 36 if kind != "take_row" else 60
        cw = (w - gap * (n - 1)) / n
        boxed = kind in ("cards", "take_cols")
        pad = 40 if boxed else 0
        top = 0.0
        if kind == "take_arc":
            top = 120  # the glowing marker above each takeaway
        elif kind == "take_row":
            top = 70
        else:
            top = 64  # number row inside the card
        inner_w = cw - 2 * pad
        inner_h = h - 2 * pad - top
        term_base = t["card_term"]
        text_base = t["card_text"] if kind == "cards" else t["take"]
        size = None
        for scale in _scales(start, True):
            ts, xs = round(term_base * scale, 1), round(text_base * scale, 1)
            ok = True
            for term, text in cells:
                hh = (text_height([[Run(term, True)]], inner_w, ts, 1.15, "display") + ts * 0.5 if term else 0)
                hh += text_height([[Run(text)]], inner_w, xs, 1.4, "body")
                if hh > inner_h:
                    ok = False
                    break
            if ok:
                size = (ts, xs)
                break
        if size is None:
            raise NoFit("takeaways" if kind != "cards" else "points")
        ts, xs = size
        # Cards as tall as the tallest content (not the whole box), so short text does not float in a tall card.
        tallest = max((text_height([[Run(term, True)]], inner_w, ts, 1.15, "display") + ts * 0.5 if term else 0)
                      + text_height([[Run(text)]], inner_w, xs, 1.4, "body") for term, text in cells)
        h = min(h, tallest + 2 * pad + top + 12)
        for i, (term, text) in enumerate(cells):
            cx = x + i * (cw + gap)
            if boxed:
                els.append(El("rect", "card", cx, y, cw, h, fill="card", stroke="cardline", stroke_w=2, radius=22))
            if kind == "take_arc":
                r = 46
                els.append(El("circle", "halo", cx + cw / 2 - r * 1.5, y + 2 - r * 0.5, r * 3, r * 3, fill="accent2", opacity=0.18))
                els.append(El("circle", "marker", cx + cw / 2 - r, y + 2, r * 2, r * 2, fill="accent2"))
                els.append(El("text", "num", cx + cw / 2 - r, y + 2, r * 2, r * 2, paras=[[Run(f"{i + 1}", True, "white")]],
                              size=34, lh=1.0, font="display", align="center", valign="middle"))
            elif kind == "take_row":
                els.append(El("rect", "bar", cx, y, cw, 5, fill="accent"))
                els.append(El("text", "num", cx, y + 20, cw, 34, paras=[[Run(f"{i + 1:02d}", True, "accent")]],
                              size=24, lh=1.2, font="mono"))
            else:
                els.append(El("text", "num", cx + pad, y + pad, inner_w, 34, paras=[[Run(f"{i + 1:02d}", True, "accent")]],
                              size=t["num"], lh=1.2, font="mono"))
            cy = y + pad + top
            align = "center" if kind == "take_arc" else "left"
            if term:
                th = text_height([[Run(term, True)]], inner_w, ts, 1.15, "display")
                els.append(El("text", "term", cx + pad, cy, inner_w, th + 2, paras=[[Run(term, True, "ink")]], size=ts,
                              lh=1.15, font="display", align=align))
                cy += th + ts * 0.5
            els.append(El("text", "item", cx + pad, cy, inner_w, y + h - pad - cy, paras=[[Run(text, False, "mute" if term else "ink")]],
                          size=xs, lh=1.4, align=align))
        return

    if kind in ("timeline_v", "timeline_h"):
        items = [_point_runs(p, fmt) for p in pts]
        n = len(items)
        r = 28
        if kind == "timeline_v":
            tw = w - 96
            size = None
            for scale in _scales(start, True):
                sz = round(t["point"] * scale, 1)
                heights = [max(text_height([it], tw, sz, 1.38, "body"), r * 2) for it in items]
                if sum(heights) + sz * 1.2 * (n - 1) <= h:
                    size = sz
                    break
            if size is None:
                raise NoFit("points")
            heights = [max(text_height([it], tw, size, 1.38, "body"), r * 2) for it in items]
            gap = min((h - sum(heights)) / max(n - 1, 1), size * 2.4)
            total = sum(heights) + gap * (n - 1)
            cy = y + (h - total) / 2 if valign == "middle" else y
            els.append(El("line", "spine", x + r, cy + r, 0, total - 2 * r if total > 2 * r else 0, stroke="line", stroke_w=3))
            for i, it in enumerate(items):
                els.append(El("circle", "marker", x, cy, r * 2, r * 2, fill="card", stroke="accent", stroke_w=3))
                els.append(El("text", "num", x, cy, r * 2, r * 2, paras=[[Run(str(i + 1), True, "accent")]], size=24, lh=1.0,
                              font="display", align="center", valign="middle"))
                els.append(El("text", "item", x + 96, cy + max((r * 2 - size * 1.38) / 2, 0) if heights[i] <= r * 2 else cy,
                              tw, heights[i] + 2, paras=[it], size=size, lh=1.38))
                cy += heights[i] + gap
        else:
            gap = 40
            cw = (w - gap * (n - 1)) / n
            th = h - r * 2 - 40
            size = _fit_all([[it] for it in items], cw, th, t["point"] * 0.9, 1.38, start)
            if size is None:
                raise NoFit("points")
            els.append(El("line", "spine", x + r, y + r, w - 2 * r, 0, stroke="line", stroke_w=3))
            for i, it in enumerate(items):
                cx = x + i * (cw + gap)
                els.append(El("circle", "marker", cx, y, r * 2, r * 2, fill="card", stroke="accent", stroke_w=3))
                els.append(El("text", "num", cx, y, r * 2, r * 2, paras=[[Run(str(i + 1), True, "accent")]], size=24, lh=1.0,
                              font="display", align="center", valign="middle"))
                els.append(El("text", "item", cx, y + r * 2 + 40, cw, th, paras=[it], size=size, lh=1.38))
        return
    raise ValueError(f"unknown body kind {kind}")


def _fit_all(blocks: list[list[list[Run]]], width: float, height: float, base: float, lh: float, start: int) -> float | None:
    for scale in _scales(start, True):
        size = round(base * scale, 1)
        if all(text_height(b, width, size, lh, "body") <= height for b in blocks):
            return size
    return None


def _columns(els: list[El], s: dict, rects: tuple[tuple, tuple], t: dict, start: int) -> None:
    """The two sides of a comparison, at one font size, each panel as tall as the taller side's content."""
    kind = rects[0][6]
    pad = 44 if kind == "panel" else 0
    top = 0 if kind == "panel" else 28
    sides = [s["left"], s["right"]]

    def measure(col: dict, iw: float, ls: float, xs: float) -> tuple[float, list[float]]:
        label = [[Run(col["label"], True, "accent")]] if col["label"] else []
        lab = text_height(label, iw, ls, 1.2, "display") + (xs * 0.9 if label else 0)
        heights = [text_height([[Run(i)]], iw - 40, xs, 1.38, "body") for i in col["items"]]
        return lab + sum(heights) + xs * 0.75 * (len(heights) - 1), heights

    for scale in _scales(start, True):
        ls, xs = round(t["col_label"] * scale, 1), round(t["col_item"] * scale, 1)
        need = [measure(col, r[2] - 2 * pad, ls, xs)[0] for col, r in zip(sides, rects, strict=True)]
        bad = [i for i, (n, r) in enumerate(zip(need, rects, strict=True)) if n > r[3] - 2 * pad - top]
        if not bad:
            break
    else:
        raise NoFit(("left", "right")[bad[0]] + "_items")
    panel_h = max(need) + 2 * pad + top + 8
    for col, (x, y, w, h, *_) in zip(sides, rects, strict=True):
        if kind == "panel":
            els.append(El("rect", "panel", x, y, w, min(h, panel_h), fill="card", stroke="cardline", stroke_w=2, radius=22))
        else:
            els.append(El("rect", "bar", x, y, 72, 5, fill="accent"))
        ix, iw = x + pad, w - 2 * pad
        cy = y + pad + top
        _, heights = measure(col, iw, ls, xs)
        if col["label"]:
            lab_h = text_height([[Run(col["label"], True)]], iw, ls, 1.2, "display")
            els.append(El("text", "col_label", ix, cy, iw, lab_h + 2, paras=[[Run(col["label"], True, "accent")]],
                          size=ls, lh=1.2, font="display"))
            cy += lab_h + xs * 0.9
        for item, hh in zip(col["items"], heights, strict=True):
            d = xs * 0.32
            els.append(El("circle", "dot", ix + 2, cy + xs * 0.69 - d / 2, d, d, fill="accent"))
            els.append(El("text", "item", ix + 40, cy, iw - 40, hh + 2, paras=[[Run(item, False, "ink")]], size=xs, lh=1.38))
            cy += hh + xs * 0.75


def _compose_once(s: dict, deck: dict, index: int, theme: str, fmt: str, start: int) -> list[El]:
    from app.slides.themes import THEMES

    t = TYPE[fmt]
    dark = THEMES[theme].dark
    layout, v = s["layout"], s["variant"]
    els: list[El] = []

    lead_slot = block(theme, layout, v, "lead")

    def rect(name: str) -> tuple | None:
        r = block(theme, layout, v, name)
        # No lead: what sits right under the lead's slot (in the same column) moves up into it.
        if r and name in ("body", "left", "right") and lead_slot and not s["lead"]:
            lx, ly, lw, lh_ = lead_slot[:4]
            if r[1] >= ly + lh_ - 2 and r[1] - (ly + lh_) < 80 and r[0] < lx + lw and lx < r[0] + r[2]:
                return (r[0], ly, r[2], r[3] + r[1] - ly, *r[4:])
        return r

    k = rect("kicker")
    if k and s["kicker"]:
        x, y, w, h, align, *_ = k
        bar_x = x + (w - 64) / 2 if align == "center" else (x + w - 64 if align == "right" else x)
        els.append(El("rect", "bar", bar_x, y - 18, 64, 5, fill="accent"))
        els.append(_text("kicker", k, [[Run(s["kicker"], True, "accent")]], t["kicker"], 0, font="mono", lh=1.2,
                         upper=True, track=0.16, field_name="kicker"))

    heading_base = {"title": t["title"], "section": t["section"]}.get(layout, t["heading"])
    hr = rect("heading")
    if hr and s["heading"]:
        els.append(_text("heading", hr, [[Run(s["heading"], True, "ink")]], heading_base, start, font="display",
                         lh=1.08, field_name="heading"))

    lr = rect("lead")
    if lr and s["lead"]:
        base = t["title_lead"] if layout == "title" else t["lead"]
        head = next((e for e in els if e.role == "heading"), None)
        if head and head.valign == "top" and abs(head.x - lr[0]) < 1 and head.y < lr[1]:
            # Under a top aligned heading in the same column: follow the heading instead of waiting at the box's top.
            top = head.y + head.text_height() + head.size * 0.55
            lr = (lr[0], top, lr[2], lr[1] + lr[3] - top, *lr[4:])
        els.append(_text("lead", lr, [[Run(s["lead"], False, "mute")]], base, start, lh=1.4, field_name="lead"))

    if layout == "stat":
        els.append(_text("value", rect("value"), [[Run(s["stat"]["value"], True, "accent")]], t["value"], start,
                         font="display", lh=1.0, field_name="stat_value"))
        els.append(_text("label", rect("label"), [[Run(s["stat"]["label"], False, "ink")]], t["label"], start, lh=1.35,
                         field_name="stat_label", grow=True))
    if layout == "quote":
        q = rect("quote")
        els.append(_text("quote", q, [[Run("“", True, "accent"), Run(s["quote"]["text"], False, "ink"),
                                       Run("”", True, "accent")]], t["quote"], start, font="display", lh=1.22,
                         field_name="quote", grow=True))
        if s["quote"]["by"] and (b := rect("by")):
            els.append(_text("by", b, [[Run(s["quote"]["by"], False, "mute")]], t["by"], 0, font="mono", lh=1.3,
                             upper=True, track=0.08, field_name="by"))
    if layout == "two_column":
        _columns(els, s, (rect("left"), rect("right")), t, start)
    br = rect("body")
    if br:
        _body(els, s, br, br[6], fmt, t, start, dark)
    cr = rect("closing")
    if cr and s["closing"]:
        kind = cr[6]
        if kind == "band":
            x, y, w, h, *_ = cr
            els.append(El("rect", "band", x, y, w, h, fill="band", radius=24))
            inner = (x + 60, y, w - 120, h, "left", "middle")
            els.append(_text("closing", inner, [[Run(s["closing"], True, "bandink")]], t["closing"], start,
                             font="display", lh=1.15, field_name="closing"))
        else:
            base = t["closing_big"] if kind == "big" else t["closing"]
            els.append(_text("closing", cr, [[Run(s["closing"], True, "ink")]], base, start, font="display", lh=1.12,
                             field_name="closing", grow=kind == "big"))

    if layout != "title":
        total = len(deck["slides"])
        foot = [[Run(clip(deck.get("title"), 70), False, "mute")]]
        els.append(El("text", "footer", 140, 1018, 1200, 30, paras=foot, size=t["footer"], lh=1.2, font="mono"))
        els.append(El("text", "footer", 1480, 1018, 300, 30, paras=[[Run(f"{index + 1:02d} / {total:02d}", False, "mute")]],
                      size=t["footer"], lh=1.2, font="mono", align="right"))
    return els


def _shorten(s: dict, err: NoFit, fmt: str) -> bool:
    """Make the text that did not fit shorter (or drop a point). False when there is nothing left to shorten."""
    lo = LIMITS[fmt]["points"][0]
    name = err.field_name

    def cut(text: str) -> str:
        return clip(text, max(int(len(text) * 0.82), 12)) if len(text) > 14 else text

    if name == "points":
        pts = s["points"]
        if s["layout"] == "agenda" or len(pts) > max(lo, 3):
            if len(pts) > 2:
                pts.pop()
                return True
        longest = max(range(len(pts)), key=lambda i: len(pts[i]["text"]) + len(pts[i]["term"]), default=None)
        if longest is None or len(pts[longest]["text"]) <= 14:
            return False
        pts[longest]["text"] = cut(pts[longest]["text"])
        return True
    if name == "takeaways":
        tk = s["takeaways"]
        i = max(range(len(tk)), key=lambda j: len(tk[j]), default=None)
        if i is None or len(tk[i]) <= 14:
            return False
        tk[i] = cut(tk[i])
        return True
    if name in ("left_items", "right_items"):
        col = s[name.split("_")[0]]
        if len(col["items"]) > 2:
            col["items"].pop()
            return True
        i = max(range(len(col["items"])), key=lambda j: len(col["items"][j]), default=None)
        if i is None or len(col["items"][i]) <= 14:
            return False
        col["items"][i] = cut(col["items"][i])
        return True
    path = {"stat_value": ("stat", "value"), "stat_label": ("stat", "label"), "quote": ("quote", "text"),
            "by": ("quote", "by")}.get(name)
    if path:
        holder, key = s[path[0]], path[1]
    elif name in s and isinstance(s[name], str):
        holder, key = s, name
    else:
        return False
    if len(holder[key]) <= 14:
        if name in ("lead", "by", "kicker"):
            holder[key] = ""
            return True
        return False
    holder[key] = cut(holder[key])
    return True


def compose(deck: dict, index: int, theme: str, fmt: str, seed: int = 0) -> Composed:
    """Slide `index` of a clamped deck, placed. Text that does not fit is shortened until it does; a slide that
    still cannot be drawn becomes a plain section slide with its heading."""
    theme, fmt = theme_id(theme), fmt if fmt in TYPE else "detailed"
    s = copy.deepcopy(deck["slides"][index])
    if s["variant"] not in VARIANTS[s["layout"]]:
        s["variant"] = VARIANTS[s["layout"]][0]
    start = min(int(s.get("shrink") or 0), len(SCALES) - 1)
    for _ in range(60):
        try:
            return Composed(s, _compose_once(s, deck, index, theme, fmt, start), seed)
        except NoFit as err:
            if not _shorten(s, err, fmt):
                break
    plain = {**copy.deepcopy(s), "layout": "section", "variant": VARIANTS["section"][0], "lead": "", "points": [],
             "heading": clip(s["heading"] or deck.get("title"), 60)}
    return Composed(plain, _compose_once(plain, deck, index, theme, fmt, 0), seed)


def seed_of(value: object) -> int:
    """A stable integer seed from a deck id."""
    digits = re.sub(r"[^0-9a-f]", "", str(value or "").lower())
    return int(digits[:12] or "0", 16)

"""From a written deck to what is stored and shown. `finish` picks each slide's variant, fits its text, and checks
the result in Chrome when one is installed. `restructure` takes a deck back from the editor and fits it again.
`view` reads a stored deck back (clamped again, so older or edited decks still draw) and gives its pages; one slide
that cannot be drawn becomes a plain one instead of breaking the deck."""

import copy
import logging
import random
from collections import Counter

from app.infographics.image import ImageUnavailable
from app.slides import export
from app.slides.content import clamp_deck, clamp_slide, empty_slide
from app.slides.layout import GEOMETRY, SCALES, VARIANTS, assign_variants, compose, fits_variant, seed_of
from app.slides.render import slide_html
from app.slides.themes import theme_id

log = logging.getLogger(__name__)


def fit(deck: dict, theme: str, fmt: str, seed: int) -> dict:
    """Every slide as it will be drawn: text shortened where it had to be, so what is stored is what is shown."""
    out = copy.deepcopy(deck)
    out["slides"] = [compose(out, i, theme, fmt, seed).slide for i in range(len(out["slides"]))]
    return out


def finish(deck: dict, theme: str, fmt: str, seed: int, previous: list[tuple[str, str]] | None = None) -> dict:
    """Variants, then refit. Raises ValueError when a slide cannot be drawn at all."""
    theme = theme_id(theme)
    deck = copy.deepcopy(deck)
    assign_variants(deck["slides"], theme, seed, previous)
    return refit(deck, theme, fmt, seed)


def refit(deck: dict, theme: str, fmt: str, seed: int) -> dict:
    """Fitted text and a Chrome check that no text box overflows (slides that do are drawn a step smaller and fitted
    again), keeping each slide's variant. Raises ValueError when a slide cannot be drawn at all."""
    theme = theme_id(theme)
    deck = fit(deck, theme, fmt, seed)
    for _ in range(3):
        try:
            bad = export.overflowing(deck, theme, fmt, seed)
        except ImageUnavailable:
            break  # no Chrome here: the measured fit alone keeps text inside its boxes
        if not bad:
            break
        log.info("slides %s overflow in Chrome, drawing them smaller", sorted(bad))
        for i in bad:
            deck["slides"][i]["shrink"] = min(int(deck["slides"][i].get("shrink") or 0) + 1, len(SCALES) - 1)
        deck = fit(deck, theme, fmt, seed)
    for i in range(len(deck["slides"])):
        slide_html(deck, i, theme, fmt, seed)  # raises if a slide cannot be drawn: better now than when shown
    return deck


class BadEdit(ValueError):
    """A deck sent back from the editor that cannot be kept (no slides, or too many)."""


MAX_SLIDES = 30


def fill_variants(slides: list[dict], theme: str, seed: int) -> None:
    """Give a variant, in place, to each slide that has none or whose variant no longer suits it (a new slide, a changed
    layout, a card row now with five points). Every other slide keeps its own, so editing one slide never redraws the
    rest. The choice follows assign_variants: suited to the content, not the same as a neighbour, unused ones first."""
    theme = theme_id(theme)
    def ok(i: int) -> bool:
        s = slides[i]
        return s["variant"] in VARIANTS[s["layout"]] and fits_variant(s, theme, s["variant"])
    keep = [ok(i) for i in range(len(slides))]
    for i, s in enumerate(slides):
        before = (slides[i - 1]["layout"], slides[i - 1]["variant"]) if i else None
        if keep[i] and (s["layout"], s["variant"]) != before:
            continue
        after = (slides[i + 1]["layout"], slides[i + 1]["variant"]) if i + 1 < len(slides) and keep[i + 1] else None
        options = [v for v in VARIANTS[s["layout"]] if fits_variant(s, theme, v)] or list(VARIANTS[s["layout"]])
        fresh = [v for v in options if (s["layout"], v) not in (before, after)] or options
        used = Counter((x["layout"], x["variant"]) for j, x in enumerate(slides) if j != i)
        rnd = random.Random(seed + i)
        s["variant"] = min(fresh, key=lambda v: (used[(s["layout"], v)], rnd.random()))
        keep[i] = True


def restructure(content: dict, slides: object, final: bool) -> dict:
    """The stored deck with the slides the editor sent (text edited, slides added, removed, moved, or changed to another
    layout). They are coerced like model output (clamp_deck: plain text, the format's limits, valid layouts), slides
    that need one get a variant, and the deck is fitted: quickly for a preview, with the Chrome check when `final`."""
    got = stored(content)
    if not got:
        raise BadEdit("This deck has no slides to edit.")
    deck, theme, fmt, seed = got
    if not isinstance(slides, list) or not slides:
        raise BadEdit("A deck needs at least one slide.")
    if len(slides) > MAX_SLIDES:
        raise BadEdit(f"A deck can have at most {MAX_SLIDES} slides.")
    new = clamp_deck({"title": deck["title"], "subtitle": deck["subtitle"], "slides": slides}, fmt)
    if not new:
        raise BadEdit("A deck needs at least one slide with a heading.")
    for s in new["slides"]:
        s["shrink"] = 0  # text changed: fitted afresh, so shorter text can be drawn larger again
    fill_variants(new["slides"], theme, seed)
    return refit(new, theme, fmt, seed) if final else fit(new, theme, fmt, seed)


def slots(content: dict) -> list[list[str]]:
    """For each slide, the parts its variant has a place for (kicker, lead, body, by, closing...): what the editor
    can offer to add."""
    got = stored(content)
    if not got:
        return []
    deck, theme, _fmt, _seed = got
    out = []
    for s in deck["slides"]:
        variants = GEOMETRY[theme][s["layout"]]
        out.append(sorted(k for k, v in (variants.get(s["variant"]) or next(iter(variants.values()))).items() if v))
    return out


def stored(content: dict) -> tuple[dict, str, str, int] | None:
    """A stored deck, clamped, with its theme, format and seed (None when there is none)."""
    fmt = content.get("format") if content.get("format") in ("detailed", "presenter") else "detailed"
    deck = clamp_deck(content.get("deck") or {}, fmt)
    if not deck:
        return None
    return deck, theme_id(content.get("theme")), fmt, seed_of(content.get("seed"))


def _placeholder(deck: dict, index: int) -> dict:
    s = empty_slide("section")
    s["heading"] = deck.get("title") or "Slide"
    return clamp_slide(s, "detailed")


def view(content: dict) -> list[str]:
    """Each slide of a stored deck as a standalone page."""
    got = stored(content)
    if not got:
        return []
    deck, theme, fmt, seed = got
    pages = []
    for i in range(len(deck["slides"])):
        try:
            pages.append(slide_html(deck, i, theme, fmt, seed))
        except Exception:
            log.exception("slide %s could not be drawn", i)
            safe = copy.deepcopy(deck)
            safe["slides"][i] = _placeholder(deck, i)
            pages.append(slide_html(safe, i, theme, fmt, seed))
    return pages

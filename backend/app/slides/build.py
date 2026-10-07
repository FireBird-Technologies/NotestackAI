"""From a written deck to what is stored and shown. `finish` picks each slide's variant, fits its text, and checks
the result in Chrome when one is installed. `view` reads a stored deck back (clamped again, so older or edited decks
still draw) and gives its pages; one slide that cannot be drawn becomes a plain one instead of breaking the deck."""

import copy
import logging

from app.infographics.image import ImageUnavailable
from app.slides import export
from app.slides.content import clamp_deck, clamp_slide, empty_slide
from app.slides.layout import SCALES, assign_variants, compose, seed_of
from app.slides.render import slide_html
from app.slides.themes import theme_id

log = logging.getLogger(__name__)


def fit(deck: dict, theme: str, fmt: str, seed: int) -> dict:
    """Every slide as it will be drawn: text shortened where it had to be, so what is stored is what is shown."""
    out = copy.deepcopy(deck)
    out["slides"] = [compose(out, i, theme, fmt, seed).slide for i in range(len(out["slides"]))]
    return out


def finish(deck: dict, theme: str, fmt: str, seed: int, previous: list[tuple[str, str]] | None = None) -> dict:
    """Variants, fitted text, and a Chrome check that no text box overflows (slides that do are drawn a step
    smaller and fitted again). Raises ValueError when a slide cannot be drawn at all."""
    theme = theme_id(theme)
    deck = copy.deepcopy(deck)
    assign_variants(deck["slides"], theme, seed, previous)
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

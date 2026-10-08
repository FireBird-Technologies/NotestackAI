"""Pours an infographic's content into a theme's premade HTML page. Autoescape is on and nothing is marked safe, so text
from the model can never add markup or scripts to the page."""

import hashlib
import random
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape
from markupsafe import Markup

from app.infographics.content import HEIGHT, WIDTH
from app.infographics.themes import DEFAULT_THEME, THEMES, theme_id

_ENV = Environment(loader=FileSystemLoader(Path(__file__).parent / "templates"), autoescape=select_autoescape(["j2"], default=True),
                   undefined=StrictUndefined, trim_blocks=True, lstrip_blocks=True)

# name -> (heading, body, mono, heading weight, heading case, label case)
_FONT = {"jost": "Jost", "outfit": "Outfit", "playfair": "Playfair Display", "cormorant": "Cormorant Garamond",
         "mono": "Space Mono"}


# The Notestack mark (the same icon as frontend/public/logo.svg), drawn beside the name on every page. Our own constant, never
# model text, so it is the one thing marked safe.
LOGO_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#fff"/>'
            '<circle cx="26" cy="36" r="13" fill="#000"/><ellipse cx="26" cy="36" rx="21" ry="5" fill="none" stroke="#000" '
            'stroke-width="3" transform="rotate(-18 26 36)"/><path d="M46 10l2.2 5.8 5.8 2.2-5.8 2.2-2.2 5.8-2.2-5.8-5.8-2.2 '
            '5.8-2.2z" fill="#000"/></svg>')

SIZES = {"portrait": (WIDTH, HEIGHT), "landscape": (HEIGHT, WIDTH)}  # the page is drawn at either shape


def _stars(seed: str, w: int, h: int, n: int = 70) -> list[tuple[int, int, float, float]]:
    rnd = random.Random(int(hashlib.sha1(seed.encode()).hexdigest()[:8], 16))
    return [(rnd.randint(0, w), rnd.randint(0, h), round(rnd.choice((1.5, 2, 2, 3, 4)), 1), round(rnd.uniform(.15, .6), 2))
            for _ in range(n)]


def build_html(theme: str, content: dict, layout: str = "portrait") -> str:
    """The page for `content` (as returned by content.clamp) in the theme (the default when unknown), tall (portrait)
    or wide (landscape: the same words, the title and takeaway in a column beside the theme's drawing)."""
    tid = theme_id(theme)
    layout = layout if layout in SIZES else "portrait"
    w, h = SIZES[layout]
    tpl = _ENV.get_template(f"{tid}.html.j2")
    return tpl.render(c=content, width=w, height=h, layout=layout, logo=Markup(LOGO_SVG), stars=_stars(content["title"] + tid, w, h))


def thumbnail_html(theme: str, content: dict, layout: str = "portrait") -> str:
    """The page as a standalone document, for rendering a preview outside the app."""
    return f'<!doctype html><meta charset="utf-8"><body style="margin:0">{build_html(theme, content, layout)}</body>'


__all__ = ["build_html", "LOGO_SVG", "thumbnail_html", "SIZES", "THEMES", "DEFAULT_THEME"]

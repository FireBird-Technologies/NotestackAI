"""The premade themes: one HTML template each (templates/<id>.html.j2), all space themed with muted palettes."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Theme:
    id: str
    name: str
    blurb: str
    swatch: tuple[str, str, str]  # background, accent, second accent: for the picker card


THEMES: dict[str, Theme] = {t.id: t for t in (
    Theme("launch", "Launch", "A rocket, stage by stage, with a countdown", ("#1d2a34", "#cfa24d", "#c8745f")),
    Theme("galaxy", "Galaxy", "Spiral arms and glowing orbit rings", ("#241f33", "#b79ad6", "#7fa3b8")),
    Theme("solar", "Solar System", "Planets in a row and a route between them", ("#1b2433", "#d9a441", "#7fa3b8")),
    Theme("station", "Space Station", "A blueprint of modules and solar wings", ("#16283a", "#8fb8c9", "#d9a441")),
    Theme("moonbase", "Moon Base", "A lunar surface, a dome and a flag", ("#2b2b30", "#d8d2c4", "#c8745f")),
    Theme("observatory", "Observatory", "A telescope under a chart of stars", ("#14282b", "#8fc2b4", "#d6b66a")),
)}
DEFAULT_THEME = "launch"


def theme_id(value: object) -> str:
    return value if isinstance(value, str) and value in THEMES else DEFAULT_THEME

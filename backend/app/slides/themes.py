"""The two deck themes. Both are space themes in the app's own palette (black, #217cff, white): one on a night sky, one
on a pale daylight sky. Colours are plain hex so the HTML and the PowerPoint use exactly the same values."""

from dataclasses import dataclass

W, H = 1920, 1080  # every slide is drawn at this size


@dataclass(frozen=True)
class Palette:
    bg1: str  # sky at the edges
    bg2: str  # sky at its brightest point
    ink: str  # headings and body text
    mute: str  # secondary text
    accent: str  # kickers, numbers, markers
    accent2: str  # second accent (planets, rings)
    card: str  # card and panel fill
    cardline: str  # card and panel border
    line: str  # rules and dividers
    band: str  # the closing band
    bandink: str  # text on the band
    star: str  # star colour


@dataclass(frozen=True)
class Theme:
    id: str
    name: str
    dark: bool
    pal: Palette


THEMES: dict[str, Theme] = {t.id: t for t in (
    Theme("dark-space", "Night stellar", True, Palette(
        bg1="#000000", bg2="#0a1736", ink="#ffffff", mute="#b4bccc", accent="#4d94ff", accent2="#217cff",
        card="#0b1326", cardline="#1f3156", line="#26385c", band="#0e1c3d", bandink="#ffffff", star="#ffffff")),
    Theme("light-space", "Moon light", False, Palette(
        bg1="#c3cddf", bg2="#dfe5ef", ink="#0b1a3a", mute="#36435f", accent="#1858c4", accent2="#0b3d91",
        card="#e9eef6", cardline="#b3bfd5", line="#a7b4cc", band="#0b1a3a", bandink="#ffffff", star="#0b1a3a")),
)}
DEFAULT_THEME = "dark-space"

FONTS = {"display": "Space Grotesk", "body": "Inter", "mono": "JetBrains Mono"}


def theme_id(value: object) -> str:
    return value if isinstance(value, str) and value in THEMES else DEFAULT_THEME

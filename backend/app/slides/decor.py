"""The drawing behind a slide's text: stars, glows, planets, orbit rings and constellations. Each layout variant puts
its drawing where its text is not, and the deck's seed moves it a little, so two decks never look alike while one deck
always looks the same. The same list is drawn as SVG for the page and as a picture for the PowerPoint."""

import hashlib
import math
import random
from dataclasses import dataclass, field

from app.slides.themes import H, W


@dataclass
class Shape:
    kind: str  # glow | planet | ring | band | const | stars
    cx: float = 0
    cy: float = 0
    r: float = 0
    rx: float = 0
    ry: float = 0
    rot: float = 0
    color: str = "accent"  # palette key
    opacity: float = 1.0
    width: float = 2.0
    points: list[tuple[float, float, float, float]] = field(default_factory=list)  # stars: x, y, r, opacity
    edges: list[tuple[int, int]] = field(default_factory=list)
    # ring, band: only this part of the path, in degrees round it (0 to 180 is the half nearer the viewer, below the
    # centre before the tilt). None: all of it.
    arc: tuple[float, float] | None = None
    inner: float = 0  # band: the inner edge, as a share of rx and ry (the band fills from there out to the ring)


@dataclass
class Decor:
    hot: tuple[float, float]  # where the sky is brightest
    shapes: list[Shape]


# Where a variant has room for a drawing: (x0, y0, x1, y1). None: only stars and a soft glow.
FREE = {
    "dark-space": {
        ("points", "a"): (1520, 140, 1900, 940), ("points", "c"): None, ("points", "b"): None, ("points", "d"): None,
        ("agenda", "a"): (120, 660, 820, 1000), ("agenda", "b"): None,
        ("two_column", "a"): None, ("two_column", "b"): None,
        ("stat", "a"): None, ("stat", "b"): None, ("quote", "a"): None, ("quote", "b"): (140, 60, 760, 140),
        ("section", "b"): (1500, 60, 1900, 560), ("closing", "b"): None, ("closing", "c"): (140, 860, 960, 1060),
    },
    "light-space": {
        ("points", "a"): None, ("points", "b"): None, ("points", "c"): None, ("points", "d"): None,
        ("agenda", "a"): None, ("agenda", "b"): (120, 760, 820, 1000),
        ("two_column", "a"): None, ("two_column", "b"): None,
        ("stat", "a"): None, ("stat", "b"): None, ("quote", "a"): None, ("quote", "b"): (100, 360, 400, 760),
        ("closing", "a"): None, ("closing", "b"): None, ("closing", "c"): None,
    },
}


def _stars(rnd: random.Random, dark: bool) -> Shape:
    n = 120 if dark else 70
    pts = []
    for _ in range(n):
        if dark:
            r, op = rnd.choice((0.8, 1.0, 1.2, 1.2, 1.6, 2.2)), round(rnd.uniform(0.18, 0.85), 2)
        else:
            r, op = rnd.choice((0.9, 1.2, 1.5, 2.0)), round(rnd.uniform(0.08, 0.26), 2)
        pts.append((rnd.uniform(0, W), rnd.uniform(0, H), r, op))
    return Shape("stars", points=pts, color="star")


def _constellation(rnd: random.Random, box: tuple[float, float, float, float], n: int = 7) -> Shape:
    x0, y0, x1, y1 = box
    pts = [(rnd.uniform(x0, x1), rnd.uniform(y0, y1), rnd.choice((4.0, 5.0, 6.0, 8.0)), 1.0) for _ in range(n)]
    pts.sort(key=lambda p: p[0])
    edges = [(i, i + 1) for i in range(n - 1)]
    if n > 4:
        edges.append((rnd.randrange(0, n - 3), rnd.randrange(n - 2, n)))
    return Shape("const", points=pts, edges=edges, color="accent", opacity=0.85)


def on_ring(ring: Shape, degrees: float) -> tuple[float, float]:
    """The point at `degrees` round a ring's path, after its tilt: where a planet sits so it is on the drawn line.
    Same maths as the renderers (SVG rotate(rot cx cy), the PowerPoint's polyline)."""
    a, rot = math.radians(degrees), math.radians(ring.rot)
    x, y = ring.rx * math.cos(a), ring.ry * math.sin(a)
    return ring.cx + x * math.cos(rot) - y * math.sin(rot), ring.cy + x * math.sin(rot) + y * math.cos(rot)


def ring_path(s: Shape, scale: float = 1.0, steps: int = 180) -> list[tuple[float, float]]:
    """Points along a ring's (scaled) path, over its arc, for the renderers to draw."""
    a0, a1 = s.arc or (0, 360)
    scaled = Shape("ring", s.cx, s.cy, rx=s.rx * scale, ry=s.ry * scale, rot=s.rot)
    return [on_ring(scaled, a0 + (a1 - a0) * k / steps) for k in range(steps + 1)]


# A ringed planet's band, from the inside out: (inner, outer, opacity) as shares of the ring. A brighter inner ring
# and a fainter outer one with a dark gap between, as Saturn's are.
BANDS = ((0.72, 0.86, 0.34), (0.89, 1.0, 0.22))
NEAR, FAR = (0, 180), (180, 360)


def ringed_planet(cx: float, cy: float, r: float, rx: float, ry: float, rot: float, opacity: float = 1.0) -> list[Shape]:
    """A planet inside its rings: the far half of the rings goes behind the planet and the near half in front, so the
    rings wrap round it instead of lying flat over its face. The far half is a little dimmer, being further away."""
    def half(arc: tuple[float, float], op: float) -> list[Shape]:
        out = [Shape("band", cx, cy, rx=rx * hi, ry=ry * hi, rot=rot, color="accent", opacity=o * op, arc=arc, inner=lo / hi)
               for lo, hi, o in BANDS]
        out.append(Shape("ring", cx, cy, rx=rx, ry=ry, rot=rot, color="accent", opacity=0.8 * op, width=2, arc=arc))
        return out
    return [*half(FAR, 0.6 * opacity), Shape("planet", cx, cy, r), *half(NEAR, opacity)]


def build(theme: str, layout: str, variant: str, seed: int, index: int) -> Decor:
    """The drawing for one slide."""
    dark = theme == "dark-space"
    rnd = random.Random(int(hashlib.sha1(f"{seed}:{index}:{layout}:{variant}".encode()).hexdigest()[:12], 16))
    j = lambda span: rnd.uniform(-span, span)  # noqa: E731  (a small, seeded nudge)
    shapes = [_stars(rnd, dark)]
    hot = (W * rnd.uniform(0.25, 0.75), H * rnd.uniform(0.15, 0.5))
    key = (layout, variant)

    if dark:
        if key == ("title", "a"):
            hot = (960, 760)
            shapes += [Shape("glow", 960, 900, 900, color="accent2", opacity=0.55),
                       Shape("planet", 960 + j(60), 1080 + 560 + j(40), 820),
                       Shape("ring", 960, 860 + j(20), rx=1150, ry=150, rot=-4 + j(3), color="accent", opacity=0.45, width=2.5)]
        elif key == ("title", "b"):
            cx, cy = 1520 + j(60), 300 + j(50)
            hot = (cx, cy)
            shapes += [Shape("glow", cx, cy, 520, color="accent2", opacity=0.5),
                       *ringed_planet(cx, cy, 230 + j(25), rx=395, ry=82, rot=-18 + j(6))]
        elif key == ("title", "c"):
            hot = (1450, 540)
            shapes += [Shape("glow", 1450, 540, 620, color="accent2", opacity=0.35),
                       _constellation(rnd, (1120, 170, 1800, 910), 8)]
        elif layout == "section" and variant == "a":
            hot = (960, 540)
            shapes += [Shape("glow", 960, 540, 760, color="accent2", opacity=0.35),
                       Shape("ring", 960, 540 + j(20), rx=980, ry=260, rot=-8 + j(5), color="accent", opacity=0.3, width=2)]
        elif layout == "closing" and variant == "a":
            hot = (960, 980)
            shapes += [Shape("glow", 960, 1120, 760, color="accent2", opacity=0.5),
                       Shape("ring", 960, 1210, rx=1080, ry=880, rot=0, color="accent", opacity=0.35, width=2.5)]
        else:
            corner = rnd.choice(((0, 0), (W, 0), (0, H), (W, H)))
            shapes.append(Shape("glow", corner[0], corner[1], 700, color="accent2", opacity=0.32))
            hot = (corner[0] * 0.8 + W * 0.1, corner[1] * 0.8 + H * 0.1)
            free = FREE["dark-space"].get(key)
            if free:
                x0, y0, x1, y1 = free
                r = min(x1 - x0, y1 - y0) * rnd.uniform(0.26, 0.34)
                cx, cy = rnd.uniform(x0 + r, x1 - r), rnd.uniform(y0 + r, y1 - r)
                shapes += [Shape("glow", cx, cy, r * 2.2, color="accent2", opacity=0.35),
                           *ringed_planet(cx, cy, r, rx=r * 1.8, ry=r * 0.38, rot=-16 + j(10), opacity=0.9)]
    else:
        ring = lambda cx, cy, r, op=0.3: Shape("ring", cx, cy, rx=r, ry=r, color="accent2", opacity=op, width=2)  # noqa: E731
        if key == ("title", "a"):
            cx, cy = 2010 + j(40), 540 + j(60)
            hot = (1500, 540)
            orbit = ring(cx, cy, 540, 0.24)
            shapes += [ring(cx, cy, 360), orbit, ring(cx, cy, 740, 0.18), Shape("planet", *on_ring(orbit, 200 + j(20)), 34)]
        elif key == ("title", "b"):
            hot = (1500, 820)
            shapes += [Shape("glow", 1560, 840, 520, color="accent", opacity=0.12),
                       _constellation(rnd, (1360, 660, 1800, 980), 7)]
        elif key == ("title", "c"):
            hot = (960, 540)
            rot = -10 + j(4)  # one tilt for both, so the rings stay concentric
            orbit = Shape("ring", 960, 520, rx=900, ry=330, rot=rot, color="accent2", opacity=0.28, width=2.5)
            shapes += [orbit, Shape("ring", 960, 520, rx=1040, ry=400, rot=rot, color="accent2", opacity=0.14, width=2),
                       Shape("planet", *on_ring(orbit, rnd.choice((20, 160, 200, 340)) + j(10)), 30)]
        elif key in (("section", "a"), ("section", "b")):
            cx, toward = (1960, 180) if variant == "a" else (-40, 0)  # the planet sits on the side facing the text
            orbit = ring(cx, 560, 460, 0.22)
            shapes += [ring(cx, 560, 300), orbit, ring(cx, 560, 640, 0.15), Shape("planet", *on_ring(orbit, toward + j(10)), 26)]
        elif key == ("closing", "c"):
            hot = (960, 860)
            shapes += [Shape("ring", 960, 540, rx=1000, ry=470, rot=6 + j(4), color="accent2", opacity=0.2, width=2.5)]
        else:
            corner = rnd.choice(((W + 60, -60), (W + 60, H + 60), (-60, H + 60)))
            shapes += [ring(corner[0], corner[1], 260, 0.22), ring(corner[0], corner[1], 400, 0.15)]
            free = FREE["light-space"].get(key)
            if free:
                shapes.append(_constellation(rnd, free, 5))
    return Decor(hot, shapes)

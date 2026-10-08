"""Files made from a deck: a PDF (the deck's own HTML printed by a headless Chrome, so it matches the preview) and an
editable PowerPoint (the same placed elements as native text boxes and shapes over a drawn background). Also the
overflow check: Chrome lays the slides out and reports any text box whose text is taller than the box."""

import hashlib
import io
import json
import math
import re
import subprocess
import tempfile
from collections import OrderedDict
from pathlib import Path
from threading import Lock

from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

from app.infographics.image import ImageUnavailable, chrome
from app.slides.decor import Decor, Shape, build, ring_path
from app.slides.layout import El, compose
from app.slides.render import SHADE, color, deck_print_html, planet_colors, ring_shade, slides_html
from app.slides.themes import FONTS, THEMES, H, Palette, W, theme_id

TIMEOUT = 120
KEEP = 6
EMU_PX = 6350  # 1920 px = 13.333 in: one pixel is half a point

_cache: OrderedDict[str, bytes] = OrderedDict()
_lock = Lock()


def _cached(key: str, make) -> bytes:
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    data = make()
    with _lock:
        _cache[key] = data
        while len(_cache) > KEEP:
            _cache.popitem(last=False)
    return data


def _key(kind: str, deck: dict, theme: str, fmt: str, seed: int) -> str:
    blob = json.dumps([kind, deck, theme, fmt, seed], sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()


def _run_chrome(html: str, args: list[str], out_name: str | None) -> tuple[bytes, str]:
    binary = chrome()
    if not binary:
        raise ImageUnavailable("No Chrome is installed here to draw the slides.")
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "deck.html"
        src.write_text(html, encoding="utf-8")
        out = Path(tmp) / out_name if out_name else None
        cmd = [binary, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
               f"--user-data-dir={tmp}/profile", "--virtual-time-budget=10000", "--run-all-compositor-stages-before-draw",
               *[a.replace("{out}", str(out)) for a in args], f"file://{src}"]
        try:
            proc = subprocess.run(cmd, check=True, capture_output=True, timeout=TIMEOUT)
        except (subprocess.SubprocessError, OSError) as exc:
            raise ImageUnavailable("The slides could not be drawn.") from exc
        if out and not out.exists():
            raise ImageUnavailable("The slides could not be drawn.")
        return (out.read_bytes() if out else b""), proc.stdout.decode("utf-8", "replace")


# --- PDF ------------------------------------------------------------------------------------------------------------

def render_pdf(deck: dict, theme: str, fmt: str, seed: int) -> bytes:
    """The deck as a PDF, one slide per page at the slide's own size."""
    theme = theme_id(theme)

    def make() -> bytes:
        html = deck_print_html(deck, theme, fmt, seed)
        data, _ = _run_chrome(html, ["--print-to-pdf={out}", "--no-pdf-header-footer", "--print-to-pdf-no-header"],
                              "deck.pdf")
        return data

    return _cached(_key("pdf", deck, theme, fmt, seed), make)


PNG_BATCH = 8  # slides per Chrome run: one tall screenshot cut into slides (one launch per slide was the slow part)


def render_slide_pngs(deck: dict, theme: str, fmt: str, seed: int, limit: int) -> list[bytes]:
    """The first `limit` slides as PNG images at the slide's own size (1920 x 1080), as a post carries them. A batch
    of slides is drawn stacked on one page and the screenshot is cut at each slide."""
    theme = theme_id(theme)
    n = min(limit, len(deck["slides"]))
    out: list[bytes] = []
    for start in range(0, n, PNG_BATCH):
        count = min(PNG_BATCH, n - start)
        html = slides_html(deck, theme, fmt, seed, start, start + count)
        shot, _ = _run_chrome(html, [f"--window-size={W},{H * count}", "--screenshot={out}"], "slides.png")
        sheet = Image.open(io.BytesIO(shot)).convert("RGB")
        for i in range(count):
            buf = io.BytesIO()
            sheet.crop((0, i * H, W, (i + 1) * H)).save(buf, "PNG", optimize=True)
            out.append(buf.getvalue())
    return out


# --- overflow check -------------------------------------------------------------------------------------------------

_MEASURE = """<script>
document.fonts.ready.then(function () {
  var bad = [];
  document.querySelectorAll('.slide').forEach(function (s, i) {
    s.querySelectorAll('.t').forEach(function (t) {
      var inner = t.firstElementChild;  // the text's own height, not its glyphs' ink
      if (inner.offsetHeight > t.clientHeight + 2 || inner.scrollWidth > t.clientWidth + 2) { if (bad.indexOf(i) < 0) bad.push(i); }
    });
  });
  var out = document.createElement('pre'); out.id = 'overflow'; out.textContent = 'OVERFLOW:' + bad.join(',') + ':END';
  document.body.appendChild(out);
});
</script>"""


def overflowing(deck: dict, theme: str, fmt: str, seed: int) -> set[int]:
    """Indexes of slides where Chrome finds text taller or wider than its box. Raises ImageUnavailable without Chrome."""
    html = deck_print_html(deck, theme_id(theme), fmt, seed, script=_MEASURE)
    _, dom = _run_chrome(html, ["--dump-dom"], None)
    m = re.search(r"OVERFLOW:([0-9,]*):END", dom)
    if not m:
        raise ImageUnavailable("The slides could not be measured.")
    return {int(i) for i in m.group(1).split(",") if i}


# --- PowerPoint -----------------------------------------------------------------------------------------------------

def _rgb(hex_: str) -> RGBColor:
    return RGBColor.from_string(hex_.lstrip("#").upper())


def _hex_rgb(hex_: str) -> tuple[int, int, int]:
    h = hex_.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _gradient_disc(size: int, inner: tuple[int, int, int, int], outer: tuple[int, int, int, int]) -> Image.Image:
    """A size x size image fading from `inner` at the centre to `outer` at the edge (RGBA)."""
    mask = Image.radial_gradient("L").resize((size, size))  # 0 in the centre, 255 at the corners
    mask = mask.point(lambda v: min(255, int(v * 1.42)))  # 255 at the disc's edge
    a, b = Image.new("RGBA", (size, size), inner), Image.new("RGBA", (size, size), outer)
    return Image.composite(b, a, mask)


def background(decor: Decor, pal: Palette, dark: bool) -> bytes:
    """The slide's sky and drawing as a JPEG, for the PowerPoint's background."""
    hx, hy = decor.hot
    sky = Image.new("RGBA", (W, H), _hex_rgb(pal.bg1) + (255,))
    big = int(W * 1.7)
    disc = _gradient_disc(big, _hex_rgb(pal.bg2) + (255,), _hex_rgb(pal.bg1) + (255,))
    sky.paste(disc, (int(hx - big / 2), int(hy - big / 2)))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for s in decor.shapes:
        if s.kind in ("glow", "planet", "band"):  # pasted straight onto the sky: put down the lines drawn so far
            sky.alpha_composite(layer)  # first, so the order is the page's (a ring's far half behind its planet)
            layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            draw = ImageDraw.Draw(layer)
        _draw(sky, layer, draw, s, pal, dark)
    sky = Image.alpha_composite(sky, layer).convert("RGB")
    buf = io.BytesIO()
    sky.save(buf, "JPEG", quality=90)
    return buf.getvalue()


def _draw(sky: Image.Image, layer: Image.Image, draw: ImageDraw.ImageDraw, s: Shape, pal: Palette, dark: bool) -> None:
    c = _hex_rgb(color(pal, s.color))
    if s.kind == "stars":
        for x, y, r, o in s.points:
            draw.ellipse((x - r, y - r, x + r, y + r), fill=c + (int(255 * o),))
    elif s.kind == "glow":
        size = int(s.r * 2)
        if size < 4:
            return
        _paste_clipped(sky, _gradient_disc(size, c + (int(255 * s.opacity),), c + (0,)), s.cx - s.r, s.cy - s.r)
    elif s.kind == "planet":
        hi, lo, rim = planet_colors(pal, dark)
        size = int(s.r * 2)
        if size < 4:
            return
        disc = Image.new("RGBA", (size, size), _hex_rgb(lo) + (255,))
        shine = _gradient_disc(int(size * 1.6), _hex_rgb(hi) + (255,), _hex_rgb(lo) + (0,))
        _paste_clipped(disc, shine, -size * 0.45, -size * 0.52)  # lit from the upper left, as in the page's gradient
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
        disc.putalpha(mask)
        _paste_clipped(sky, disc, s.cx - s.r, s.cy - s.r)
        draw.ellipse((s.cx - s.r, s.cy - s.r, s.cx + s.r, s.cy + s.r), outline=_hex_rgb(rim) + (180,), width=3)
    elif s.kind == "band":
        sky.alpha_composite(_band(s, c))
    elif s.kind == "ring" and s.arc:
        draw.line(ring_path(s), fill=c + (int(255 * s.opacity),), width=max(1, round(s.width)), joint="curve")
    elif s.kind == "ring":
        steps = 360
        rot = math.radians(s.rot)
        pts = []
        for k in range(steps + 1):
            a = 2 * math.pi * k / steps
            x, y = s.rx * math.cos(a), s.ry * math.sin(a)
            pts.append((s.cx + x * math.cos(rot) - y * math.sin(rot), s.cy + x * math.sin(rot) + y * math.cos(rot)))
        draw.line(pts, fill=c + (int(255 * s.opacity),), width=max(1, round(s.width)))
    elif s.kind == "const":
        for a, b in s.edges:
            (x1, y1, *_), (x2, y2, *_) = s.points[a], s.points[b]
            draw.line((x1, y1, x2, y2), fill=c + (int(255 * s.opacity * 0.5),), width=2)
        for x, y, r, _ in s.points:
            draw.ellipse((x - r, y - r, x + r, y + r), fill=c + (int(255 * s.opacity),))


def _band(s: Shape, c: tuple[int, int, int]) -> Image.Image:
    """A ringed planet's band as a slide-sized layer: the shape filled, faded left to right as the page's SHADE."""
    shape = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shape).polygon(ring_path(s) + ring_path(s, s.inner)[::-1], fill=255)
    lo, hi = ring_shade(s)
    ramp = []
    for x in range(W):
        t = min(1.0, max(0.0, (x - lo) / (hi - lo))) if hi > lo else 0.0
        (o0, a0), (o1, a1) = next((SHADE[k], SHADE[k + 1]) for k in range(len(SHADE) - 1) if t <= SHADE[k + 1][0])
        ramp.append(int(255 * s.opacity * (a0 + (a1 - a0) * (t - o0) / (o1 - o0))))
    fade = Image.new("L", (W, 1))
    fade.putdata(ramp)
    alpha = Image.new("L", (W, H), 0)
    alpha.paste(fade.resize((W, H)), mask=shape)
    out = Image.new("RGBA", (W, H), c + (0,))
    out.putalpha(alpha)
    return out


def _paste_clipped(base: Image.Image, img: Image.Image, x: float, y: float) -> None:
    """alpha_composite `img` onto `base` at (x, y), clipping whatever falls outside."""
    x, y = int(x), int(y)
    left, top = max(0, -x), max(0, -y)
    right, bottom = min(img.width, base.width - x), min(img.height, base.height - y)
    if right <= left or bottom <= top:
        return
    base.alpha_composite(img.crop((left, top, right, bottom)), (x + left, y + top))


def _emu(px: float) -> Emu:
    return Emu(int(round(px * EMU_PX)))


def _no_style(shape) -> None:
    """Drop the theme's default shape style (shadows, outlines) so only what we set is drawn."""
    style = shape._element.find(qn("p:style"))
    if style is not None:
        shape._element.remove(style)


def _alpha(fill_fore_color_el, opacity: float) -> None:
    if opacity >= 1:
        return
    clr = fill_fore_color_el.find(qn("a:srgbClr"))
    if clr is not None:
        a = clr.makeelement(qn("a:alpha"), {"val": str(int(opacity * 100000))})
        clr.append(a)


def _add_el(slide, e: El, pal: Palette) -> None:
    if e.kind == "text":
        box = slide.shapes.add_textbox(_emu(e.x), _emu(e.y), _emu(e.w), _emu(e.h))
        tf = box.text_frame
        tf.word_wrap = True
        tf.auto_size = MSO_AUTO_SIZE.NONE
        tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
        tf.vertical_anchor = {"middle": MSO_ANCHOR.MIDDLE, "bottom": MSO_ANCHOR.BOTTOM}.get(e.valign, MSO_ANCHOR.TOP)
        for i, runs in enumerate(e.paras):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.alignment = {"center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}.get(e.align, PP_ALIGN.LEFT)
            p.line_spacing = e.lh * 0.96
            if i and e.gap:
                p.space_before = Pt(e.gap * 0.5)
            for r in runs:
                run = p.add_run()
                run.text = r.text
                f = run.font
                f.name = FONTS[e.font]
                f.size = Pt(e.size * 0.5)
                f.bold = r.bold or e.font == "display"
                f.color.rgb = _rgb(color(pal, r.color))
                rpr = run._r.get_or_add_rPr()
                if e.upper:
                    rpr.set("cap", "all")
                if e.track:
                    rpr.set("spc", str(int(e.track * e.size * 0.5 * 100)))
        return
    if e.kind == "line":
        horizontal = e.h == 0
        x2, y2 = (e.x + e.w, e.y) if horizontal else (e.x, e.y + e.h)
        ln = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, _emu(e.x), _emu(e.y), _emu(x2), _emu(y2))
        _no_style(ln)
        ln.line.color.rgb = _rgb(color(pal, e.stroke))
        ln.line.width = _emu(e.stroke_w)
        return
    kind = MSO_SHAPE.OVAL if e.kind == "circle" else (MSO_SHAPE.ROUNDED_RECTANGLE if e.radius else MSO_SHAPE.RECTANGLE)
    sh = slide.shapes.add_shape(kind, _emu(e.x), _emu(e.y), _emu(e.w), _emu(e.h))
    _no_style(sh)
    if kind == MSO_SHAPE.ROUNDED_RECTANGLE:
        sh.adjustments[0] = min(0.5, e.radius / max(min(e.w, e.h), 1))
    if e.fill:
        sh.fill.solid()
        sh.fill.fore_color.rgb = _rgb(color(pal, e.fill))
        _alpha(sh.fill._xPr.find(qn("a:solidFill")), e.opacity)
    else:
        sh.fill.background()
    if e.stroke and e.stroke_w:
        sh.line.color.rgb = _rgb(color(pal, e.stroke))
        sh.line.width = _emu(e.stroke_w)
    else:
        sh.line.fill.background()


def _notes(slide_data: dict) -> str:
    notes = slide_data.get("notes") or ""
    srcs = [f"{s.get('title') or s['path']} (lines {s['line_start']}-{s['line_end']})" for s in slide_data.get("sources") or []]
    return notes + (("\n\nSources: " + "; ".join(dict.fromkeys(srcs))) if srcs else "")


def build_pptx(deck: dict, theme: str, fmt: str, seed: int) -> bytes:
    """The deck as an editable PowerPoint: text boxes you can type in, over each slide's drawn background."""
    theme = theme_id(theme)

    def make() -> bytes:
        t = THEMES[theme]
        prs = Presentation()
        prs.slide_width, prs.slide_height = _emu(W), _emu(H)
        blank = prs.slide_layouts[6]
        for i in range(len(deck["slides"])):
            c = compose(deck, i, theme, fmt, seed)
            slide = prs.slides.add_slide(blank)
            d = build(theme, c.slide["layout"], c.slide["variant"], seed, i)
            slide.shapes.add_picture(io.BytesIO(background(d, t.pal, t.dark)), 0, 0, _emu(W), _emu(H))
            for e in c.elements:
                _add_el(slide, e, t.pal)
            note = _notes(c.slide)
            if note:
                slide.notes_slide.notes_text_frame.text = note
        prs.core_properties.title = deck.get("title") or "Slide deck"
        buf = io.BytesIO()
        prs.save(buf)
        return buf.getvalue()

    return _cached(_key("pptx", deck, theme, fmt, seed), make)

"""A deck as HTML: one standalone page per slide (shown in the app in a sandboxed frame, scaled to fit) and one page
with every slide (printed to PDF). Every word from the model is escaped; the markup is all ours."""

from markupsafe import escape

from app.slides.decor import Decor, Shape, build
from app.slides.layout import Composed, El, compose
from app.slides.themes import FONTS, THEMES, H, Palette, W, theme_id

FONT_LINK = ("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;700"
             "&family=JetBrains+Mono:wght@400;700&display=swap")

_FAMILY = {"display": f"'{FONTS['display']}','{FONTS['body']}',sans-serif", "body": f"'{FONTS['body']}',sans-serif",
           "mono": f"'{FONTS['mono']}',monospace"}


def color(pal: Palette, key: str | None) -> str:
    if not key:
        return "transparent"
    return "#ffffff" if key == "white" else getattr(pal, key)


CSS = f"""
html,body{{margin:0;padding:0}}
.slide{{position:relative;width:{W}px;height:{H}px;overflow:hidden;font-family:{_FAMILY['body']};
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}}
.slide svg.bg{{position:absolute;inset:0}}
.e{{position:absolute;box-sizing:border-box;margin:0}}
.t{{display:flex;flex-direction:column;overflow:visible;overflow-wrap:anywhere}}
.t>.in{{display:block}}
.t.v-middle{{justify-content:center}}.t.v-bottom{{justify-content:flex-end}}
.t p{{margin:0}}
.t b{{font-weight:700}}
.r-heading,.r-quote,.r-closing,.r-term{{text-wrap:balance}}
.dark .r-heading.l-title,.dark .r-value{{text-shadow:0 0 48px rgba(33,124,255,.45)}}
.dark .r-marker{{box-shadow:0 0 36px rgba(33,124,255,.75)}}
.dark .r-bar{{box-shadow:0 0 18px rgba(77,148,255,.8)}}
.light .r-card,.light .r-panel{{box-shadow:0 18px 44px rgba(11,26,58,.08)}}
.light .r-band{{box-shadow:0 18px 44px rgba(11,26,58,.18)}}
"""


def _style(**kw) -> str:
    return ";".join(f"{k.replace('_', '-')}:{v}" for k, v in kw.items() if v is not None)


def _el(e: El, pal: Palette, layout: str) -> str:
    box = dict(left=f"{e.x:.1f}px", top=f"{e.y:.1f}px", width=f"{e.w:.1f}px", height=f"{e.h:.1f}px")
    if e.kind == "text":
        paras = []
        for i, p in enumerate(e.paras):
            runs = "".join(
                f'<span style="color:{color(pal, r.color)}{";font-weight:700" if r.bold else ""}">{escape(r.text)}</span>'
                for r in p)
            gap = f' style="margin-top:{e.gap:.1f}px"' if i and e.gap else ""
            paras.append(f"<p{gap}>{runs}</p>")
        css = _style(**box, font_size=f"{e.size}px", line_height=str(e.lh), font_family=_FAMILY[e.font],
                     text_align=e.align, letter_spacing=f"{e.track}em" if e.track else None,
                     text_transform="uppercase" if e.upper else None,
                     font_weight="700" if e.font == "display" else None)
        return f'<div class="e t r-{e.role} l-{layout} v-{e.valign}" style="{css}"><div class="in">{"".join(paras)}</div></div>'
    if e.kind == "line":
        horizontal = e.h == 0
        css = _style(left=f"{e.x:.1f}px", top=f"{e.y - (e.stroke_w / 2 if horizontal else 0):.1f}px",
                     width=f"{e.w if horizontal else e.stroke_w:.1f}px", height=f"{e.stroke_w if horizontal else e.h:.1f}px",
                     background=color(pal, e.stroke), border_radius="2px")
        return f'<div class="e r-{e.role}" style="{css}"></div>'
    radius = "50%" if e.kind == "circle" else f"{e.radius}px"
    border = f"{e.stroke_w}px solid {color(pal, e.stroke)}" if e.stroke and e.stroke_w else None
    css = _style(**box, background=color(pal, e.fill), border=border, border_radius=radius,
                 opacity=str(e.opacity) if e.opacity < 1 else None)
    return f'<div class="e r-{e.role}" style="{css}"></div>'


def _svg(d: Decor, pal: Palette, dark: bool, uid: str) -> str:
    defs, out = [], []
    for n, s in enumerate(d.shapes):
        out.append(_shape(s, pal, dark, f"{uid}{n}", defs))
    hx, hy = d.hot
    sky = (f'<radialGradient id="{uid}sky" gradientUnits="userSpaceOnUse" cx="{hx:.0f}" cy="{hy:.0f}" r="{W * 0.85:.0f}">'
           f'<stop offset="0" stop-color="{pal.bg2}"/><stop offset="1" stop-color="{pal.bg1}"/></radialGradient>')
    return (f'<svg class="bg" width="{W}" height="{H}" viewBox="0 0 {W} {H}"><defs>{sky}{"".join(defs)}</defs>'
            f'<rect width="{W}" height="{H}" fill="url(#{uid}sky)"/>{"".join(out)}</svg>')


def _shape(s: Shape, pal: Palette, dark: bool, gid: str, defs: list[str]) -> str:
    c = color(pal, s.color)
    if s.kind == "stars":
        return "".join(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="{c}" opacity="{o}"/>' for x, y, r, o in s.points)
    if s.kind == "glow":
        defs.append(f'<radialGradient id="{gid}"><stop offset="0" stop-color="{c}" stop-opacity="{s.opacity}"/>'
                    f'<stop offset="1" stop-color="{c}" stop-opacity="0"/></radialGradient>')
        return f'<circle cx="{s.cx:.0f}" cy="{s.cy:.0f}" r="{s.r:.0f}" fill="url(#{gid})"/>'
    if s.kind == "planet":
        hi, lo, rim = planet_colors(pal, dark)
        defs.append(f'<radialGradient id="{gid}" cx="35%" cy="28%" r="80%"><stop offset="0" stop-color="{hi}"/>'
                    f'<stop offset="1" stop-color="{lo}"/></radialGradient>')
        return (f'<circle cx="{s.cx:.0f}" cy="{s.cy:.0f}" r="{s.r:.0f}" fill="url(#{gid})"/>'
                f'<circle cx="{s.cx:.0f}" cy="{s.cy:.0f}" r="{s.r:.0f}" fill="none" stroke="{rim}" stroke-width="3" opacity=".7"/>')
    if s.kind == "ring":
        return (f'<ellipse cx="{s.cx:.0f}" cy="{s.cy:.0f}" rx="{s.rx:.0f}" ry="{s.ry:.0f}" fill="none" stroke="{c}" '
                f'stroke-width="{s.width}" opacity="{s.opacity}" transform="rotate({s.rot:.1f} {s.cx:.0f} {s.cy:.0f})"/>')
    if s.kind == "const":
        lines = "".join(f'<line x1="{s.points[a][0]:.0f}" y1="{s.points[a][1]:.0f}" x2="{s.points[b][0]:.0f}" '
                        f'y2="{s.points[b][1]:.0f}" stroke="{c}" stroke-width="1.6" opacity="{s.opacity * 0.5:.2f}"/>'
                        for a, b in s.edges)
        dots = "".join(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="{c}" opacity="{s.opacity}"/>' for x, y, r, _ in s.points)
        return lines + dots
    return ""


def planet_colors(pal: Palette, dark: bool) -> tuple[str, str, str]:
    """Lit side, dark side and rim of a planet."""
    return ("#1d4fb3", "#020713", pal.accent) if dark else ("#5d9bff", pal.accent2, pal.accent)


def slide_body(c: Composed, deck: dict, index: int, theme: str) -> str:
    t = THEMES[theme]
    s = c.slide
    d = build(theme, s["layout"], s["variant"], c.seed, index)
    els = "".join(_el(e, t.pal, s["layout"]) for e in c.elements)
    cls = f"slide {'dark' if t.dark else 'light'} l-{s['layout']} v-{s['variant']}"
    return f'<div class="{cls}" style="background:{t.pal.bg1}">{_svg(d, t.pal, t.dark, f"s{index}g")}{els}</div>'


def _page(body: str, extra_css: str = "") -> str:
    return (f'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="{FONT_LINK}">'
            f"<style>{CSS}{extra_css}</style></head><body>{body}</body></html>")


def slide_html(deck: dict, index: int, theme: str, fmt: str, seed: int) -> str:
    """One slide as a standalone page."""
    theme = theme_id(theme)
    return _page(slide_body(compose(deck, index, theme, fmt, seed), deck, index, theme),
                 f"body{{background:{THEMES[theme].pal.bg1}}}")


def deck_print_html(deck: dict, theme: str, fmt: str, seed: int, script: str = "") -> str:
    """Every slide on one page, one per printed page."""
    theme = theme_id(theme)
    body = "".join(slide_body(compose(deck, i, theme, fmt, seed), deck, i, theme) for i in range(len(deck["slides"])))
    css = (f"@page{{size:{W}px {H}px;margin:0}}body{{background:{THEMES[theme].pal.bg1}}}"
           ".slide{break-after:page;page-break-after:always}.slide:last-child{break-after:auto;page-break-after:auto}"
           "*{-webkit-print-color-adjust:exact;print-color-adjust:exact}")
    return _page(body + script, css)

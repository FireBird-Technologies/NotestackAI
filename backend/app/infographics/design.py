"""The AI-composed infographic: a page frame of ours (head, takeaway, background, mark) around a body the model writes in
HTML from a small vocabulary of components (flow charts, timelines, hierarchies, comparisons, cards, numbers). The
model's markup is never trusted: it is parsed and rebuilt from an allowlist of tags and class names, with no
attributes but `class`, so it can carry no script, style, link, image or address."""

import hashlib
import random
import re
from dataclasses import dataclass
from pathlib import Path

from bs4 import BeautifulSoup, Comment, NavigableString, Tag
from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape
from markupsafe import Markup

from app.infographics.render import LOGO_SVG, SIZES

_DIR = Path(__file__).parent / "templates"
CSS = (_DIR / "design.css").read_text(encoding="utf-8")


@dataclass(frozen=True)
class Look:
    id: str
    name: str
    blurb: str
    vars: dict  # CSS variables of the palette


LOOKS: dict[str, Look] = {l.id: l for l in (
    Look("midnight", "Midnight", "Black and blue, white type", {
        "bg": "#03050a", "bg2": "#0b1a3a", "ink": "#ffffff", "mute": "#9fb0cc", "acc": "#2f7bff", "acc2": "#8db8ff",
        "line": "rgba(130,170,255,.26)", "card": "rgba(255,255,255,.04)", "hl": "rgba(47,123,255,.18)", "paper": "#ffffff",
        "paperink": "#03050a", "star": "#ffffff", "markbg": "rgba(3,5,10,.75)", "markline": "rgba(141,184,255,.4)", "markink": "#ffffff"}),
    Look("paper", "Orbit", "White, black type, blue orbits and stars", {
        "bg": "#ffffff", "bg2": "#eaf1ff", "ink": "#05070d", "mute": "#4b5668", "acc": "#1f5fe6", "acc2": "#1f5fe6",
        "line": "rgba(5,7,13,.18)", "card": "#ffffff", "hl": "rgba(31,95,230,.09)", "paper": "#05070d",
        "paperink": "#ffffff", "star": "#1f5fe6", "markbg": "#05070d", "markline": "#05070d", "markink": "#ffffff"}),
)}
DEFAULT_LOOK = "midnight"

# What the person can ask the layout to lean towards; "auto" lets the AI choose from the content.
STYLES = {
    "auto": "Choose the layout that suits the content",
    "flowchart": "A flow chart: boxes joined by arrows, steps in order",
    "timeline": "A timeline: what happened or happens, in order",
    "compare": "A comparison: two sides set against each other",
    "hierarchy": "A hierarchy: one idea and the parts it breaks into",
    "overview": "An overview: cards of the key ideas and the numbers that matter",
}

# Every class the model's markup may use (the components in design.css); anything else is dropped.
ALLOWED_CLASSES = {
    "sec", "sec-t", "lead", "mono", "small", "hl", "node", "n-no", "n-t", "n-d", "flow", "col", "grid", "c2", "c3", "c4",
    "card", "c-k", "c-t", "c-d", "timeline", "t-item", "t-when", "t-t", "t-d", "tree", "t-root", "t-kids", "compare",
    "side", "s-h", "stats", "stat", "s-n", "s-l", "cols", "pills", "pill", "callout",
}
ALLOWED_TAGS = {"div", "section", "span", "p", "ul", "ol", "li", "strong", "b", "em", "i", "small", "br", "h3", "h4"}
DROP_WITH_CONTENT = {"script", "style", "iframe", "object", "embed", "link", "meta", "svg", "img", "video", "audio", "form",
                     "input", "button", "textarea", "select", "canvas", "math", "head", "title", "noscript", "template"}
MAX_BODY_CHARS = 14_000
MAX_ELEMENTS = 320

_SPACE = re.compile(r"\s+")


def _clean_text(text: str) -> str:
    return text.replace("—", ",").replace("–", "-")


def sanitize_body(raw: object) -> str | None:
    """The model's body markup rebuilt from the allowlist, or None when nothing readable is left."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    soup = BeautifulSoup(raw[: MAX_BODY_CHARS * 2], "html.parser")
    for c in soup.find_all(string=lambda t: isinstance(t, Comment)):
        c.extract()
    for tag in soup.find_all(DROP_WITH_CONTENT):
        tag.decompose()
    count = 0
    for tag in list(soup.find_all(True)):
        count += 1
        if tag.name not in ALLOWED_TAGS or count > MAX_ELEMENTS:
            tag.unwrap() if count <= MAX_ELEMENTS else tag.decompose()
            continue
        classes = [c for c in (tag.get("class") or []) if c in ALLOWED_CLASSES]
        tag.attrs = {"class": classes} if classes else {}
    for node in soup.find_all(string=True):
        if isinstance(node, NavigableString):
            node.replace_with(NavigableString(_clean_text(str(node))))
    html = _SPACE.sub(" ", str(soup)).strip()
    text = soup.get_text(strip=True)
    if len(html) > MAX_BODY_CHARS or len(text) < 40:
        return None
    return html


def _clip(text: object, limit: int) -> str:
    s = _SPACE.sub(" ", re.sub(r"<[^>]*>", " ", str(text or ""))).strip()
    s = _clean_text(s)
    if len(s) <= limit:
        return s
    cut = s[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:.-") or s[: limit - 1]
    return cut + "…"


def build_content(raw: dict) -> dict | None:
    """The stored content for a model answer (title, subtitle, eyebrow, key_figures, body_html, rule, notes), or None when it is
    too thin to draw."""
    if hasattr(raw, "model_dump"):
        raw = raw.model_dump()
    title = _clip(raw.get("title"), 70)
    body = sanitize_body(raw.get("body_html"))
    if not title or not body:
        return None
    figures = []
    for f in raw.get("key_figures") or []:
        f = f if isinstance(f, dict) else getattr(f, "__dict__", {})
        value, label = _clip(f.get("value"), 14), _clip(f.get("label"), 44)
        if value and label:
            figures.append({"value": value, "label": label})
    notes = [n for n in (_clip(n, 100) for n in raw.get("notes") or []) if n][:3]
    return {"title": title, "subtitle": _clip(raw.get("subtitle"), 130), "eyebrow": _clip(raw.get("eyebrow"), 30) or "Key ideas",
            "key_figures": figures[:3], "body_html": body, "rule": _clip(raw.get("rule"), 90), "notes": notes}


def _stars(seed: str, w: int, h: int, n: int = 90) -> str:
    rnd = random.Random(int(hashlib.sha1(seed.encode()).hexdigest()[:8], 16))
    out = []
    for _ in range(n):
        r = rnd.choice((1.2, 1.5, 1.5, 2, 2.6))
        out.append(f'<circle cx="{rnd.randint(0, w)}" cy="{rnd.randint(0, h)}" r="{r}" fill="var(--star)" opacity="{round(rnd.uniform(.12, .5), 2)}"/>')
    return "".join(out)


def _orbits(w: int, h: int) -> str:
    """The Orbit look's scenery: a ringed planet like the app's icon, orbit rings with small moons, and shooting stars."""
    big = round(w * 0.2)
    cx, cy = round(w * 0.86), round(h * 0.085)
    pr = round(w * 0.05)

    def ring(x, y, rx, ry, op, dash=""):
        return (f'<ellipse cx="{x}" cy="{y}" rx="{rx}" ry="{ry}" transform="rotate(-20 {x} {y})" fill="none" stroke="var(--acc)" '
                f'stroke-width="2" opacity="{op}"{dash}/>')

    def planet_ring(front: bool):
        sweep = 0 if front else 1
        return (f'<g transform="rotate(-22 {cx} {cy})"><path d="M{cx - pr * 2} {cy} A{pr * 2} {round(pr * .6)} 0 0 {sweep} {cx + pr * 2} {cy}" '
                f'fill="none" stroke="var(--acc)" stroke-width="5" opacity="{1 if front else .5}"/></g>')

    out = [
        '<defs><linearGradient id="shoot" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--acc)" stop-opacity="0"/>'
        '<stop offset="1" stop-color="var(--acc)" stop-opacity=".85"/></linearGradient></defs>',
        ring(cx, cy, big, round(big * .3), .35, ' stroke-dasharray="3 12"'),
        ring(cx, cy, round(big * 1.55), round(big * .46), .22),
        ring(round(w * .06), round(h * .96), round(w * .5), round(w * .14), .2, ' stroke-dasharray="3 12"'),
        ring(round(w * .06), round(h * .96), round(w * .34), round(w * .09), .28),
        planet_ring(False),
        f'<circle cx="{cx}" cy="{cy}" r="{pr}" fill="var(--bg)" stroke="var(--acc)" stroke-width="5"/>',
        f'<circle cx="{cx}" cy="{cy}" r="{pr - 12}" fill="var(--acc)" opacity=".12"/>',
        planet_ring(True),
        f'<circle cx="{round(w * .6)}" cy="{round(h * .036)}" r="9" fill="var(--acc)" opacity=".7"/>',
        f'<circle cx="{round(w * .31)}" cy="{round(h * .93)}" r="8" fill="var(--acc)" opacity=".6"/>',
    ]
    for fx, fy, length, op in ((.46, .2, 190, .8), (.7, .4, 150, .6), (.12, .55, 120, .5)):
        x, y = round(w * fx), round(h * fy)
        out.append(f'<g transform="rotate(28 {x} {y})" opacity="{op}"><rect x="{x - length}" y="{y - 2}" width="{length}" height="4" rx="2" fill="url(#shoot)"/>'
                   f'<circle cx="{x}" cy="{y}" r="5" fill="var(--acc)"/></g>')
    return "".join(out)


_ENV = Environment(loader=FileSystemLoader(_DIR), autoescape=select_autoescape(["j2", "html"], default=True), undefined=StrictUndefined,
                   trim_blocks=True, lstrip_blocks=True)


def render_design(look: str, content: dict, layout: str = "portrait", fit: float | None = None) -> str:
    """The page for an AI-composed infographic. `fit` is the scale that makes its body fit (stored with the content)."""
    look = look if look in LOOKS else DEFAULT_LOOK
    layout = layout if layout in SIZES else "portrait"
    w, h = SIZES[layout]
    if fit is None:
        fit = float(((content.get("fit") or {}) if isinstance(content.get("fit"), dict) else {}).get(layout) or 1)
    fit = max(0.5, min(1.0, fit))
    vars_css = ";".join(f"--{k}:{v}" for k, v in LOOKS[look].vars.items())
    return _ENV.get_template("design.html.j2").render(
        c=content, look=look, layout=layout, w=w, h=h, fit=fit, vars_css=vars_css, css=Markup(CSS), logo=Markup(LOGO_SVG),
        body=Markup(content["body_html"]),
        stars=Markup(_stars(content["title"] + look, w, h) + (_orbits(w, h) if look == "paper" else "")),
        fonts="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap")


SAMPLE_BODY = (
    '<section class="sec"><div class="sec-t">The five layers</div><div class="flow">'
    '<div class="node"><span class="n-no">01</span><span class="n-t">Prompt</span><span class="n-d">Wording, examples and format of one request.</span></div>'
    '<div class="node"><span class="n-no">02</span><span class="n-t">Context</span><span class="n-d">Docs, history, tools and memory for each call.</span></div>'
    '<div class="node hl"><span class="n-no">03</span><span class="n-t">Harness</span><span class="n-d">Tools, checks and guardrails around the model.</span></div>'
    '<div class="node"><span class="n-no">04</span><span class="n-t">Loop</span><span class="n-d">Reason, act and observe until done.</span></div></div></section>'
    '<section class="sec"><div class="sec-t">Every request goes through</div><div class="grid c4">'
    + "".join(f'<div class="card{" hl" if i == 3 else ""}"><span class="c-k">Step {i + 1}</span><span class="c-t">{t}</span><span class="c-d">{d}</span></div>'
              for i, (t, d) in enumerate([("Auth", "Identity, limits and input guards."), ("Cache", "Answers to repeat questions."),
                                          ("Safety", "Scrub PII, catch injection."), ("Memory", "Session history, summarised."),
                                          ("Retrieve", "Fetch docs, split queries."), ("Answer", "Sub-queries in parallel."),
                                          ("Validate", "Check quality first."), ("Save", "Store and log one trace.")]))
    + '</div></section>'
    '<section class="sec"><div class="sec-t">Why it matters</div><div class="callout">Each layer builds on the one below it, so start at the bottom and add a layer only when the task needs it.</div></section>'
)
SAMPLE = {"title": "From Prompt to Production Agent", "subtitle": "Five engineering layers and the steps every request takes",
          "eyebrow": "Agent engineering", "body_html": SAMPLE_BODY,
          "key_figures": [{"value": "5", "label": "engineering layers"}, {"value": "8", "label": "steps on every request"},
                          {"value": "30%", "label": "of traffic skips the pipeline"}],
          "rule": "Most tasks only need the bottom layers; avoid complex graphs without cause.",
          "notes": ["Each layer builds on the one below it.", "Cache and middleware run outside the graph.",
                    "Every request produces one end-to-end trace."]}

"""A Mind Constellation as a document: its points with their details, printed to a PDF the way a report is
(app.services.report_export). The centre idea is the title, each theme a section, each sub-theme a heading in it, and
the points under a sub-theme a list; every star's note follows it, and the posts it came from are named."""

import html

from app.models import Artifact
from app.services.report_export import PAGE_CSS, _logo

MAP_CSS = """
.lead { margin: -10pt 0 18pt; color: #555b66; }
.note { margin: 2pt 0 8pt; }
.from { margin: 0 0 10pt; color: #8a8f99; font-size: 9pt; }
h2 { padding-top: 6pt; border-top: 0.5pt solid #e1e4ea; }
h2:first-of-type { border-top: 0; padding-top: 0; }
li { margin: 0 0 6pt; }
li .note, li .from { margin: 1pt 0 0; }
"""


def _esc(text) -> str:
    return html.escape(str(text or "").strip())


def _details(node: dict) -> str:
    """A star's note and the posts it came from, under its label."""
    out = f'<p class="note">{_esc(node.get("note"))}</p>' if str(node.get("note") or "").strip() else ""
    titles = list(dict.fromkeys(str(s.get("title") or "").strip() for s in node.get("sources") or []
                                if isinstance(s, dict) and str(s.get("title") or "").strip()))
    if titles:
        out += f'<p class="from">From: {"; ".join(_esc(t) for t in titles)}</p>'
    return out


def _kids(node: dict) -> list[dict]:
    return [c for c in node.get("children") or [] if isinstance(c, dict)]


def mind_map_pdf_html(a: Artifact) -> str:
    c = a.content_json or {}
    root = c.get("root") if isinstance(c.get("root"), dict) else {}
    title = _esc(c.get("title")) or "Mind Constellation"
    title = title.removeprefix("Mind Constellation: ") or title
    stars = c.get("node_count")
    lead = f'<p class="lead">Mind Constellation{f" · {stars} stars" if stars else ""}</p>'
    body = [f"<h1>{_esc(root.get('label')) or title}</h1>", lead, _details(root)]
    for theme in _kids(root):
        body += [f"<h2>{_esc(theme.get('label'))}</h2>", _details(theme)]
        for topic in _kids(theme):
            body += [f"<h3>{_esc(topic.get('label'))}</h3>", _details(topic)]
            points = _kids(topic)
            if points:
                body.append("<ul>" + "".join(f"<li><strong>{_esc(p.get('label'))}</strong>{_details(p)}</li>"
                                             for p in points) + "</ul>")
    head = '<div class="brand">Notestack AI</div>'
    foot = f'<div class="made">Made with Notestack AI<img src="{_logo()}" alt=""></div>'
    return (f'<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>'
            f"<style>{PAGE_CSS}{MAP_CSS}</style></head>"
            f'<body><table class="frame"><thead><tr><td>{head}</td></tr></thead>'
            f"<tfoot><tr><td>{foot}</td></tr></tfoot>"
            f'<tbody><tr><td>{"".join(body)}</td></tr></tbody></table></body></html>')


def mind_map_pdf(a: Artifact) -> bytes:
    """The map's points and details printed to an A4 PDF with headless Chrome (ImageUnavailable when there is none)."""
    from app.slides.export import _run_chrome  # Chrome's print-to-PDF, as the report and slide deck PDFs use it

    data, _ = _run_chrome(mind_map_pdf_html(a), ["--print-to-pdf={out}", "--no-pdf-header-footer",
                                                 "--print-to-pdf-no-header"], "mind-map.pdf")
    return data

"""A report as something to post: its text, when it fits in one post, or a PDF of it, when it doesn't.

The text follows the report's own blocks (the same order the Download Markdown file has, components/ReportView.tsx),
without citation markers or the list of sources: a post carries the report, not the notebook's posts it came from."""

import html
import re

from app.models import Artifact
from app.services.artifacts import report_blocks

REPORT_POST_LIMIT = 2800  # LinkedIn takes 3000 characters in a post; the rest is room for the writer's own words
MARKER = re.compile(r"\s*\[\d+\](?:\[\d+\])*")
BOLD = re.compile(r"\*\*(.+?)\*\*")


def _clean(text) -> str:
    return MARKER.sub("", str(text or "")).strip()


def report_text(a: Artifact) -> str:
    """The report as plain text: headings as their own lines, lists as "- " lines, no Markdown emphasis."""
    c = a.content_json or {}
    out = [_clean(c.get("title")) or "Report", ""]
    for b in report_blocks(a):
        kind, title = b.get("type"), _clean(b.get("title"))
        if kind == "prose":
            out += [re.sub(r"^#+\s*", "", BOLD.sub(r"\1", _clean(b.get("text"))), flags=re.M), ""]
        elif kind == "callout":
            out += [f"{title}: {_clean(b.get('text'))}" if title else _clean(b.get("text")), ""]
        elif kind == "key_terms":
            out += [title or "Key terms", *[f"- {_clean(t.get('term'))}: {_clean(t.get('definition'))}"
                                            for t in b.get("terms") or []], ""]
        elif kind == "timeline":
            out += [title or "Timeline", *[f"- {_clean(e.get('when'))} {_clean(e.get('title'))}"
                                           + (f": {_clean(e.get('detail'))}" if e.get("detail") else "")
                                           for e in b.get("events") or []], ""]
        elif kind == "table":
            out += [*([title] if title else []), " | ".join(_clean(h) for h in b.get("headers") or []),
                    *[" | ".join(_clean(x) for x in r) for r in b.get("rows") or []], ""]
        elif kind == "flashcards":
            out += [title or "Flashcards", *[f"- {_clean(x.get('front'))}: {_clean(x.get('back'))}"
                                             for x in b.get("cards") or []], ""]
        elif kind == "quiz":
            out += [title or "Quiz", *[f"{i + 1}. {_clean(q.get('question'))}"
                                       for i, q in enumerate(b.get("questions") or [])], ""]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def fits_in_post(a: Artifact) -> bool:
    return len(report_text(a)) <= REPORT_POST_LIMIT


def report_caption(a: Artifact) -> str:
    """A long report's starting caption (the PDF carries the rest): its title and its opening paragraph."""
    text = report_text(a)
    title, _, rest = text.partition("\n\n")
    first = rest.split("\n\n", 1)[0] if rest else ""
    return f"{title}\n\n{first}".strip() if len(first) <= 600 else title


# --- PDF ------------------------------------------------------------------------------------------------------------

def _inline(text: str) -> str:
    return BOLD.sub(r"<strong>\1</strong>", html.escape(_clean(text)))


def _prose(text: str) -> str:
    """The little Markdown a report's prose uses: headings, "- " lists, **bold** and paragraphs."""
    parts, items = [], []

    def close():
        if items:
            parts.append("<ul>" + "".join(f"<li>{i}</li>" for i in items) + "</ul>")
            items.clear()

    for para in re.split(r"\n\s*\n", _clean(text)):
        for line in para.split("\n"):
            s = line.strip()
            if not s:
                continue
            if m := re.match(r"^(#{1,4})\s+(.*)", s):
                close()
                level = min(len(m.group(1)) + 1, 4)
                parts.append(f"<h{level}>{_inline(m.group(2))}</h{level}>")
            elif m := re.match(r"^[-*]\s+(.*)", s):
                items.append(_inline(m.group(1)))
            else:
                close()
                parts.append(f"<p>{_inline(s)}</p>")
        close()
    return "".join(parts)


def _block_html(b: dict) -> str:
    kind, title = b.get("type"), html.escape(_clean(b.get("title")))
    head = f"<h2>{title}</h2>" if title else ""
    if kind == "prose":
        return _prose(b.get("text"))
    if kind == "callout":
        return f'<aside>{f"<strong>{title}</strong> " if title else ""}{_inline(b.get("text"))}</aside>'
    if kind == "key_terms":
        return (head or "<h2>Key terms</h2>") + "<dl>" + "".join(
            f"<dt>{_inline(t.get('term'))}</dt><dd>{_inline(t.get('definition'))}</dd>" for t in b.get("terms") or []) + "</dl>"
    if kind == "timeline":
        return (head or "<h2>Timeline</h2>") + "<ul>" + "".join(
            f"<li><strong>{_inline(e.get('when'))}</strong> {_inline(e.get('title'))}"
            + (f": {_inline(e.get('detail'))}" if e.get("detail") else "") + "</li>" for e in b.get("events") or []) + "</ul>"
    if kind == "table":
        cells = "".join(f"<th>{_inline(h)}</th>" for h in b.get("headers") or [])
        rows = "".join("<tr>" + "".join(f"<td>{_inline(x)}</td>" for x in r) + "</tr>" for r in b.get("rows") or [])
        return f"{head}<table><thead><tr>{cells}</tr></thead><tbody>{rows}</tbody></table>"
    if kind == "flashcards":
        return (head or "<h2>Flashcards</h2>") + "<dl>" + "".join(
            f"<dt>{_inline(x.get('front'))}</dt><dd>{_inline(x.get('back'))}</dd>" for x in b.get("cards") or []) + "</dl>"
    if kind == "quiz":
        return (head or "<h2>Quiz</h2>") + "<ol>" + "".join(
            f"<li>{_inline(q.get('question'))}</li>" for q in b.get("questions") or []) + "</ol>"
    return ""


PAGE_CSS = """
@page { size: A4; margin: 22mm 20mm; }
body { font: 11pt/1.6 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; }
h1 { font-size: 22pt; line-height: 1.2; margin: 0 0 18pt; }
h2 { font-size: 14pt; margin: 20pt 0 6pt; }
h3, h4 { font-size: 12pt; margin: 14pt 0 4pt; }
p { margin: 0 0 8pt; }
ul, ol { margin: 0 0 10pt; padding-left: 18pt; }
aside { margin: 10pt 0; padding: 8pt 12pt; border-left: 3pt solid #3b6fe6; background: #f2f5fc; }
dl { margin: 0 0 10pt; } dt { font-weight: 600; margin-top: 6pt; } dd { margin: 0 0 0 12pt; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 12pt; font-size: 10pt; }
th, td { border: 1px solid #ccd; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f2f5fc; }
"""


def report_pdf_html(a: Artifact) -> str:
    title = html.escape(_clean((a.content_json or {}).get("title")) or "Report")
    body = "".join(_block_html(b) for b in report_blocks(a))
    return (f'<!doctype html><html><head><meta charset="utf-8"><title>{title}</title><style>{PAGE_CSS}</style></head>'
            f"<body><h1>{title}</h1>{body}</body></html>")


def report_pdf(a: Artifact) -> bytes:
    """The report printed to an A4 PDF with headless Chrome (ImageUnavailable when there is none)."""
    from app.slides.export import _run_chrome  # Chrome's print-to-PDF, as the slide deck PDF uses it

    data, _ = _run_chrome(report_pdf_html(a), ["--print-to-pdf={out}", "--no-pdf-header-footer",
                                               "--print-to-pdf-no-header"], "report.pdf")
    return data

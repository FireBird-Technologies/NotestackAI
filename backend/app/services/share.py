"""What a shared artifact (a report, infographic, audio overview, video, slide deck, flashcard set, quiz or mind map) shows to
someone with the link.

The public view is built from a whitelist, field by field, never by filtering the stored content: a field added to a
block later stays private until it is added here on purpose. It carries no post text, no quoted lines, no ids, no
paths, no instructions, no suggestions, and no name of the author or workspace."""

import re
import secrets

from app.config import settings
from app.models import Artifact, ArtifactShare
from app.pipeline.infographic import infographic_html
from app.services.artifacts import report_blocks
from app.services.storage import storage
from app.slides.build import view as slide_pages

MARKER = re.compile(r"\s*\[\d+\](?:\[\d+\])*")  # [n] points into citations the public view does not carry
MAX_TEXT = 20_000


def new_token() -> str:
    return secrets.token_urlsafe(16)


def share_url(token: str) -> str:
    return f"{settings.frontend_url.rstrip('/')}/r/{token}"


def _s(value, limit: int = MAX_TEXT) -> str:
    return str(value or "")[:limit]


def _node(n: dict, depth: int = 0) -> dict:
    """A mind map node as label, note and children only (no sources, no quotes)."""
    kids = [] if depth > 6 else [_node(c, depth + 1) for c in (n.get("children") or []) if isinstance(c, dict)]
    return {"id": _s(n.get("id"), 40), "label": _s(n.get("label"), 120), "note": _s(n.get("note"), 500),
            "sources": [], "children": kids}


def _block(b: dict) -> dict | None:
    kind, base = b.get("type"), {"id": _s(b.get("id"), 20), "type": b.get("type"), "title": _s(b.get("title"), 200)}
    if kind == "prose":
        return {**base, "title": "", "text": MARKER.sub("", _s(b.get("text")))}
    if kind == "callout":
        return {**base, "text": MARKER.sub("", _s(b.get("text"), 2000))}
    if kind == "key_terms":
        return {**base, "terms": [{"term": _s(t.get("term"), 200), "definition": _s(t.get("definition"), 800)}
                                  for t in b.get("terms") or [] if isinstance(t, dict)][:60]}
    if kind == "table":
        return {**base, "headers": [_s(h, 120) for h in b.get("headers") or []][:12],
                "rows": [[_s(c, 400) for c in r][:12] for r in b.get("rows") or [] if isinstance(r, list)][:60]}
    if kind == "timeline":
        return {**base, "events": [{"when": _s(e.get("when"), 80), "title": _s(e.get("title"), 200),
                                    "detail": _s(e.get("detail"), 800)}
                                   for e in b.get("events") or [] if isinstance(e, dict)][:40]}
    if kind == "plot":
        return {**base, "plot_kind": b.get("plot_kind") if b.get("plot_kind") in ("bar", "line", "scatter", "pie") else "bar",
                "x_label": _s(b.get("x_label"), 80), "y_label": _s(b.get("y_label"), 80),
                "unit": _s(b.get("unit"), 40),
                "points": [{"label": _s(p.get("label"), 160), "value": p.get("value"),
                            "display_value": _s(p.get("display_value"), 80), "detail": _s(p.get("detail"), 300)}
                           for p in b.get("points") or []
                           if isinstance(p, dict) and isinstance(p.get("value"), int | float)][:40]}
    if kind == "mind_map" and isinstance(b.get("root"), dict):
        return {**base, "root": _node(b["root"])}
    if kind == "infographic":  # only a finished one, as the page our own template built (never the model's markup)
        html, wide = b.get("html"), b.get("html_landscape")
        return {**base, "html": html, "html_landscape": wide if isinstance(wide, str) else None} if isinstance(html, str) and html else None
    if kind == "flashcards":
        return {**base, "cards": _cards(b.get("cards"))}
    if kind == "quiz":
        return {**base, "questions": _questions(b.get("questions"))}
    return None


def _cards(cards, limit: int = 60) -> list[dict]:
    """Flashcards as front and back only (no sources)."""
    return [{"front": _s(c.get("front"), 300), "back": _s(c.get("back"), 800)}
            for c in cards or [] if isinstance(c, dict)][:limit]


def _questions(questions, limit: int = 30) -> list[dict]:
    """Quiz questions with their answers and explanations, and no sources."""
    return [{"type": q.get("type"), "question": _s(q.get("question"), 600),
             "options": [_s(o, 300) for o in q.get("options") or []][:8],
             "correct": [i for i in q.get("correct") or [] if isinstance(i, int)][:8],
             "answer": _s(q.get("answer"), 600), "accepted": [_s(a, 200) for a in q.get("accepted") or []][:8],
             "explanation": _s(q.get("explanation"), 800), "sources": []}
            for q in questions or [] if isinstance(q, dict)][:limit]


def public_report(artifact: Artifact, share: ArtifactShare) -> dict:
    """The shared page's data for a report."""
    c = artifact.content_json or {}
    blocks = [x for b in report_blocks(artifact) if isinstance(b, dict) and (x := _block(b))]
    out = {"kind": "report", "title": _s(c.get("title"), 300), "format": "interactive" if c.get("format") == "interactive" else "document",
           "language": _s(c.get("language"), 40),
           "created_at": artifact.created_at.isoformat() if artifact.created_at else None, "blocks": blocks,
           "show_sources": False}  # a shared page never says which sources it was made from
    return out


def public_infographic(artifact: Artifact) -> dict:
    """The shared page's data for an infographic: its title and the page our own template builds from the stored text
    (every word escaped there). No source, no prompt, no ids."""
    c = artifact.content_json or {}
    return {"kind": "infographic", "title": _s(c.get("title"), 300), "html": infographic_html(c) or "",
            "html_landscape": infographic_html(c, "landscape") or "",
            "created_at": artifact.created_at.isoformat() if artifact.created_at else None}


def _head(artifact: Artifact, kind: str) -> dict:
    c = artifact.content_json or {}
    return {"kind": kind, "title": _s(c.get("title"), 300),
            "created_at": artifact.created_at.isoformat() if artifact.created_at else None}


def public_flashcards(artifact: Artifact) -> dict:
    return {**_head(artifact, "flashcards"), "cards": _cards((artifact.content_json or {}).get("cards"), 200)}


def public_quiz(artifact: Artifact) -> dict:
    return {**_head(artifact, "quiz"), "questions": _questions((artifact.content_json or {}).get("questions"), 100)}


def public_mind_map(artifact: Artifact) -> dict:
    """The map's tree as labels and notes only (no sources, no quotes), as a shared report shows its maps."""
    root = (artifact.content_json or {}).get("root")
    return {**_head(artifact, "mind_map"), "root": _node(root) if isinstance(root, dict) else None}


def public_slides(artifact: Artifact) -> dict:
    """The deck's slides as the pages our own slide builder draws (the same ones the app shows). No speaker notes."""
    pages = slide_pages(artifact.content_json or {})
    return {**_head(artifact, "slides"), "pages": [p for p in pages if isinstance(p, str)][:80]}


def public_audio(artifact: Artifact) -> dict:
    """The audio (a freshly signed link on every view) and its transcript, without the lines it quotes."""
    c = artifact.content_json or {}
    return {**_head(artifact, "audio"),
            "audio_url": storage.presign_get(artifact.storage_key) if artifact.storage_key else None,
            "duration": c.get("duration_s") if isinstance(c.get("duration_s"), (int, float)) else None,
            "segments": [{"speaker": _s(g.get("speaker"), 60), "text": _s(g.get("text"), 4000),
                          "start": g.get("start") if isinstance(g.get("start"), (int, float)) else 0,
                          "end": g.get("end") if isinstance(g.get("end"), (int, float)) else 0}
                         for g in c.get("segments") or [] if isinstance(g, dict)][:2000]}


def video_file(artifact: Artifact) -> str | None:
    """The finished video file: our own copy, or the one blog2video rendered."""
    if artifact.storage_key:
        return storage.presign_get(artifact.storage_key)
    url = (artifact.content_json or {}).get("video_url")
    return url if isinstance(url, str) and re.match(r"https?://", url) else None


def video_preview(artifact: Artifact) -> str | None:
    """blog2video's live player for the video (a public embed link, no key in it)."""
    url = (artifact.content_json or {}).get("preview_url")
    return url if isinstance(url, str) and re.match(r"https?://", url) else None


def public_video(artifact: Artifact) -> dict:
    """Shown on our own page: blog2video's live player (it plays the latest edit, rendered or not), else the MP4."""
    return {**_head(artifact, "video"), "preview_url": video_preview(artifact), "video_url": video_file(artifact)}

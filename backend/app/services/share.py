"""What a shared report shows to someone with the link.

The public view is built from a whitelist, field by field, never by filtering the stored content: a field added to a
block later stays private until it is added here on purpose. It carries no post text, no quoted lines, no ids, no
paths, no instructions, no suggestions, and no name of the author or workspace."""

import re
import secrets

from app.config import settings
from app.models import Artifact, ArtifactShare
from app.pipeline.infographic import infographic_html
from app.services.artifacts import report_blocks

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
    if kind == "mind_map" and isinstance(b.get("root"), dict):
        return {**base, "root": _node(b["root"])}
    if kind == "infographic":  # only a finished one, as the page our own template built (never the model's markup)
        html, wide = b.get("html"), b.get("html_landscape")
        return {**base, "html": html, "html_landscape": wide if isinstance(wide, str) else None} if isinstance(html, str) and html else None
    if kind == "flashcards":
        return {**base, "cards": [{"front": _s(c.get("front"), 300), "back": _s(c.get("back"), 800)}
                                  for c in b.get("cards") or [] if isinstance(c, dict)][:60]}
    if kind == "quiz":
        return {**base, "questions": [{
            "type": q.get("type"), "question": _s(q.get("question"), 600),
            "options": [_s(o, 300) for o in q.get("options") or []][:8],
            "correct": [i for i in q.get("correct") or [] if isinstance(i, int)][:8],
            "answer": _s(q.get("answer"), 600), "accepted": [_s(a, 200) for a in q.get("accepted") or []][:8],
            "explanation": _s(q.get("explanation"), 800)}
            for q in b.get("questions") or [] if isinstance(q, dict)][:30]}
    return None


def public_report(artifact: Artifact, share: ArtifactShare) -> dict:
    """The shared page's data for a report."""
    c = artifact.content_json or {}
    blocks = [x for b in report_blocks(artifact) if isinstance(b, dict) and (x := _block(b))]
    out = {"kind": "report", "title": _s(c.get("title"), 300), "format": "interactive" if c.get("format") == "interactive" else "document",
           "language": _s(c.get("language"), 40),
           "created_at": artifact.created_at.isoformat() if artifact.created_at else None, "blocks": blocks,
           "show_sources": bool(share.show_sources)}
    if share.show_sources:
        source = c.get("source") or {}
        # Only a post's own public web address is shown; an upload or anything else is named by its title alone.
        out["sources"] = {"chats": len(source.get("chat_ids") or []), "posts": [
            {"title": _s(s.get("title"), 300),
             "url": s["url"] if isinstance(s.get("url"), str) and re.match(r"https?://", s["url"]) else None}
            for s in c.get("sources") or [] if isinstance(s, dict)][:60]}
    return out


def public_infographic(artifact: Artifact) -> dict:
    """The shared page's data for an infographic: its title and the page our own template builds from the stored text
    (every word escaped there). No source, no prompt, no ids."""
    c = artifact.content_json or {}
    return {"kind": "infographic", "title": _s(c.get("title"), 300), "html": infographic_html(c) or "",
            "html_landscape": infographic_html(c, "landscape") or "",
            "created_at": artifact.created_at.isoformat() if artifact.created_at else None}

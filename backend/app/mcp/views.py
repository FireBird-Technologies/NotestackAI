"""How the API's records are shown to an assistant: the useful part, without megabytes of inline HTML."""

import json

from mcp.server.auth.provider import AccessToken

from app.config import settings
from app.mcp.common import shown

INLINE_HTML = {"html", "html_landscape", "slides_html", "slide_slots"}
MAX_CONTENT_CHARS = 60_000
# Made to be looked at or listened to, in Notestack. An assistant shown the raw data redraws it badly, so it gets an
# outline to talk about and the link to the real thing.
VISUAL = {"mind_map", "infographic", "slide_deck", "audio_overview", "quote_card", "carousel", "video"}
SHOW_IT = ("This is a visual or audio made in Notestack, and Notestack's own version is the real one. Always give the writer "
           "artifact_preview_url, even when it is displayed in the chat (and the url or download_url when present). Do not redraw or recreate it yourself; "
           "you may describe it using the outline.")
MAX_OUTLINE_LINES = 80
SHAREABLE = {"report", "infographic", "audio_overview", "video", "slide_deck", "flashcards", "quiz", "mind_map"}


def web_url(art: dict) -> str:
    base = settings.frontend_url.rstrip("/")
    if art.get("type") == "report":
        return f"{base}/app/reports/{art['id']}"
    if art.get("type") == "video":
        return f"{base}/app/videos/{art['id']}"
    if art.get("type") == "launch_kit":
        return f"{base}/app/launchpad/kits/{art['id']}"
    # This must identify the generated thing itself. In particular, never send an MCP user to the notebook and make
    # them hunt for a slide deck, audio overview, quiz, flashcards, infographic or Mind Constellation.
    return f"{base}/app/artifacts/{art['id']}"


def job_view(job: dict | None) -> dict | None:
    if not job:
        return None
    return {k: job.get(k) for k in ("id", "kind", "status", "progress", "message", "error", "artifact_id")}


def outline(node: dict, depth: int = 0, lines: list[str] | None = None) -> str:
    """A mind map as an indented list: every label, with the first two levels' notes."""
    lines = [] if lines is None else lines
    if len(lines) < MAX_OUTLINE_LINES and node.get("label"):
        note = (node.get("note") or "").strip()
        lines.append("  " * depth + "- " + node["label"] + (f": {note[:140]}" if note and depth < 2 else ""))
        for child in node.get("children") or []:
            outline(child, depth + 1, lines)
    return "\n".join(lines)


def artifact_view(art: dict, *, content: bool = True) -> dict:
    out = {k: art.get(k) for k in ("id", "type", "type_label", "title", "status", "notebook_id", "document_id", "url",
                                   "download_url", "slide_urls", "created_at", "adding")}
    out["title"] = shown(out.get("title"))
    out["job"] = job_view(art.get("job"))
    out["open_in_notestack"] = web_url(art)
    if art.get("feedback") is not None:
        out["feedback"] = art["feedback"]
    if art.get("type") == "report" and art.get("status") == "ready":
        out["present_it"] = ("This report was made by Notestack and is saved in the writer's Notestack. Show its title and "
                             "sections from content, name the notebook it came from, and give them artifact_preview_url. "
                             "Do not write a separate report yourself.")
    if art.get("type") in VISUAL:
        out["show_it"] = SHOW_IT
        root = (art.get("content") or {}).get("root")
        if content and art.get("type") == "mind_map" and isinstance(root, dict):
            out["outline"] = outline(root)
    elif content:
        body = {k: v for k, v in (art.get("content") or {}).items() if k not in INLINE_HTML}
        text = json.dumps(body, default=str)
        if len(text) <= MAX_CONTENT_CHARS:
            out["content"] = body
        else:  # a long report or transcript: the start, and the way to the rest
            out["content_preview"] = text[:MAX_CONTENT_CHARS // 4]
            out["content_truncated"] = f"The full text is {len(text)} characters. Open it in Notestack to read all of it."
    return {k: v for k, v in out.items() if v is not None}


async def artifact_view_with_preview(art: dict, access: AccessToken, *, content: bool = True) -> dict:
    """Return the model view with the frontend's real Share URL, never an authenticated /app route.

    Sharing is idempotent: the API reuses the frontend-created token when one already exists. The public page exists
    immediately and shows progress until a pending artifact is ready.
    """
    view = artifact_view(art, content=content)
    if art.get("type") not in SHAREABLE:
        return view
    from app.mcp import loopback  # late import keeps the small view helpers independent of the transport

    share = await loopback.data("POST", f"/api/artifacts/{art['id']}/share", access)
    preview = share["url"]
    view["artifact_preview_url"] = preview
    # Widgets historically consume open_in_notestack. Point it at the same public preview so no embedded result can
    # accidentally surface the private /app URL while model-facing code migrates to artifact_preview_url.
    view["open_in_notestack"] = preview
    return view


def document_row(d: dict) -> dict:
    return {k: d.get(k) for k in ("id", "title", "url", "published_at", "source_title", "words", "locked")}


def flashcards_view(view: dict, payload: dict) -> dict:
    """What the model is told about a set of flashcards: how many, and where to open them. The cards themselves go to the
    flip-card widget only, so the assistant has nothing to retype or to build a display (or a quiz) from."""
    out = {k: v for k, v in view.items() if k != "content"}
    out["card_count"] = len(payload.get("cards") or [])
    if payload.get("cards"):
        out["shown_in_chat"] = ("The writer is looking at these flashcards as flip cards in the chat. Show nothing else: no "
                                "list of the cards, no quiz, no other display. Say how many there are, which notebook "
                                "(scope_note), and give artifact_preview_url.")
    return out

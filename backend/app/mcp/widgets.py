"""Interactive results shown inside the chat (MCP Apps). The host fetches the page once, draws it in a sandbox, and
hands it the tool's structuredContent, which the host does not give to the model. Hosts without support show the
tool's text instead, so every tool using a widget still answers in words and a link."""

import json
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent

from app.config import settings
from app.mcp.common import shown, template_preview

MIME = "text/html;profile=mcp-app"
# A new address whenever the page changes: hosts keep their copy of a page by address.
MIND_MAP_URI = "ui://notestack/mind-constellation-v10"
MIND_MAP_UI = {"ui": {"resourceUri": MIND_MAP_URI}}
FLASHCARDS_URI = "ui://notestack/flashcards-v9"
FLASHCARDS_UI = {"ui": {"resourceUri": FLASHCARDS_URI}}
MAX_CARDS = 60
QUIZ_URI = "ui://notestack/quiz-v9"
QUIZ_UI = {"ui": {"resourceUri": QUIZ_URI}}
MAX_QUESTIONS = 40
INFOGRAPHIC_URI = "ui://notestack/infographic-v3"
INFOGRAPHIC_UI = {"ui": {"resourceUri": INFOGRAPHIC_URI}}
PICKER_URI = "ui://notestack/notebook-picker-v8"
PICKER_UI = {"ui": {"resourceUri": PICKER_URI}}
MAX_PICK_POSTS = 60
REPORT_URI = "ui://notestack/report-v9"
REPORT_UI = {"ui": {"resourceUri": REPORT_URI}}
MAX_REPORT_BLOCKS = 80
VIDEO_URI = "ui://notestack/video-v12"
VIDEO_UI = {"ui": {"resourceUri": VIDEO_URI}}
VIDEO_OPTIONS_URI = "ui://notestack/video-options-v8"
VIDEO_OPTIONS_UI = {"ui": {"resourceUri": VIDEO_OPTIONS_URI}}

OPTIONS_URI = "ui://notestack/generation-options-v55"
OPTIONS_UI = {"ui": {"resourceUri": OPTIONS_URI}}
_OPTIONS_HTML = Path(__file__).with_name("widgets") / "generation_options.html"


def app_only(meta: dict | None = None) -> dict:
    """Tool metadata for actions the themed App may call but the model must not bypass with a host-generated form."""
    ui = dict((meta or {}).get("ui") or {})
    ui["visibility"] = ["app"]
    return {"ui": ui}

MAX_NODES = 200
MAX_DEPTH = 4
MAX_SOURCES = 3
_HTML = Path(__file__).with_name("widgets") / "mind_map.html"
_FLASHCARDS_HTML = Path(__file__).with_name("widgets") / "flashcards.html"
_QUIZ_HTML = Path(__file__).with_name("widgets") / "quiz.html"
_INFOGRAPHIC_HTML = Path(__file__).with_name("widgets") / "infographic.html"
_PICKER_HTML = Path(__file__).with_name("widgets") / "notebook_picker.html"
_REPORT_HTML = Path(__file__).with_name("widgets") / "report.html"
_VIDEO_HTML = Path(__file__).with_name("widgets") / "video_player.html"
_VIDEO_OPTIONS_HTML = Path(__file__).with_name("widgets") / "video_options.html"


def _trim(node: dict, budget: list[int]) -> dict:
    """A copy of the map the widget can draw: labels, notes and a few quoted sources. It keeps whole levels before deeper ones,
    so a big map loses its finest details rather than whole themes."""
    def leaf(n: dict) -> dict:
        return {"label": str(n.get("label") or "")[:80], "note": str(n.get("note") or "")[:300],
                "sources": [{"title": str(s.get("title") or "")[:80], "quote": str(s.get("quote") or "")[:300]}
                            for s in (n.get("sources") or [])[:MAX_SOURCES] if isinstance(s, dict)],
                "children": []}
    budget[0] -= 1
    root = leaf(node)
    level = [(node, root)]
    for _ in range(MAX_DEPTH):
        nxt = []
        for src, out in level:
            for child in src.get("children") or []:
                if budget[0] <= 0:
                    return root
                if not isinstance(child, dict):
                    continue
                budget[0] -= 1
                kept = leaf(child)
                out["children"].append(kept)
                nxt.append((child, kept))
        level = nxt
    return root


def mind_map_payload(art: dict, open_url: str) -> dict:
    """What the widget draws: the map's labels, notes and a few quoted sources, never ids or file paths."""
    root = (art.get("content") or {}).get("root")
    ready = art.get("status") == "ready" and isinstance(root, dict)
    payload = {"kind": "mind_map", "status": art.get("status"), "title": shown(art.get("title")), "open_url": open_url,
               "root": _trim(root, [MAX_NODES]) if ready else None}
    if not ready:
        payload["message"] = ("Notestack could not make this one." if art.get("status") == "failed"
                              else "Your Mind Constellation is still being made. Ask Claude to show it again in a moment.")
    return payload


def flashcards_payload(art: dict, open_url: str) -> dict:
    """What the widget flips through: each card's front and back, never ids or source paths."""
    cards = (art.get("content") or {}).get("cards")
    ready = art.get("status") == "ready" and isinstance(cards, list) and cards
    payload = {"kind": "flashcards", "status": art.get("status"), "title": shown(art.get("title")), "open_url": open_url,
               "cards": [{"front": str(c.get("front") or "")[:300], "back": str(c.get("back") or "")[:800]}
                         for c in cards[:MAX_CARDS] if isinstance(c, dict)] if ready else []}
    if not ready:
        payload["message"] = ("Notestack could not make these." if art.get("status") == "failed"
                              else "Your flashcards are still being made. Ask Claude to show them again in a moment.")
    return payload


def _question(q: dict) -> dict:
    out = {"type": str(q.get("type") or ""), "question": str(q.get("question") or "")[:500],
           "explanation": str(q.get("explanation") or "")[:600]}
    if isinstance(q.get("options"), list):
        out["options"] = [str(o)[:300] for o in q["options"][:8]]
        out["correct"] = [i for i in q.get("correct") or [] if isinstance(i, int)]
    else:
        out["answer"] = str(q.get("answer") or "")[:500]
        out["accepted"] = [str(a)[:200] for a in (q.get("accepted") or [])[:8]]
    return out


def quiz_payload(art: dict, open_url: str) -> dict:
    """What the widget plays: Notestack's own questions, options, answers and explanations, never ids or source paths."""
    qs = (art.get("content") or {}).get("questions")
    ready = art.get("status") == "ready" and isinstance(qs, list) and qs
    payload = {"kind": "quiz", "status": art.get("status"), "title": shown(art.get("title")), "open_url": open_url,
               "questions": [_question(q) for q in qs[:MAX_QUESTIONS] if isinstance(q, dict)] if ready else []}
    if not ready:
        payload["message"] = ("Notestack could not make this quiz." if art.get("status") == "failed"
                              else "Your quiz is still being made. Ask Claude to show it again in a moment.")
    return payload


def infographic_payload(art: dict, open_url: str) -> dict:
    """The two exact pages Notestack rendered, sent only to the sandboxed view (never to the model)."""
    content = art.get("content") or {}
    ready = art.get("status") == "ready" and bool(content.get("html_landscape") or content.get("html"))
    payload = {"kind": "infographic", "artifact_id": art.get("id"), "status": art.get("status"),
               "title": shown(art.get("title")), "open_url": open_url,
               "html": content.get("html") if ready else None,
               "html_landscape": content.get("html_landscape") if ready else None}
    if not ready:
        payload["message"] = ("Notestack could not make this infographic." if art.get("status") == "failed"
                              else "Your infographic is still being made.")
    return payload


def report_payload(art: dict, open_url: str) -> dict:
    """What the form shows for a finished report: its title and blocks, trimmed. A visual that cannot be drawn there (a mind
    map, an infographic) is named and left to Notestack; flashcards and quizzes show a taste."""
    content = art.get("content") or {}
    ready = art.get("status") == "ready" and isinstance(content.get("blocks"), list)
    payload = {"kind": "report", "status": art.get("status"), "title": str(content.get("title") or art.get("title") or "Report")[:200],
               "open_url": open_url, "blocks": []}
    if not ready:
        payload["message"] = ("Notestack could not make this report." if art.get("status") == "failed"
                              else "Your report is still being made.")
        return payload
    budget = 150_000
    for b in content["blocks"]:
        if not isinstance(b, dict) or budget <= 0:
            break
        t, title = b.get("type"), str(b.get("title") or "")[:120]
        if t == "prose":
            out = {"type": t, "text": str(b.get("text") or "")[:30_000]}
        elif t == "callout":
            out = {"type": t, "title": title, "text": str(b.get("text") or "")[:4000]}
        elif t == "key_terms":
            out = {"type": t, "title": title, "terms": [{"term": str(x.get("term") or "")[:120], "definition": str(x.get("definition") or "")[:600]}
                                                        for x in (b.get("terms") or [])[:60] if isinstance(x, dict)]}
        elif t == "table":
            out = {"type": t, "title": title, "headers": [str(h)[:80] for h in (b.get("headers") or [])[:12]],
                   "rows": [[str(c)[:300] for c in r[:12]] for r in (b.get("rows") or [])[:60] if isinstance(r, list)]}
        elif t == "timeline":
            out = {"type": t, "title": title, "events": [{"when": str(e.get("when") or "")[:60], "title": str(e.get("title") or "")[:200],
                                                          "detail": str(e.get("detail") or "")[:500]} for e in (b.get("events") or [])[:40] if isinstance(e, dict)]}
        elif t == "flashcards":
            cards = [c for c in (b.get("cards") or []) if isinstance(c, dict)]
            out = {"type": t, "title": title, "count": len(cards),
                   "cards": [{"front": str(c.get("front") or "")[:300], "back": str(c.get("back") or "")[:600]} for c in cards[:12]]}
        elif t == "quiz":
            qs = [q for q in (b.get("questions") or []) if isinstance(q, dict)]
            out = {"type": t, "title": title, "count": len(qs), "questions": [str(q.get("question") or "")[:300] for q in qs[:6]]}
        elif t in ("mind_map", "infographic"):
            out = {"type": t, "title": title}
        else:
            continue
        budget -= len(json.dumps(out))
        payload["blocks"].append(out)
    return payload


def picker_payload(notebooks: list[dict], posts: list[dict], default_id: str | None, for_what: str) -> dict:
    """What the picker shows: the writer's notebooks (the default marked) and recent posts to fill a new one with."""
    return {"kind": "notebook_picker", "for_what": for_what[:200],
            "notebooks": [{"id": n["id"], "title": shown(str(n["title"]))[:120], "post_count": n.get("document_count", 0),
                           "is_default": bool(default_id) and n["id"] == default_id, "is_archive": bool(n.get("is_archive"))}
                          for n in notebooks],
            "posts": [{"id": d["id"], "title": str(d.get("title") or "Untitled")[:120]} for d in posts[:MAX_PICK_POSTS]]}


def video_payload(artifact_id: str, status: str | None, video_url: str | None, title: str | None, open_url: str,
                  *, preview_url: str | None = None, ready: bool = False,
                  poll_url: str | None = None, poll_token: str | None = None) -> dict:
    """What the player shows: the rendered MP4 when present, otherwise Notestack's ready live preview."""
    available = bool(video_url or ready)
    return {"kind": "video", "artifact_id": artifact_id, "status": "ready" if available else (status or "generating"),
            "title": shown(title), "video_url": video_url, "preview_url": preview_url,
            "poll_url": poll_url, "poll_token": poll_token, "open_url": open_url}


def video_options_payload(catalog: dict, voices: dict | None = None) -> dict:
    """Everything the app's own video screen offers: templates (posters, badges, colours), styles, languages and the
    writer's saved voices."""
    def template(t: dict) -> dict:
        c = t.get("preview_colors") or {}
        fallback = t.get("preview_url")
        preview = template_preview(t["id"], fallback)
        return {"id": str(t["id"]), "name": str(t.get("name") or t["id"])[:60], "preview_url": preview,
                "fallback_preview_url": fallback if fallback and fallback != preview else None,
                "badge": (t.get("badge") or ("Popular" if t.get("popular_template") else "Yours" if t.get("custom") else None)),
                "colors": {k: c.get(k) for k in ("accent", "bg", "text") if c.get(k)}}

    return {"kind": "video_options",
            "templates": [template(t) for t in catalog.get("templates", []) if isinstance(t, dict) and t.get("id")][:40]
            + [template({**t, "custom": True}) for t in catalog.get("my_templates", []) if isinstance(t, dict) and t.get("id")][:10],
            "styles": [{"id": str(s["id"]), "name": str(s.get("name") or s["id"])[:60], "kind": s.get("kind"),
                        "description": (s.get("description") or "")[:200]}
                       for s in catalog.get("video_styles", []) if isinstance(s, dict) and s.get("id")][:20],
            "languages": [{"code": l["code"], "name": l["name"]} for l in catalog.get("languages", []) if isinstance(l, dict)],
            "voices": [{"id": str(v["voice_id"]), "name": str(v.get("name") or "Voice")[:60], "gender": v.get("gender"),
                        "accent": v.get("accent")} for v in (voices or {}).get("saved", []) if isinstance(v, dict) and v.get("voice_id")][:30]}


_THEME = (Path(__file__).with_name("widgets") / "theme.css")
_FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
          '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500'
          '&family=Space+Grotesk:wght@500;600;700&display=swap">')


def _themed(html: str) -> str:
    """A page as served: the app's fonts and design tokens added last, so they win over the page's own defaults."""
    css = _THEME.read_text(encoding="utf-8")
    return html.replace("</head>", f"{_FONTS}<style>{css}</style></head>", 1)


def _preview_domains() -> list[str]:
    """The host the template pictures come from, so the chat view may show them."""
    from urllib.parse import urlsplit

    u = urlsplit(settings.mcp_template_preview_base_url.strip())
    return [f"{u.scheme}://{u.netloc}"] if u.scheme == "https" and u.netloc else []


def _api_domains() -> list[str]:
    """The public API origin used by widget-only, signed status polling."""
    from urllib.parse import urlsplit

    u = urlsplit(settings.api_url.strip())
    return [f"{u.scheme}://{u.netloc}"] if u.scheme == "https" and u.netloc else []


def _csp(*, display_modes: list[str] | None = None, description: str | None = None,
         frame_domains: list[str] | None = None, connect_domains: list[str] | None = None) -> dict:
    """What a page may load, plus presentation hints a host needs before it loads the page."""
    csp = {"resourceDomains": _media_domains() + _preview_domains() +
           ["https://fonts.googleapis.com", "https://fonts.gstatic.com"]}
    if frame_domains:
        csp["frameDomains"] = frame_domains
    if connect_domains:
        csp["connectDomains"] = connect_domains
    meta = {"ui": {"csp": csp}}
    if display_modes:
        meta["openai/ui"] = {"availableDisplayModes": display_modes}
    if description:
        meta["openai/widgetDescription"] = description
    return meta


def _media_domains() -> list[str]:
    """Where a rendered video may be played from inside the chat view (the host only allows what the page declares)."""
    hosts = ["https://*.r2.dev", "https://*.r2.cloudflarestorage.com", "https://*.cloudflarestorage.com",
             settings.b2v_app_url.rstrip("/")]
    return hosts + [d.strip() for d in settings.mcp_media_domains.split(",") if d.strip()]


def _report_block(b: dict) -> dict | None:
    """One block of a report as the view draws it: its words and tables, never ids, paths or inline pages."""
    t = b.get("type")
    block_id = str(b.get("id") or "")[:40]
    title = str(b.get("title") or "")[:120]
    artifact_id = str(b.get("artifact_id") or "")[:40]
    if t in ("prose", "callout"):
        return {"id": block_id, "type": t, "title": title, "text": str(b.get("text") or "")[:8000]}
    if t == "key_terms":
        return {"id": block_id, "type": t, "title": title,
                "terms": [{"term": str(x.get("term") or "")[:120], "definition": str(x.get("definition") or "")[:500]}
                          for x in (b.get("terms") or [])[:40] if isinstance(x, dict)]}
    if t == "table":
        return {"id": block_id, "type": t, "title": title, "headers": [str(h)[:80] for h in (b.get("headers") or [])[:10]],
                "rows": [[str(c)[:300] for c in r[:10]] for r in (b.get("rows") or [])[:60] if isinstance(r, list)]}
    if t == "timeline":
        return {"id": block_id, "type": t, "title": title,
                "events": [{"when": str(x.get("when") or "")[:60], "title": str(x.get("title") or "")[:160],
                            "detail": str(x.get("detail") or "")[:400]} for x in (b.get("events") or [])[:40] if isinstance(x, dict)]}
    if t == "mind_map" and isinstance(b.get("root"), dict):
        return {"id": block_id, "type": t, "title": title, "artifact_id": artifact_id, "root": _trim(b["root"], [60])}
    if t == "flashcards":
        return {"id": block_id, "type": t, "title": title, "artifact_id": artifact_id,
                "cards": [{"front": str(c.get("front") or "")[:300], "back": str(c.get("back") or "")[:800]}
                          for c in (b.get("cards") or [])[:30] if isinstance(c, dict)]}
    if t == "quiz":
        return {"id": block_id, "type": t, "title": title, "artifact_id": artifact_id,
                "questions": [_question(q) for q in (b.get("questions") or [])[:20] if isinstance(q, dict)]}
    if t == "infographic":
        return {"id": block_id, "type": t, "title": title, "artifact_id": artifact_id,
                "status": str(b.get("status") or "")[:20]}
    return None


def _report_suggestion(s: dict) -> dict | None:
    """One safe, actionable suggestion for an interactive report widget."""
    if s.get("kind") not in ("mind_map", "flashcards", "quiz", "infographic"):
        return None
    return {"id": str(s.get("id") or "")[:20], "after_block_id": str(s.get("after_block_id") or "")[:40],
            "kind": s["kind"], "brief": str(s.get("brief") or "")[:500], "why": str(s.get("why") or "")[:500]}


def report_view_payload(art: dict, open_url: str) -> dict:
    """What the report view shows: Notestack's own finished report, block by block."""
    c = art.get("content") or {}
    raw = c.get("blocks")
    ready = art.get("status") == "ready" and isinstance(raw, list) and raw
    blocks = [x for x in (_report_block(b) for b in raw[:MAX_REPORT_BLOCKS] if isinstance(b, dict)) if x] if ready else []
    suggestions = [x for x in (_report_suggestion(s) for s in (c.get("suggestions") or []) if isinstance(s, dict)) if x] if ready else []
    adding = [{k: a.get(k) for k in ("suggestion_id", "status", "message", "error", "kind")}
              for a in (art.get("adding") or []) if isinstance(a, dict)]
    payload = {"kind": "report", "artifact_id": art.get("id"), "status": art.get("status"), "title": shown(c.get("title") or art.get("title")),
               "format": c.get("format"), "open_url": open_url, "blocks": blocks,
               "suggestions": suggestions, "adding": adding}
    if not blocks:
        payload["message"] = "Notestack could not make this report." if art.get("status") == "failed" else "Your report is still being written."
    return payload


def with_widget(view: dict, payload: dict) -> CallToolResult:
    """The words for the model (and for hosts with no widget), and the map for the widget alone."""
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(view, default=str))],
                          structuredContent=payload, isError=False)


def register(mcp: FastMCP) -> None:
    @mcp.resource(MIND_MAP_URI, name="mind-constellation", title="Mind Constellation", mime_type=MIME,
                  description="Draws a finished Mind Constellation as an interactive picture.", meta=_csp())
    def mind_constellation() -> str:
        return _themed(_HTML.read_text(encoding="utf-8"))

    @mcp.resource(FLASHCARDS_URI, name="flashcards", title="Flashcards", mime_type=MIME,
                  description="Shows a set of flashcards you can flip through.", meta=_csp())
    def flashcards() -> str:
        return _themed(_FLASHCARDS_HTML.read_text(encoding="utf-8"))

    @mcp.resource(QUIZ_URI, name="quiz", title="Quiz", mime_type=MIME,
                  description="Plays a quiz one question at a time, with answers and explanations.", meta=_csp())
    def quiz() -> str:
        return _themed(_QUIZ_HTML.read_text(encoding="utf-8"))

    @mcp.resource(INFOGRAPHIC_URI, name="infographic", title="Infographic", mime_type=MIME,
                  description="Shows a finished Notestack infographic directly in the conversation.",
                  meta=_csp(display_modes=["inline", "fullscreen"],
                            description="A finished infographic that can be viewed inline or expanded."))
    def infographic() -> str:
        return _themed(_INFOGRAPHIC_HTML.read_text(encoding="utf-8"))

    @mcp.resource(PICKER_URI, name="notebook-picker", title="Choose a notebook", mime_type=MIME,
                  description="Lets the writer pick a notebook, or make a new one and tick its posts.", meta=_csp())
    def notebook_picker() -> str:
        return _themed(_PICKER_HTML.read_text(encoding="utf-8"))

    @mcp.resource(VIDEO_URI, name="video", title="Video", mime_type=MIME,
                  description="Plays a finished video in the chat, or shows that it is still being made.",
                  meta=_csp(frame_domains=[settings.b2v_app_url.rstrip("/")], connect_domains=_api_domains()))
    def video() -> str:
        return _themed(_VIDEO_HTML.read_text(encoding="utf-8"))

    @mcp.resource(VIDEO_OPTIONS_URI, name="video-options", title="Video options", mime_type=MIME,
                  description="Lets the writer choose the template, shape, length and voice of a video.",
                  meta=_csp())
    def video_options() -> str:
        return _themed(_VIDEO_OPTIONS_HTML.read_text(encoding="utf-8"))


    @mcp.resource(OPTIONS_URI, name="generation-options", title="Choose settings", mime_type=MIME,
                  description="Lets the writer choose the settings (difficulty, template, look, length...) for what is made.",
                  meta=_csp(frame_domains=[settings.b2v_app_url.rstrip("/")], connect_domains=_api_domains()))
    def generation_options() -> str:
        """The form page, with the quiz, flashcards and mind map pages inside it so a finished one plays right there."""
        players = {k: _themed((Path(__file__).with_name("widgets") / f).read_text(encoding="utf-8"))
                   for k, f in (("quiz", "quiz.html"), ("flashcards", "flashcards.html"), ("mind_map", "mind_map.html"),
                                ("infographic", "infographic.html"), ("report", "report.html"), ("video", "video_player.html"))}
        blob = json.dumps(players).replace("</", "<\\/")
        return _themed(_OPTIONS_HTML.read_text(encoding="utf-8")).replace("/*__PLAYERS__*/{}", blob)

    @mcp.resource(REPORT_URI, name="report", title="Report", mime_type=MIME,
                  description="Shows a finished Notestack report: its sections, tables, timelines and embedded quiz, cards and map.",
                  meta=_csp(description="A finished Notestack report that can be read in the conversation."))
    def report() -> str:
        players = {k: _themed((Path(__file__).with_name("widgets") / f).read_text(encoding="utf-8"))
                   for k, f in (("mind_map", "mind_map.html"), ("flashcards", "flashcards.html"),
                                ("quiz", "quiz.html"), ("infographic", "infographic.html"))}
        blob = json.dumps(players).replace("</", "<\\/")
        return _themed(_REPORT_HTML.read_text(encoding="utf-8")).replace("/*__PLAYERS__*/{}", blob)

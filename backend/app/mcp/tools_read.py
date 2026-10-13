"""Tools that only look: nothing here changes the writer's Notestack."""

import uuid
from datetime import timedelta
from typing import Literal

from mcp.server.fastmcp import FastMCP

from app.auth import encode_signed
from app.config import settings
from app.mcp import loopback, options, scope, views, widgets
from app.mcp.common import DATA, SCOPE_HELP, VISUAL, ToolError, guarded, shown, token, uid
from app.mcp.loopback import ApiError

READ_ONLY = {"readOnlyHint": True, "openWorldHint": False}
MAX_SUGGEST_POSTS = 200


def _desc(text: str) -> dict:
    return {"description": text, "annotations": READ_ONLY}


def register(mcp: FastMCP) -> None:
    @mcp.tool(**_desc(
        "List the writer's notebooks with how many posts, chats and generated items each holds. The notebook called "
        "\"All posts\" (is_archive) holds everything. Use it to get a notebook_id."))
    @guarded("list_notebooks")
    async def list_notebooks() -> dict:
        rows = await loopback.data("GET", "/api/notebooks", token())
        return {"notebooks": [{k: n.get(k) for k in ("id", "title", "description", "document_count", "chat_count",
                                                      "artifact_count", "is_archive", "updated_at")} | {"title": shown(n.get("title"))}
                              for n in rows]}

    @mcp.tool(**_desc(
        "Open one notebook: its description, summary and the posts in it. Use it to check what a notebook holds before "
        "generating from it. " + DATA))
    @guarded("get_notebook")
    async def get_notebook(notebook_id: str) -> dict:
        nb = await loopback.data("GET", f"/api/notebooks/{uid(notebook_id)}", token())
        return {"id": nb["id"], "title": shown(nb["title"]), "description": nb.get("description"), "summary": nb.get("summary"),
                "is_archive": nb["is_archive"], "posts": [views.document_row(d) for d in nb["documents"]]}

    @mcp.tool(**_desc(
        "List the past conversations in one notebook (id, title, last updated). Pass a chat_id to ask_notebook to "
        "continue one, or to get_chat_messages to read it."))
    @guarded("list_notebook_chats")
    async def list_notebook_chats(notebook_id: str) -> dict:
        return {"chats": await loopback.data("GET", f"/api/notebooks/{uid(notebook_id)}/chats", token())}

    @mcp.tool(**_desc("Read every message in one chat with its citations. " + DATA))
    @guarded("get_chat_messages")
    async def get_chat_messages(chat_id: str) -> dict:
        rows = await loopback.data("GET", f"/api/notebooks/chats/{uid(chat_id)}/messages", token())
        return {"messages": [{"role": m["role"], "text": m["text"],
                              "citations": [{k: c.get(k) for k in ("marker", "title", "url", "line_start", "line_end")}
                                            for c in m["citations"]]} for m in rows]}

    @mcp.tool(**_desc(
        "List the writer's connected sources (a Substack, blog or feed, or their imports) with how many posts each holds "
        "and whether it has finished syncing. Use it to get a source_id or to check a sync."))
    @guarded("list_sources")
    async def list_sources() -> dict:
        rows = await loopback.data("GET", "/api/sources", token())
        return {"sources": [{"id": s["id"], "title": s["title"], "platform": s["platform"], "url": s["site_url"] or s["feed_url"],
                             "posts": s["document_count"] - s["locked_count"], "locked_posts": s["locked_count"],
                             "sync_status": s["sync_status"], "sync_error": s["sync_error"], "last_synced_at": s["last_synced_at"]}
                            for s in rows]}

    @mcp.tool(**_desc(
        "List the themes found across the writer's archive, biggest first, with post counts and whether each is rising or "
        "going quiet. Use get_topic for the posts in one. To make something from a topic, pass its id as topic_id to a "
        "generate tool."))
    @guarded("list_topics")
    async def list_topics(limit: int = 40) -> dict:
        data = await loopback.data("GET", "/api/topics", token(), params={"limit": max(1, min(limit, 100))})
        return {"topics": [{k: n.get(k) for k in ("id", "name", "summary", "post_count", "status", "last_at")} for n in data["nodes"]],
                "rising": data["insights"]["rising"], "dormant": data["insights"]["dormant"]}

    @mcp.tool(**_desc("Open one topic: its summary, related topics and its posts. " + DATA))
    @guarded("get_topic")
    async def get_topic(topic_id: str) -> dict:
        t = await loopback.data("GET", f"/api/topics/{uid(topic_id)}", token())
        return {"id": t["id"], "name": t["name"], "summary": t["summary"], "post_count": t["post_count"], "status": t["status"],
                "related": t["related"], "posts": [views.document_row(p) for p in t["posts"]]}

    @mcp.tool(**_desc(
        "Browse what the writer has generated (reports, quizzes, flashcards, mind maps, infographics, slide decks, audio, "
        "launch kits). Filter by type, notebook_id, status (pending, ready, failed) or text. Returns summaries only; use "
        "get_artifact for the content."))
    @guarded("list_artifacts")
    async def list_artifacts(type: str | None = None, notebook_id: str | None = None, status: str | None = None,
                             q: str | None = None, limit: int = 20, offset: int = 0) -> dict:
        params = {"type": type, "notebook_id": uid(notebook_id) if notebook_id else None, "status": status, "q": q,
                  "limit": max(1, min(limit, 50)), "offset": max(0, offset)}
        page = await loopback.data("GET", "/api/artifacts", token(), params={k: v for k, v in params.items() if v is not None})
        return {"total": page["total"], "items": [views.artifact_view(a, content=False) for a in page["items"]]}

    @mcp.tool(**_desc(
        "Get one generated item: its status and, when ready, its content (a report's sections, a quiz's questions, "
        "flashcards, a launch kit's posts) and download links. Use it after any generate tool and check every few "
        "seconds while the status is pending or generating. Links expire, so do not save them. If the status is "
        "failed, retry_artifact can run it again. For a visual (mind map, infographic, slide deck, audio) you get an outline "
        "and links, not the picture: give the writer the open_in_notestack link and do not redraw it. " + DATA))
    @guarded("get_artifact")
    async def get_artifact(artifact_id: str) -> dict:
        return views.artifact_view(await loopback.data("GET", f"/api/artifacts/{uid(artifact_id)}", token()))

    @mcp.tool(meta=widgets.MIND_MAP_UI, **_desc(
        "Show a finished Mind Constellation to the writer as an interactive picture in the chat (they can click the stars "
        "to open branches and read the quoted posts). Use it when generate_mind_map said the map was still being made, or "
        "when the writer asks to see a map they already have (find it with list_artifacts, type mind_map). A host "
        "without that shows the outline and link instead. " + VISUAL + " " + DATA))
    @guarded("show_mind_map")
    async def show_mind_map(artifact_id: str):
        art = await loopback.data("GET", f"/api/artifacts/{uid(artifact_id)}", token())
        if art["type"] != "mind_map":
            raise ToolError("not_a_mind_map", f"That is a {art.get('type_label') or art['type']}, not a Mind Constellation.")
        view = views.artifact_view(art)
        return widgets.with_widget(view, widgets.mind_map_payload(art, view["open_in_notestack"]))

    @mcp.tool(meta=widgets.INFOGRAPHIC_UI, **_desc(
        "Show a finished Notestack infographic directly in the chat. Use it when generate_infographic said it was still "
        "being made, or when the writer asks to see an infographic they already have. The exact Notestack page is shown "
        "in a sandboxed view; do not recreate it. Give them the open_in_notestack link too. " + DATA))
    @guarded("show_infographic")
    async def show_infographic(artifact_id: str):
        art = await loopback.data("GET", f"/api/artifacts/{uid(artifact_id)}", token())
        if art["type"] != "infographic":
            raise ToolError("not_an_infographic", f"That is a {art.get('type_label') or art['type']}, not an infographic.")
        view = views.artifact_view(art, content=False)
        return widgets.with_widget(view, widgets.infographic_payload(art, view["open_in_notestack"]))

    @mcp.tool(meta=widgets.FLASHCARDS_UI, **_desc(
        "Show a finished set of flashcards to the writer as flip cards in the chat. Use it when generate_flashcards said "
        "they were still being made, or when the writer asks to see a set they already have (find it with list_artifacts, "
        "type flashcards). A host without that shows the cards as text. Always give them the open_in_notestack link too. "
        + DATA))
    @guarded("show_flashcards")
    async def show_flashcards(artifact_id: str):
        art = await loopback.data("GET", f"/api/artifacts/{uid(artifact_id)}", token())
        if art["type"] != "flashcards":
            raise ToolError("not_flashcards", f"That is a {art.get('type_label') or art['type']}, not a set of flashcards.")
        view = views.artifact_view(art)
        payload = widgets.flashcards_payload(art, view["open_in_notestack"])
        return widgets.with_widget(views.flashcards_view(view, payload), payload)

    @mcp.tool(**_desc(
        "Show a finished Notestack report as a readable page (used by the settings form so the report appears in the chat). "
        "You do not need it: generate a report through choose_options. " + DATA))
    @guarded("show_report")
    async def show_report(artifact_id: str):
        art = await loopback.data("GET", f"/api/artifacts/{uid(artifact_id)}", token())
        if art["type"] != "report":
            raise ToolError("not_a_report", f"That is a {art.get('type_label') or art['type']}, not a report.")
        view = views.artifact_view(art, content=False)
        return widgets.with_widget(view, widgets.report_payload(art, view["open_in_notestack"]))

    @mcp.tool(meta=widgets.REPORT_UI, **_desc(
        "Show a finished Notestack report in the chat: its title and every section, with its tables, timelines, key terms and "
        "embedded quiz, flashcards and map. Use it when generate_report said it was still being written, or when the writer "
        "asks to read a report they already have (find it with list_artifacts, type report). The writer reads it there, so "
        "do not retype or rebuild it, and give them the open_in_notestack link too. Never write a report yourself. " + DATA))
    @guarded("view_report")
    async def view_report(artifact_id: str):
        art = await loopback.data("GET", f"/api/artifacts/{uid(artifact_id)}", token())
        if art["type"] != "report":
            raise ToolError("not_a_report", f"That is a {art.get('type_label') or art['type']}, not a report.")
        view = views.artifact_view(art, content=False)
        return widgets.with_widget(view, widgets.report_view_payload(art, view["open_in_notestack"]))

    @mcp.tool(meta=widgets.QUIZ_UI, **_desc(
        "Play a finished Notestack quiz in the chat, one question at a time with answers and explanations. Use it when "
        "generate_quiz said it was still being made, or when the writer asks to take a quiz they already have (find it with "
        "list_artifacts, type quiz). Never write a quiz yourself: only Notestack's own is shown. Give them the "
        "open_in_notestack link too. " + DATA))
    @guarded("show_quiz")
    async def show_quiz(artifact_id: str):
        art = await loopback.data("GET", f"/api/artifacts/{uid(artifact_id)}", token())
        if art["type"] != "quiz":
            raise ToolError("not_a_quiz", f"That is a {art.get('type_label') or art['type']}, not a quiz.")
        view = views.artifact_view(art)
        return widgets.with_widget(view, widgets.quiz_payload(art, view["open_in_notestack"]))

    @mcp.tool(meta=widgets.PICKER_UI, **_desc(
        "ONLY for choosing where imported posts go. NEVER use it to make a quiz, flashcards, report, infographic, slide deck, "
        "audio overview, mind map or video, and never for a question: making anything goes through choose_options, whose single "
        "form already has the notebook and posts step. It shows their notebooks to click, with their "
        "connected app's notebook marked, plus a 'New notebook' option where they tick the posts to put in it. Their choice comes "
        "back as their next message: use that notebook (or call create_notebook with those post ids). If you cannot show "
        "it, list the notebooks from the result in words, numbered, with 'a new notebook (choose its posts)' as the last "
        "option, and ask them to pick. Never choose for them. for_what says what it is for. " + DATA))
    @guarded("choose_notebook")
    async def choose_notebook(for_what: str = "") -> dict:
        access = token()
        notebooks = await loopback.data("GET", "/api/notebooks", access)
        docs = (await loopback.data("GET", "/api/documents", access, params={"limit": widgets.MAX_PICK_POSTS, "indexed_only": "true"}))["items"]
        current = await scope.current_assistant_notebook(access)
        payload = widgets.picker_payload(notebooks, docs, current["id"] if current else None, for_what)
        app_name = scope.assistant_name(access)
        payload["assistant_name"] = app_name
        words = [f"{i}. {n['title']} ({n['post_count']} posts)" + (f" - their {app_name} notebook" if n["is_default"] else "")
                 for i, n in enumerate(payload["notebooks"], 1)]
        words.append(f"{len(words) + 1}. A new notebook (they choose its posts)")
        view = {"ask_writer": "Ask which one. Do nothing until they answer.", "options": words,
                "posts_for_a_new_notebook": [{"id": p["id"], "title": p["title"]} for p in payload["posts"][:20]]}
        return widgets.with_widget(view, payload)

    @mcp.tool(meta=widgets.VIDEO_OPTIONS_UI, **_desc(
        "Not needed for making a video: choose_options with make video already includes these choices, with the notebook step, "
        "in one form. Use this only if choose_options cannot be shown. It lets the writer CHOOSE how their video is made, with the same options as the Notestack app: video style, an optional "
        "focus, the template (with pictures and colours), the video colours, the language, and the narration voice (their "
        "saved voices, or no voiceover). Call this before generate_video and wait for their answer, which comes back as their "
        "next message. If you cannot show it, list the template, style and voice names from the result in words and ask "
        "them to choose each. Never pick for them. " + DATA))
    @guarded("choose_video_options")
    async def choose_video_options() -> dict:
        access = token()
        catalog = await loopback.data("GET", "/api/videos/catalog", access)
        try:
            voices = await loopback.data("GET", "/api/video-voices", access)
        except ApiError:  # the writer can still make a video without picking a voice
            voices = {}
        payload = widgets.video_options_payload(catalog, voices)
        view = {"ask_writer": "Ask them to choose, then call generate_video with their answers. Do nothing until they answer.",
                "templates": [{"id": t["id"], "name": t["name"]} for t in payload["templates"]],
                "styles": [{"id": s["id"], "name": s["name"]} for s in payload["styles"]],
                "voices": [{"custom_voice_id": v["id"], "name": v["name"], "gender": v["gender"], "accent": v["accent"]} for v in payload["voices"]]
                + [{"name": "No voiceover (voice_gender none)"}],
                "languages": [l["code"] for l in payload["languages"]][:12],
                "also": "colors (accent, background, text as #rrggbb) and an optional focus"}
        return widgets.with_widget(view, payload)

    @mcp.tool(meta=widgets.OPTIONS_UI, **_desc(
        "The way to make anything. Call it FIRST when the writer asks for a quiz, flashcards, report, infographic, "
        "slide deck, audio overview, mind map or video: it shows one form where they choose the notebook (or tick posts for a new "
        "one) and then the same settings as the Notestack app: quiz or flashcards (how many, difficulty, question types), a report (written or interactive, "
        "template), an infographic (look, layout), a slide deck (format, length, theme), an audio overview (format, hosts, "
        "length) or a mind map (focus). The source step is always shown: never preselect or skip the notebook and post "
        "choices, even if a notebook was used earlier in the conversation. Its button makes the "
        "thing and plays it in the chat itself. Always use this themed form; never replace it with a host-generated form. "
        "If you cannot show it, list the fields in words and ask "
        "them to choose. Never choose for them. Video: template, style, shape, length, narration, language. " + DATA))
    @guarded("choose_options")
    async def choose_options(make: Literal["report", "quiz", "flashcards", "infographic", "slide_deck", "audio_overview", "mind_map", "video"]) -> dict:
        access = token()
        templates = None
        if make in ("report", "video"):
            try:
                templates = await loopback.data("GET", "/api/reports/templates" if make == "report" else "/api/videos/catalog", access)
            except ApiError:
                if make == "report":
                    raise
                templates = {}  # the video maker's list is not available: the form still offers shape, length and voice
        voices = None
        if make == "video":
            try:
                voices = await loopback.data("GET", "/api/video-voices", access)
            except ApiError:  # no voice list: the form falls back to a female or male voice
                voices = None
        payload = options.form(make, templates, voices)
        # Creation always begins with the writer choosing a notebook and its posts. Keeping scope out of this tool's schema
        # also prevents a host/model from silently selecting All posts and jumping straight to the settings screen.
        notebooks = await loopback.data("GET", "/api/notebooks", access)
        page = await loopback.data("GET", "/api/documents", access,
                                   params={"limit": widgets.MAX_PICK_POSTS, "indexed_only": "true"})
        docs = page["items"]
        if not any(n["is_archive"] for n in notebooks):
            # This is only a choice in the form. The real archive notebook is created lazily if the writer uses it.
            notebooks.insert(0, {"id": None, "title": "All posts", "document_count": page["total"], "is_archive": True})
        payload |= widgets.picker_payload(notebooks, docs, None, make) | {"kind": "generation_options"}
        payload["assistant_name"] = scope.assistant_name(access)
        state_id = uuid.uuid4().hex
        payload["state_url"] = f"{settings.api_url.rstrip('/')}/api/mcp/widget-state"
        payload["state_token"] = encode_signed(
            {"typ": "mcp_widget_state", "sub": access.subject, "tv": (access.claims or {}).get("tv"),
             "sid": state_id, "kind": make},
            timedelta(days=3650),
        )
        payload["notebook_id"], note = None, None
        view = {"ask_writer": "Tell them to use the themed Notestack form: it lets them choose the notebook or posts, then "
                              "the settings, and its button makes and plays the result right there. Do not build another "
                              "form and do not call " + payload["tool"] + " or choose_notebook yourself. Never include "
                              "notebook IDs or post IDs in a message to the writer.",
                "notebook_id": payload["notebook_id"], "scope_note": note,
                "fields": [{"argument": f["key"], "label": f["label"], "choices": [o["label"] for o in f.get("options", [])] or "free text"}
                           for f in payload["fields"]]}
        return widgets.with_widget(view, payload)

    @mcp.tool(**_desc(
        "Check a background job by job_id: queued, running, done or failed, with a progress message. Use it after "
        "add_source, import_url or sync_source. For generated content, get_artifact is simpler."))
    @guarded("get_job")
    async def get_job(job_id: str) -> dict:
        return views.job_view(await loopback.data("GET", f"/api/jobs/{uid(job_id)}", token()))

    @mcp.tool(**_desc(
        "List older posts worth sharing again: timeless (evergreen) posts the writer has not reshared lately, and posts "
        "published on this day in earlier years. Use it for \"what should I repost?\"."))
    @guarded("list_resurface")
    async def list_resurface(limit: int = 10) -> dict:
        data = await loopback.data("GET", "/api/resurface", token(), params={"limit": max(1, min(limit, 30))})
        keep = ("id", "title", "url", "published_at", "reason", "angle", "years_ago", "rank")
        return {"evergreen": [{k: p.get(k) for k in keep if p.get(k) is not None} for p in data["evergreen"]],
                "on_this_day": [{k: p.get(k) for k in keep if p.get(k) is not None} for p in data["on_this_day"]],
                "posts_not_scored_yet": data["unscored"]}

    @mcp.tool(**_desc(
        "List the report templates (each has a template_id and what it writes) plus the interactive one. Use it to pick "
        "a template_id for generate_report."))
    @guarded("list_report_templates")
    async def list_report_templates() -> dict:
        data = await loopback.data("GET", "/api/reports/templates", token())
        keep = ("id", "name", "description")
        return {"templates": [{k: t[k] for k in keep} for t in data["templates"]],
                "interactive": {k: data["interactive"][k] for k in keep}}

    @mcp.tool(**_desc(
        "Suggest report ideas that fit some of the writer's posts, each with ready-written instructions you can pass to "
        "generate_report. " + SCOPE_HELP + " It uses AI, so call it only when the writer has not already said what report "
        "they want. " + DATA))
    @guarded("suggest_report_templates", cost=3)
    async def suggest_report_templates(notebook_id: str | None = None, topic_id: str | None = None, source_id: str | None = None,
                                       document_ids: list[str] | None = None, archive: bool = False,
                                       topic: str | None = None) -> dict:
        access = token()
        where = await scope.resolve(access, notebook_id=notebook_id, topic_id=topic_id, source_id=source_id,
                                    document_ids=document_ids, archive=archive)
        nb = await loopback.data("GET", f"/api/notebooks/{where.notebook_id}", access)
        ids = [d["id"] for d in nb["documents"] if not d.get("locked")][:MAX_SUGGEST_POSTS]
        if not ids:
            raise ToolError("nothing_to_use", "There are no usable posts to suggest a report from.")
        out = await loopback.data("POST", "/api/reports/suggest", access,
                                  json={"document_ids": ids, "notebook_id": where.notebook_id, "topic": topic})
        return out | {"scope_note": where.note}

    @mcp.tool(**_desc(
        "Show the writer's plan and what they have used and have left (posts, audio minutes, reports, infographics, launch "
        "kits, videos). Use it when they ask how much they have left. You do not need it before generating: limits are "
        "enforced for you and reported clearly."))
    @guarded("get_usage")
    async def get_usage() -> dict:
        return await loopback.data("GET", "/api/settings/usage", token())

    @mcp.tool(**_desc(
        "Read the standing notes Notestack has saved about the writer's preferences (who they write for, tone). Read-only. " + DATA))
    @guarded("get_memory_notes")
    async def get_memory_notes() -> dict:
        data = await loopback.data("GET", "/api/memory", token())
        return {"notes": [{"key": n["key"], "value": n["value"]} for n in data["items"]]}

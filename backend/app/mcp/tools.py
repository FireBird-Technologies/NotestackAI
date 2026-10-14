"""The tools an assistant can use. Each wraps something the web app already does, through the app's own API."""

from datetime import UTC, datetime, timedelta

from mcp.server.fastmcp import FastMCP

from app.mcp import loopback, scope, tools_read, tools_write, views, widgets
from app.mcp.common import DATA, ToolError, guarded, parse_sse, token, uid

KINDS = ("posts", "topics", "sources", "notebooks")
CONVERSATION_GAP = timedelta(minutes=15)  # a question this soon after the last one is the same conversation

FIND_CONTENT = (
    "USE THIS first whenever the user mentions their own post, notebook, topic, publication or Substack by name or subject. "
    "Find anything the writer has by name: posts, topics (themes), sources (a publication or feed) and notebooks, "
    "all in one call. Use this whenever the writer mentions a post, theme, publication or subject, so you do not "
    "have to guess which kind it is. Returns matches grouped by kind, with ids and counts. If several kinds match "
    "and it is unclear which they mean, ask them in one short question. For questions about what they wrote, use "
    "ask_notebook. Free, no AI call. " + DATA
)
ASK_NOTEBOOK = (
    "USE THIS, NOT YOUR OWN KNOWLEDGE, whenever the user asks anything about their own notes, posts, writing, notebooks, "
    "sources or archive, including 'what did I say about...', 'summarise my...', 'what are my posts about'. Never answer "
    "those from general knowledge or the web: you have not read their posts, only this tool has. "
    "The way to answer any question about what the writer wrote: what they said, how their thinking changed, whether "
    "they contradicted themselves, a comparison across posts. You cannot read their posts directly, so use this. It "
    "answers using only their own posts, with citations (post title, URL, line range and the quoted words). If the "
    "writer has not said which notebook, call list_notebooks and ask them in words which one (offer the first as the default), then pass its visible title as notebook_title. To compare or "
    "summarise several posts, ask for that in the question. Pass the returned chat_id to ask a follow-up in the same "
    "conversation: one conversation's questions stay together in one Notestack chat, titled with the app's name. "
    "It only answers questions: it does not make a report, quiz, flashcards, video or anything else, so do not use its "
    "answer to build one yourself; use the generate_* tools, which make it in Notestack. It uses AI and counts toward their plan. If unsupported is true, the posts do not answer the "
    "question: say so rather than guessing. The question and answer are saved in their Notestack chats. " + DATA
)


def _label(access) -> str:
    return (access.claims or {}).get("cn") or "Claude"


async def _current_chat(access, notebook_id: str, label: str) -> str | None:
    """The chat this app is in the middle of, so questions in one conversation stay in one chat even when the assistant
    does not pass chat_id back: the newest chat this app started here, if it was used in the last few minutes."""
    now = datetime.now(UTC)
    for chat in await loopback.data("GET", f"/api/notebooks/{notebook_id}/chats", access):  # newest first
        if not (chat["title"] or "").startswith(f"{label}: "):
            continue
        used = datetime.fromisoformat(chat["updated_at"]) if chat.get("updated_at") else None
        if used and used.tzinfo is None:
            used = used.replace(tzinfo=UTC)
        return chat["id"] if used and now - used <= CONVERSATION_GAP else None
    return None


def _has(text, needle: str) -> bool:
    return needle in (text or "").lower()


def register(mcp: FastMCP) -> None:
    @mcp.tool(description=FIND_CONTENT, annotations={
        "readOnlyHint": True, "destructiveHint": False, "openWorldHint": False,
    })
    @guarded("find_content")
    async def find_content(query: str, kinds: list[str] | None = None, limit: int = 10) -> dict:
        wanted = [k for k in (kinds or KINDS) if k in KINDS] or list(KINDS)
        limit = max(1, min(limit, 25))
        needle = query.strip().lower()
        if not needle:
            raise ToolError("empty_query", "Say what to look for.")
        access, out = token(), {}
        if "posts" in wanted:
            docs = await loopback.data("GET", "/api/documents", access, params={"q": query.strip(), "limit": limit})
            out["posts"] = {"total": docs["total"], "items": [views.document_row(d) for d in docs["items"]]}
        if "topics" in wanted:
            nodes = (await loopback.data("GET", "/api/topics", access))["nodes"]
            out["topics"] = [{"id": n["id"], "name": n["name"], "post_count": n["post_count"], "summary": n["summary"]}
                             for n in nodes if _has(n["name"], needle) or _has(n.get("summary"), needle)][:limit]
        if "sources" in wanted:
            rows = await loopback.data("GET", "/api/sources", access)
            out["sources"] = [{"id": s["id"], "title": s["title"], "platform": s["platform"], "url": s["site_url"] or s["feed_url"],
                               "post_count": s["document_count"] - s["locked_count"], "sync_status": s["sync_status"]}
                              for s in rows if any(_has(s.get(f), needle) for f in ("title", "site_url", "feed_url"))][:limit]
        if "notebooks" in wanted:
            rows = await loopback.data("GET", "/api/notebooks", access)
            out["notebooks"] = [{"id": n["id"], "title": n["title"], "post_count": n["document_count"], "is_archive": n["is_archive"]}
                                for n in rows if _has(n["title"], needle) or _has(n.get("description"), needle)][:limit]
        return out

    @mcp.tool(description=ASK_NOTEBOOK, annotations={"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False})
    @guarded("ask_notebook", cost=3)
    async def ask_notebook(question: str, notebook_id: str | None = None, notebook_title: str | None = None,
                           chat_id: str | None = None) -> dict:
        access = token()
        resolved = await scope.resolve(access, notebook_id=notebook_id, notebook_title=notebook_title)
        nid = resolved.notebook_id
        label = _label(access)
        continued = bool(chat_id)
        if not chat_id and (recent := await _current_chat(access, nid, label)):
            chat_id, continued = recent, True
        body = {"question": question, "label": label} | ({"chat_id": uid(chat_id)} if chat_id else {})
        resp = await loopback.call("POST", f"/api/notebooks/{nid}/chat", access, json=body)
        answer, new_chat, error = None, None, None
        for name, data in parse_sse(resp.text):
            if name == "status":
                new_chat = data.get("chat_id", new_chat)
            elif name == "answer":
                answer = data
            elif name == "error":
                error = data.get("message")
        if answer is None:
            raise ToolError("no_answer", error or "No answer came back. Try again.")
        return {"answer": answer["text"], "unsupported": answer.get("unsupported", False), "chat_id": new_chat,
                "notebook_id": nid, "notebook_note": resolved.note, "continued_chat": continued,
                "note": "Pass this chat_id with the next question in this conversation.", "citations": [
                    {k: c.get(k) for k in ("marker", "title", "url", "line_start", "line_end", "span", "kind")}
                    for c in answer.get("citations", [])]}

    widgets.register(mcp)
    tools_read.register(mcp)
    tools_write.register(mcp)

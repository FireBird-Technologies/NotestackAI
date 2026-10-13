"""Resolve the notebook and optional post filter a tool should work on.

The writer always chooses the scope. Selections reuse an existing notebook (or the built-in All posts notebook) and
carry document_ids as a filter; they do not manufacture a notebook merely to run one generation.
"""

from dataclasses import dataclass

from mcp.server.auth.provider import AccessToken

from app.mcp import loopback
from app.mcp.common import ToolError, shown, uid

MAX_POSTS = 300  # maximum posts in one generated selection
PAGE = 200


@dataclass
class Resolved:
    notebook_id: str
    note: str | None = None
    document_ids: list[str] | None = None


def assistant_name(access: AccessToken) -> str:
    """The connected MCP client's display name, used for notebooks it explicitly creates."""
    return str((access.claims or {}).get("cn") or "Claude").strip()[:30] or "Claude"


def is_assistant_notebook(n: dict, name: str) -> bool:
    """A regular notebook created for this connected assistant."""
    title = n["title"].strip()
    return not n["is_archive"] and (title.lower() == name.lower() or title.lower().startswith(name.lower() + " "))


async def current_assistant_notebook(access: AccessToken) -> dict | None:
    name = assistant_name(access)
    return next((n for n in await loopback.data("GET", "/api/notebooks", access)
                 if is_assistant_notebook(n, name)), None)  # newest first


async def default_notebook(access: AccessToken) -> Resolved:
    """Nothing was named, so the writer chooses: a notebook, or posts. Never guessed."""
    notebooks = await loopback.data("GET", "/api/notebooks", access)
    raise ToolError(
        "choose_scope",
        "The writer has not said what to use. To MAKE something call choose_options now (make = quiz, flashcards, report, "
        "infographic, slide_deck, audio_overview, mind_map or video): its one form lets them click a notebook or tick posts, then "
        "choose settings. For a question, ask them in words which notebook (listed below). "
        "Do not pick for them and do not generate yet. "
        "If it cannot be shown, ask in one numbered question: 1) use a notebook (listed below) or 2) choose posts "
        "(find_content, then document_ids). If the writer already chose earlier in this conversation, reuse that choice. For a report also "
        "offer the templates from list_report_templates and the document or interactive format in the same question.",
        notebooks=[{"notebook_id": n["id"], "title": shown(n["title"]), "posts": n.get("document_count"),
                    "is_archive": n["is_archive"]} for n in notebooks],
        choose_posts="find_content (kinds posts), then document_ids; or topic_id / source_id if they pick a theme or publication")


async def resolve(access: AccessToken, *, notebook_id: str | None = None, topic_id: str | None = None,
                  source_id: str | None = None, document_ids: list[str] | None = None, archive: bool = False) -> Resolved:
    picked = [name for name, v in (("notebook_id", notebook_id), ("topic_id", topic_id), ("source_id", source_id),
                                    ("archive", archive or None)) if v]
    if document_ids and not notebook_id and not archive:
        picked.append("document_ids")
    if not picked:
        return await default_notebook(access)
    if len(picked) > 1:
        raise ToolError("pick_one", "Say what to use with at most one of notebook_id, topic_id, source_id, document_ids "
                                    "or archive=true.", given=picked)
    if notebook_id:
        nb = await loopback.data("GET", f"/api/notebooks/{uid(notebook_id)}", access)
        ids = sorted({uid(i) for i in document_ids}) if document_ids else None
        return Resolved(nb["id"], f"Used their notebook '{shown(nb['title'])}'. Tell the writer which notebook is being used.", ids)
    if archive:
        archive_nb = await loopback.data("POST", "/api/notebooks/archive", access)
        ids = sorted({uid(i) for i in document_ids}) if document_ids else None
        note = f"Used {len(ids)} selected posts from All posts." if ids is not None else "Used all their posts."
        return Resolved(archive_nb["id"], note, ids)
    if topic_id:
        topic = await loopback.data("GET", f"/api/topics/{uid(topic_id)}", access)
        ids = [p["id"] for p in topic["posts"] if not p.get("locked")]
        return await _archive_selection(access, ids, f"topic '{topic['name']}'")
    if source_id:
        sid = uid(source_id)
        sources = await loopback.data("GET", "/api/sources", access)
        source = next((s for s in sources if s["id"] == sid), None)
        if not source:
            raise ToolError("not_found", "That source was not found.", status=404)
        name = source.get("title") or source.get("site_url") or source["feed_url"]
        ids = await source_post_ids(access, sid)
        return await _archive_selection(access, ids, f"source '{name}'")
    ids = sorted({uid(i) for i in document_ids or []})
    return await _archive_selection(access, ids, f"{len(ids)} chosen posts")


async def _archive_selection(access: AccessToken, ids: list[str], what: str) -> Resolved:
    """Use selected posts without manufacturing a visible scratch notebook for them."""
    if not ids:
        raise ToolError("nothing_to_use", f"There are no usable posts in {what}. Posts past the plan's limit are not "
                                          "indexed and cannot be used.")
    capped = ids[:MAX_POSTS]
    archive = await loopback.data("POST", "/api/notebooks/archive", access)
    cut = f" (the first {MAX_POSTS} of {len(ids)})" if len(ids) > MAX_POSTS else ""
    return Resolved(archive["id"], f"Used {len(capped)} posts from {what}{cut}.", capped)


async def source_post_ids(access: AccessToken, source_id: str) -> list[str]:
    ids, offset = [], 0
    while len(ids) < MAX_POSTS:
        page = await loopback.data("GET", "/api/documents", access,
                                   params={"source_id": source_id, "indexed_only": "true", "limit": PAGE, "offset": offset})
        ids += [d["id"] for d in page["items"]]
        offset += PAGE
        if offset >= page["total"]:
            break
    return ids

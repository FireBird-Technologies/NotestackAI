"""Remote MCP servers offered as one-click suggestions on the connections page. Suggestions only: connecting still
goes through the normal create flow, which discovers the server and runs its sign-in."""

from concurrent.futures import ThreadPoolExecutor

from app.config import settings
from app.mcp_client.composio import CURATED_APPS
from app.mcp_client.icon import fetch_server_icon, monogram_icon

# Curated apps shown as one-click suggestions. Composio apps are separate cards so each account and its tools remain
# independently controllable; the UI also offers the provider's live catalog for everything else.
CATALOG: list[dict] = [
    {"name": "B2V", "server_url": "https://api.blog2video.app/mcp/sse", "description": "Blog2Video: turn your posts into videos"},
    {"name": "Notion", "server_url": "https://mcp.notion.com/mcp", "description": "Your notes, pages and docs"},
    {"name": "Zapier", "server_url": "https://mcp.zapier.com/api/v1/connect", "description": "Automations across your apps"},
    *[
        {
            "name": app["name"], "server_url": "https://connect.composio.dev/mcp",
            "description": app["description"], "provider": "composio", "app_slug": slug,
            "icon_source_url": app["app_url"],
        }
        for slug, app in CURATED_APPS.items()
    ],
]

_icons: dict[str, str] = {}  # real logos only, kept for the life of the process


def catalog_with_icons() -> list[dict]:
    entries = [
        {**entry, "server_url": settings.composio_mcp_url if entry.get("provider") == "composio" else entry["server_url"]}
        for entry in CATALOG
    ]
    sources = [entry.get("icon_source_url") or entry["server_url"] for entry in entries]
    missing = [source for source in sources if source not in _icons]
    if missing:
        with ThreadPoolExecutor(max_workers=8) as pool:
            for url, icon in zip(missing, pool.map(fetch_server_icon, missing), strict=True):
                if icon:
                    _icons[url] = icon
    return [
        {
            **{key: value for key, value in entry.items() if key != "icon_source_url"},
            "icon_url": _icons.get(entry.get("icon_source_url") or entry["server_url"])
            or monogram_icon(entry["name"]),
        }
        for entry in entries
    ]

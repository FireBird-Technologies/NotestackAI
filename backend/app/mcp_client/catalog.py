"""Remote MCP servers offered as one-click suggestions on the connections page. Suggestions only: connecting still
goes through the normal create flow, which discovers the server and runs its sign-in."""

from concurrent.futures import ThreadPoolExecutor

from app.mcp_client.icon import fetch_server_icon, monogram_icon

# Curated apps shown as one-click suggestions. Slack has no dynamic registration, so connecting it needs a Slack app
# listed in OUTBOUND_MCP_OAUTH_CLIENTS_JSON.
CATALOG: list[dict[str, str]] = [
    {"name": "B2V", "server_url": "https://api.blog2video.app/mcp/sse", "description": "Blog2Video: turn your posts into videos"},
    {"name": "Slack", "server_url": "https://mcp.slack.com/mcp", "description": "Search and read channels and messages"},
    {"name": "Canva", "server_url": "https://mcp.canva.com/mcp", "description": "Designs, posters and presentations"},
    {"name": "Notion", "server_url": "https://mcp.notion.com/mcp", "description": "Your notes, pages and docs"},
    {"name": "Zapier", "server_url": "https://mcp.zapier.com/api/v1/connect", "description": "Automations across your apps"},
]

_icons: dict[str, str] = {}  # real logos only, kept for the life of the process


def catalog_with_icons() -> list[dict[str, str]]:
    missing = [entry["server_url"] for entry in CATALOG if entry["server_url"] not in _icons]
    if missing:
        with ThreadPoolExecutor(max_workers=8) as pool:
            for url, icon in zip(missing, pool.map(fetch_server_icon, missing), strict=True):
                if icon:
                    _icons[url] = icon
    return [{**entry, "icon_url": _icons.get(entry["server_url"]) or monogram_icon(entry["name"])} for entry in CATALOG]

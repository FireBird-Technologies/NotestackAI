"""Tools call Notestack's own API in process, as the signed-in writer, so every rule the web app has applies to them
too: who the user is, which workspace, plan limits. Only the routes the web app's own screens use are reachable, and
only with the permission the writer gave the app. The app's MCP token never reaches the API: each call carries a
normal token that lives for a minute, made here for that writer."""

import re
import uuid

import httpx
from mcp.server.auth.provider import AccessToken

from app.auth import create_short_access_token

_ID = r"[0-9a-fA-F-]{36}"
_BLOCK = r"[A-Za-z0-9_-]{1,40}"
READ, WRITE, SHARE = "mcp:read", "mcp:write", "mcp:share"


def _routes(scope: str, *rows: tuple[str, str]) -> list:
    return [(method, re.compile(f"^{pattern}$"), scope) for method, pattern in rows]


# Exactly the routes the web app's own screens use, each with the permission it needs.
ALLOWED = [
    *_routes(
        READ,
        ("GET", "/api/documents"),  # the list: titles and links, never the text of a post
        ("GET", "/api/topics"), ("GET", f"/api/topics/{_ID}"),
        ("GET", "/api/sources"),
        ("GET", "/api/notebooks"), ("GET", f"/api/notebooks/{_ID}"),
        ("GET", f"/api/notebooks/{_ID}/chats"), ("GET", f"/api/notebooks/chats/{_ID}/messages"),
        ("GET", "/api/artifacts"), ("GET", f"/api/artifacts/{_ID}"),
        ("GET", f"/api/jobs/{_ID}"),
        ("GET", "/api/videos/catalog"), ("GET", "/api/video-voices"),  # the templates, styles and languages the video maker offers
        ("GET", f"/api/videos/{_ID}"), ("GET", f"/api/videos/{_ID}/status"),  # status and rendered MP4 address
        ("GET", "/api/resurface"),
        ("GET", "/api/reports/templates"), ("POST", "/api/reports/suggest"),
        ("GET", "/api/settings/usage"), ("GET", "/api/memory"),
        ("POST", "/api/notebooks/archive"),
        ("POST", f"/api/notebooks/{_ID}/chat"),  # saves the question and answer in their chats
    ),
    *_routes(
        WRITE,
        ("POST", "/api/notebooks"),
        ("POST", f"/api/notebooks/{_ID}/documents"), ("DELETE", f"/api/notebooks/{_ID}/documents/{_ID}"),
        ("POST", "/api/sources"), ("POST", "/api/sources/url"), ("POST", f"/api/sources/{_ID}/sync"),
        ("POST", "/api/artifacts/generate"), ("POST", f"/api/artifacts/{_ID}/retry"),
        ("POST", "/api/videos"),  # the web app's own video route, which asks blog2video to make it
        ("POST", f"/api/reports/{_ID}/blocks"), ("DELETE", f"/api/reports/{_ID}/blocks/{_BLOCK}"),
    ),
    *_routes(SHARE, ("POST", f"/api/artifacts/{_ID}/share"), ("DELETE", f"/api/artifacts/{_ID}/share")),
]


class NotAllowed(Exception):
    """The tool tried to reach a route MCP does not expose, or one the writer did not allow this app to use."""


class ApiError(Exception):
    def __init__(self, status: int, detail):
        super().__init__(f"{status}: {detail}")
        self.status = status
        self.detail = detail


def uid(value: str) -> str:
    """A real UUID or an error, so an id can never smuggle a path into a URL."""
    try:
        return str(uuid.UUID(str(value)))
    except ValueError as exc:
        raise ValueError("That is not a valid id.") from exc


def _scope_needed(method: str, path: str) -> str | None:
    return next((scope for m, rx, scope in ALLOWED if m == method and rx.match(path)), None)


async def call(method: str, path: str, access: AccessToken, *, params: dict | None = None, json: dict | None = None,
               timeout: float = 120) -> httpx.Response:
    needed = _scope_needed(method, path)
    if needed is None or needed not in access.scopes:
        raise NotAllowed(f"{method} {path}")
    token = create_short_access_token(uuid.UUID(access.subject), (access.claims or {})["tv"])
    from app.main import app  # late: main mounts the MCP server, which imports this module

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://notestack.internal", timeout=timeout) as c:
        resp = await c.request(method, path, params=params, json=json, headers={"Authorization": f"Bearer {token}"})
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text)
        except ValueError:
            detail = resp.text
        raise ApiError(resp.status_code, detail)
    return resp


async def data(method: str, path: str, access: AccessToken, **kw):
    """call(), returning the decoded JSON."""
    return (await call(method, path, access, **kw)).json()

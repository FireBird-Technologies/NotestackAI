"""Best-effort brand icon for a connected MCP server, fetched once and stored with the connection."""

import base64
import logging
import re
from html import escape
from urllib.parse import quote, urlsplit

import httpx

log = logging.getLogger(__name__)

# Hosts whose MCP endpoint lives on a different domain than the brand's own site.
_BRAND_DOMAINS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"githubcopilot\.com$"), "github.com"),
    (re.compile(r"gmailmcp\.googleapis\.com$"), "gmail.com"),
    (re.compile(r"calendarmcp\.googleapis\.com$"), "calendar.google.com"),
    (re.compile(r"drivemcp\.googleapis\.com$"), "drive.google.com"),
    (re.compile(r"googleapis\.com$"), "google.com"),
]
_TWO_PART_SUFFIX = {"co", "com", "org", "net", "gov", "ac"}
_MAX_BYTES = 150_000
_FAVICONS = "https://www.google.com/s2/favicons?sz=128&domain="
_DUCKDUCKGO = "https://icons.duckduckgo.com/ip3/{domain}.ico"
GENERATED_KIND = "image/svg+xml"


def brand_domain(server_url: str) -> str | None:
    host = (urlsplit(server_url).hostname or "").lower()
    if not host or "." not in host:
        return None
    for pattern, domain in _BRAND_DOMAINS:
        if pattern.search(host):
            return domain
    labels = host.split(".")
    keep = 3 if len(labels) > 2 and labels[-2] in _TWO_PART_SUFFIX else 2
    return ".".join(labels[-keep:])


def _download(url: str) -> str | None:
    response = httpx.get(url, timeout=4.0, follow_redirects=True)
    kind = response.headers.get("content-type", "").split(";")[0].strip().lower()
    if kind in {"image/x-icon", "image/vnd.microsoft.icon"}:
        kind = "image/x-icon"
    if response.status_code != 200 or not kind.startswith("image/") or kind == "image/svg+xml":
        return None
    if not response.content or len(response.content) > _MAX_BYTES:
        return None
    return f"data:{kind};base64,{base64.b64encode(response.content).decode()}"


def fetch_server_icon(server_url: str) -> str | None:
    """A `data:` URI for the server's real logo, or None. Never raises: a missing logo must not fail a connection."""
    domain = brand_domain(server_url)
    if not domain:
        return None
    for source in (_FAVICONS + quote(domain, safe=""), _DUCKDUCKGO.format(domain=quote(domain, safe=""))):
        try:
            icon = _download(source)
        except Exception:  # noqa: BLE001 - purely cosmetic
            log.info("Could not fetch an icon for %s from %s", domain, urlsplit(source).hostname)
            continue
        if icon:
            return icon
    return None


def monogram_icon(name: str) -> str:
    """A generated logo (the name's initial on a brand-blue tile), so a connection never has no icon."""
    letter = escape(next((c for c in name.strip() if c.isalnum()), "M").upper())
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" '
        'fill="#217cff"/><text x="64" y="64" text-anchor="middle" dominant-baseline="central" '
        'font-family="Inter,Arial,sans-serif" font-size="68" font-weight="700" fill="#fff">'
        f"{letter}</text></svg>"
    )
    return f"data:{GENERATED_KIND};base64,{base64.b64encode(svg.encode()).decode()}"


def is_generated(icon: str | None) -> bool:
    return not icon or icon.startswith(f"data:{GENERATED_KIND}")


def ensure_icon(server_url: str, name: str, current: str | None = None) -> str:
    """The connection's icon: keep a real one, otherwise try to fetch it, otherwise a generated monogram. Never empty."""
    if current and not is_generated(current):
        return current
    return fetch_server_icon(server_url) or monogram_icon(name)

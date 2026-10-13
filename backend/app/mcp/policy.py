"""Which apps may connect, and how much we can tell the writer about them.

Any app can register itself (that is how Claude and ChatGPT connect), so what stops a stranger's app from asking a
writer to approve it is what the approval screen shows: the app's name is self-declared and cannot be trusted, the
address the writer would be sent back to can. Known apps are marked verified; the rest are shown as unverified."""

from urllib.parse import urlparse

VERIFIED_HOSTS = {"claude.ai", "claude.com", "chatgpt.com", "chat.openai.com"}
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
APP_SCHEMES = {"cursor", "vscode", "vscode-insiders"}  # desktop editors that catch the sign-in on their own scheme

SCOPES = ["mcp:read", "mcp:write", "mcp:share"]
ADVERTISED = ["mcp:read", "mcp:write"]  # what apps are told to ask for; sharing is only ever added by the writer
SCOPE_LABELS = {
    "mcp:read": "Search your posts, topics and notebooks, and ask questions about your writing",
    "mcp:write": "Create notebooks, import sources and generate reports, quizzes, audio and more",
    "mcp:share": "Make a report public, with a link anyone can open",
}


class BadRedirect(ValueError):
    pass


def check_redirect_uri(uri: str) -> str:
    """Return how far to trust where the sign-in ends up: "verified", "local" or "unverified". Raise BadRedirect for
    an address that must never be used (not web, not a known app scheme, or carrying credentials or a fragment)."""
    try:
        parsed = urlparse(uri)
        host = parsed.hostname or ""
        parsed.port  # noqa: B018  (raises on a bad port)
    except ValueError as exc:
        raise BadRedirect("That is not a valid address.") from exc
    if parsed.fragment or parsed.username or parsed.password:
        raise BadRedirect("The address may not contain a fragment or a login.")
    if parsed.scheme == "https":
        if not host:
            raise BadRedirect("The address has no host.")
        return "verified" if host in VERIFIED_HOSTS else "unverified"
    if parsed.scheme == "http" and host in LOOPBACK_HOSTS:
        return "local"
    if parsed.scheme in APP_SCHEMES:
        return "local"
    raise BadRedirect("Only https addresses, localhost and known editor apps can be used.")


def display_host(uri: str) -> str:
    parsed = urlparse(uri)
    if parsed.scheme in ("http", "https"):
        return parsed.netloc
    return f"{parsed.scheme}://"

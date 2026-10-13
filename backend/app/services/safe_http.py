"""Fetch a URL a user gave us without letting it reach our own network.

Anything the writer (or an assistant acting for them) can point us at, a feed, a page, a site, must go through
safe_get. It refuses non-web schemes, credentials in the URL, odd ports, and any host that resolves to a private,
loopback, link-local or otherwise non-public address (cloud metadata at 169.254.169.254, postgres, minio, the
renderer). Redirects are followed by hand so every hop is checked again.

Residual risk: the name is resolved here and again by the HTTP client, so a hostile DNS server could answer
differently the second time. Block egress to private ranges at the network edge as well.
"""

import ipaddress
import socket
from urllib.parse import urljoin, urlparse

import httpx

ALLOWED_PORTS = {None, 80, 443}
MAX_REDIRECTS = 5
_REDIRECTS = {301, 302, 303, 307, 308}


class UnsafeURL(httpx.HTTPError):
    """The address is not a public web address we are willing to fetch."""


def _resolve(host: str, port: int | None) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UnsafeURL(f"Could not resolve {host}.") from exc
    return [info[4][0] for info in infos]


def _is_public(address: str) -> bool:
    ip = ipaddress.ip_address(address.split("%")[0])
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def check_url(url: str) -> None:
    """Raise UnsafeURL unless url is a plain http(s) address on a public host."""
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError as exc:
        raise UnsafeURL("That is not a valid address.") from exc
    if parsed.scheme not in ("http", "https"):
        raise UnsafeURL("Only http and https addresses can be fetched.")
    host = parsed.hostname
    if not host:
        raise UnsafeURL("That address has no host.")
    if parsed.username or parsed.password:
        raise UnsafeURL("Addresses with a login in them are not allowed.")
    if port not in ALLOWED_PORTS:
        raise UnsafeURL("That port is not allowed.")
    addresses = _resolve(host, port)
    if not addresses or not all(_is_public(a) for a in addresses):
        raise UnsafeURL("That address points to a private network.")


def safe_get(url: str, *, timeout: float = 30, headers: dict | None = None, params: dict | None = None) -> httpx.Response:
    """GET url, checking the address and every redirect hop. Raises UnsafeURL (an httpx.HTTPError) when refused."""
    for _ in range(MAX_REDIRECTS + 1):
        check_url(url)
        resp = httpx.get(url, follow_redirects=False, timeout=timeout, headers=headers, params=params)
        location = resp.headers.get("location")
        if resp.status_code not in _REDIRECTS or not location:
            return resp
        url = urljoin(str(resp.url) or url, location)
        params = None  # the redirect target carries its own query
    raise UnsafeURL("Too many redirects.")

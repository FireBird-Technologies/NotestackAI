"""Firecrawl: renders JavaScript sites, so posts on sites without a feed (Next.js, Framer, Webflow) still come in."""

import httpx

from app.config import settings


class FirecrawlError(RuntimeError):
    pass


def enabled() -> bool:
    return bool(settings.firecrawl_api_key)


def _post(path: str, body: dict, timeout: float = 90) -> dict:
    resp = httpx.post(
        f"{settings.firecrawl_url.rstrip('/')}{path}",
        json=body,
        headers={"Authorization": f"Bearer {settings.firecrawl_api_key}"},
        timeout=timeout,
    )
    if resp.status_code >= 400:
        raise FirecrawlError(f"Firecrawl returned {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    if data.get("success") is False:
        raise FirecrawlError(str(data.get("error") or "Firecrawl request failed")[:200])
    return data


def map_site(url: str, limit: int) -> list[str]:
    """Every URL Firecrawl can find on the site (sitemap plus links on rendered pages)."""
    data = _post("/v2/map", {"url": url, "limit": limit, "sitemap": "include"})
    return [link if isinstance(link, str) else link.get("url", "") for link in data.get("links") or []]


def scrape(url: str) -> dict:
    """Main content of one page as markdown, plus page metadata."""
    data = _post("/v2/scrape", {"url": url, "formats": ["markdown"], "onlyMainContent": True})
    return data.get("data") or {}

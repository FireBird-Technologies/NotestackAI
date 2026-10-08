"""Ingestion: feed -> raw HTML to storage -> clean markdown files in the workspace corpus -> INDEX.md.

Three ways in, one pipeline out:
- feeds (Substack, Ghost, Medium, any RSS/Atom), with Substack's archive API for posts past the feed
- sites with no feed, crawled through their sitemap and links (Firecrawl renders JavaScript sites)
- one article by URL
- an uploaded file (markdown, text, HTML or PDF)
All of them end in `store_entries`, which writes documents, raw HTML and corpus files.
"""

import hashlib
import io
import logging
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from time import mktime
from urllib.parse import urljoin, urlparse

import feedparser
import httpx
from bs4 import BeautifulSoup
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.corpus import INDEX, Corpus, index_line, post_path, render_post, slugify
from app.models import Document, Job, Source
from app.services import firecrawl
from app.services.jobs import update_job
from app.services.storage import keys, storage

log = logging.getLogger(__name__)

_DROP = re.compile(r"(subscribe|share this post|leave a comment|thanks for reading)", re.I)
UA = {"User-Agent": "Mozilla/5.0 (compatible; NotestackBot/0.2; +https://notestack.ai)"}
IMPORTS_FEED = "notestack:imports"
SITE_PREFIX = "site:"  # feed_url of a source crawled as a website instead of read from a feed


class FeedNotFound(ValueError):
    pass


# Feed discovery


def _with_scheme(url: str) -> str:
    url = url.strip()
    return url if url.startswith(("http://", "https://")) else f"https://{url}"


def normalize_feed_url(url: str) -> tuple[str, str]:
    """Best guess without network: accept 'name.substack.com', a post URL, or any feed URL."""
    url = _with_scheme(url)
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    if host.endswith("substack.com") or "/p/" in parsed.path:
        return f"{parsed.scheme}://{host}/feed", "substack"
    if parsed.path.rstrip("/").endswith(("/feed", "/rss", ".xml", "/atom")):
        return url, "rss"
    if host.endswith("medium.com"):
        return f"https://medium.com/feed{parsed.path.rstrip('/')}", "medium"
    return f"{parsed.scheme}://{host}/feed", "rss"


def _parse_feed(url: str, timeout: float = 15) -> tuple[feedparser.FeedParserDict | None, httpx.Response | None]:
    try:
        resp = httpx.get(url, follow_redirects=True, timeout=timeout, headers=UA)
    except httpx.HTTPError:
        return None, None
    if resp.status_code >= 400:
        return None, resp
    parsed = feedparser.parse(resp.content)
    if parsed.get("version") and (parsed.entries or parsed.feed.get("title")):
        return parsed, resp
    return None, resp


@dataclass
class DiscoveredFeed:
    feed_url: str
    platform: str
    title: str | None
    site_url: str


_FEED_SUFFIX = re.compile(r"/(feed|rss|atom)(\.xml)?/?$|/[^/]+\.xml$", re.I)


def _as_site(url: str, title: str | None, site: str) -> DiscoveredFeed:
    start = _FEED_SUFFIX.sub("", url).rstrip("/") or site
    return DiscoveredFeed(f"{SITE_PREFIX}{start}", "website", title, site)


def discover_feed(url: str) -> DiscoveredFeed:
    """Pick how to read whatever the writer pasted, or raise FeedNotFound with a clear reason.

    Substack keeps its feed plus archive API (complete and free). With Firecrawl configured, every
    other site is crawled with it, since feeds often carry only excerpts or the latest few posts.
    """
    found = _discover_feed(url)
    if firecrawl.enabled() and found.platform not in ("substack", "website"):
        return _as_site(_with_scheme(url), found.title, found.site_url)
    return found


def _discover_feed(url: str) -> DiscoveredFeed:
    url = _with_scheme(url)
    guess, platform = normalize_feed_url(url)
    parsed_url = urlparse(url)
    site = f"{parsed_url.scheme}://{parsed_url.netloc}"
    candidates = [guess, url, f"{site}/feed", f"{site}/rss", f"{site}/rss.xml", f"{site}/feed.xml", f"{site}/atom.xml"]
    seen: set[str] = set()
    last: httpx.Response | None = None
    page: httpx.Response | None = None  # the pasted address, when it is a working web page
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        parsed, resp = _parse_feed(candidate)
        last = resp or last
        if candidate == url and resp is not None and resp.status_code < 400:
            page = resp
        if parsed:
            return DiscoveredFeed(candidate, _platform(candidate, parsed, platform), parsed.feed.get("title"), site)
        if resp is not None and resp.status_code < 400 and "html" in resp.headers.get("content-type", ""):
            # A web page: look for <link rel="alternate" type="application/rss+xml">.
            soup = BeautifulSoup(resp.text, "html.parser")
            for link in soup.find_all("link", rel="alternate"):
                if "rss" in (link.get("type") or "") or "atom" in (link.get("type") or ""):
                    href = urljoin(str(resp.url), link.get("href", ""))
                    if href and href not in seen:
                        seen.add(href)
                        found, _ = _parse_feed(href)
                        if found:
                            return DiscoveredFeed(href, _platform(href, found, platform), found.feed.get("title"), site)
    if page is not None and "html" in page.headers.get("content-type", ""):
        # No feed, but the site is up: crawl it as a website instead.
        soup = BeautifulSoup(page.text, "html.parser")
        title = _meta(soup, "og:site_name", "og:title") or (soup.title.get_text(strip=True) if soup.title else None)
        return _as_site(url, title, site)
    if last is not None and last.status_code == 404:
        raise FeedNotFound(f"{parsed_url.netloc} returned 404. Check the address in your browser.")
    raise FeedNotFound("We couldn't find a feed at that address.")


def _platform(feed_url: str, parsed, guess: str) -> str:
    generator = (parsed.feed.get("generator") or "").lower()
    if "substack" in feed_url or "substack" in generator:
        return "substack"
    if "ghost" in generator:
        return "ghost"
    if "medium.com" in feed_url:
        return "medium"
    if "wordpress" in generator:
        return "wordpress"
    return guess if guess != "rss" else "rss"


# Text extraction


def html_to_sections(html: str) -> list[tuple[str | None, str]]:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "form", "button", "iframe", "noscript", "svg"]):
        tag.decompose()
    sections: list[tuple[str | None, list[str]]] = [(None, [])]
    for el in soup.find_all(["h1", "h2", "h3", "p", "li", "blockquote", "pre", "img"]):
        if el.name == "img":
            # Keep images as Markdown so answers can show them (web images only, no tracking pixels).
            src = (el.get("src") or el.get("data-src") or "").strip()
            width = str(el.get("width") or "")
            if src.startswith(("http://", "https://")) and not (width.isdigit() and int(width) < 50):
                alt = re.sub(r"[\[\]\n]", " ", el.get("alt") or "").strip()
                sections[-1][1].append(f"![{alt}]({src})")
            continue
        if el.name == "pre":
            # Code keeps its line breaks, as a fenced block.
            code = el.get_text().strip("\n")
            if code.strip():
                lang = next((c.split("-", 1)[1] for c in (el.find("code") or el).get("class") or []
                             if c.startswith(("language-", "lang-"))), "")
                sections[-1][1].append(f"```{lang}\n{code}\n```")
            continue
        if el.find_parent("pre"):
            continue
        text = el.get_text(" ", strip=True)
        if not text or (len(text) < 120 and _DROP.search(text)):
            continue
        if el.name in {"h1", "h2", "h3"}:
            sections.append((text, []))
        else:
            sections[-1][1].append(text)
    return [(h, "\n\n".join(p)) for h, p in sections if p]


_MD_IMAGE_LINE = re.compile(r"^!\[[^\]]*\]\(https?://[^)\s]+[^)]*\)$")


def markdown_to_sections(text: str) -> list[tuple[str | None, str]]:
    sections: list[tuple[str | None, list[str]]] = [(None, [])]
    para: list[str] = []

    def flush() -> None:
        if para:
            sections[-1][1].append(" ".join(para).strip())
            para.clear()

    fence: list[str] | None = None  # lines of an open ``` block, kept verbatim
    for line in text.splitlines():
        stripped = line.strip()
        if fence is not None:
            fence.append(line)
            if stripped.startswith("```"):
                sections[-1][1].append("\n".join(fence))
                fence = None
            continue
        if stripped.startswith("```"):
            flush()
            fence = [stripped]
            continue
        heading = re.match(r"^#{1,3}\s+(.*)", stripped)
        if _MD_IMAGE_LINE.match(stripped):
            flush()
            sections[-1][1].append(stripped)  # images stay on their own line
        elif heading:
            flush()
            sections.append((heading.group(1).strip(), []))
        elif not stripped:
            flush()
        else:
            para.append(stripped)
    if fence is not None:  # unclosed fence: close it so the block still renders
        sections[-1][1].append("\n".join([*fence, "```"]))
    flush()
    return [(h, "\n\n".join(p)) for h, p in sections if p]


def pdf_to_sections(data: bytes) -> list[tuple[str | None, str]]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    text = "\n\n".join((page.extract_text() or "") for page in reader.pages)
    # PDF text keeps hard line breaks inside paragraphs; blank lines separate paragraphs.
    paragraphs = [re.sub(r"\s*\n\s*", " ", p).strip() for p in re.split(r"\n\s*\n", text)]
    return [(None, "\n\n".join(p for p in paragraphs if p))] if any(paragraphs) else []


def _meta(soup: BeautifulSoup, *names: str) -> str | None:
    for name in names:
        tag = soup.find("meta", attrs={"property": name}) or soup.find("meta", attrs={"name": name})
        if tag and tag.get("content"):
            return tag["content"].strip()
    return None


def _parse_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
    except ValueError:
        return None


@dataclass
class FeedEntry:
    title: str
    url: str
    published_at: datetime | None
    html: str
    sections: list[tuple[str | None, str]] | None = None  # set when the source is not HTML


_MD_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)\s]*)[^)]*\)")
_MD_LINK = re.compile(r"(?<!!)\[([^\]]*)\]\([^)]*\)")


def _clean_markdown(md: str) -> str:
    """Firecrawl markdown to prose: keep link text, keep web images on their own line (drop data: URIs
    and relative paths, which would not load outside the site)."""

    def image(m: re.Match) -> str:
        alt, src = m.group(1).replace("\n", " ").strip(), m.group(2)
        return f"\n\n![{alt}]({src})\n\n" if src.startswith(("http://", "https://")) else ""

    return _MD_LINK.sub(r"\1", _MD_IMAGE.sub(image, md))


def _firecrawl_entry(url: str) -> FeedEntry:
    data = firecrawl.scrape(url)
    meta = data.get("metadata") or {}
    text = _clean_markdown(data.get("markdown") or "")
    heading = re.search(r"^#\s+(.+)$", text, re.M)
    title = meta.get("ogTitle") or meta.get("title") or (heading.group(1).strip() if heading else url)
    if isinstance(title, list):
        title = title[0]
    sections = markdown_to_sections(text)
    if sections and sections[0][0] and heading and sections[0][0] == heading.group(1).strip():
        sections[0] = (None, sections[0][1])
    if not sections or sum(len(t) for _, t in sections) < 200:
        raise FeedNotFound("We could not find article text on that page.")
    published = None
    for key in ("publishedTime", "article:published_time", "datePublished", "og:published_time", "modifiedTime"):
        value = meta.get(key)
        if published := _parse_date(value[0] if isinstance(value, list) else value):
            break
    final = meta.get("sourceURL") or meta.get("url") or url
    return FeedEntry(title=str(title)[:1000], url=final, published_at=published, html="", sections=sections)


def extract_article(url: str) -> FeedEntry:
    """Fetch one web page and keep the article body. Firecrawl first when configured (it renders JS)."""
    url = _with_scheme(url)
    if firecrawl.enabled():
        try:
            return _firecrawl_entry(url)
        except (firecrawl.FirecrawlError, httpx.HTTPError, FeedNotFound):
            log.warning("firecrawl scrape failed for %s, falling back to plain HTTP", url, exc_info=True)
    resp = httpx.get(url, follow_redirects=True, timeout=30, headers=UA)
    if resp.status_code >= 400:
        raise FeedNotFound(f"That page returned {resp.status_code}.")
    soup = BeautifulSoup(resp.text, "html.parser")
    title = _meta(soup, "og:title", "twitter:title") or (soup.title.get_text(strip=True) if soup.title else url)
    published = _parse_date(_meta(soup, "article:published_time", "og:published_time", "date"))
    if not published and (t := soup.find("time", datetime=True)):
        published = _parse_date(t["datetime"])
    body = soup.find("article") or soup.find("main") or soup.find(class_=re.compile("post-content|entry-content|body"))
    if body is None:
        # Fall back to the element holding the most paragraph text.
        candidates = soup.find_all(["div", "section"])
        body = max(candidates, key=lambda el: sum(len(p.get_text()) for p in el.find_all("p", recursive=False)),
                   default=soup.body or soup)
    html = str(body)
    if not html_to_sections(html):
        raise FeedNotFound("We could not find article text on that page.")
    return FeedEntry(title=title[:1000], url=str(resp.url), published_at=published, html=html)


# Feed fetching


def fetch_feed(feed_url: str, limit: int) -> tuple[str | None, list[FeedEntry]]:
    resp = httpx.get(feed_url, follow_redirects=True, timeout=30, headers=UA)
    resp.raise_for_status()
    parsed = feedparser.parse(resp.content)
    entries = []
    for e in parsed.entries[:limit]:
        content = (e.get("content") or [{}])[0].get("value") or e.get("summary") or ""
        published = e.get("published_parsed") or e.get("updated_parsed")
        entries.append(
            FeedEntry(
                title=e.get("title") or "Untitled",
                url=e.get("link") or "",
                published_at=datetime.fromtimestamp(mktime(published), UTC) if published else None,
                html=content,
            )
        )
    return parsed.feed.get("title"), entries


_NOT_POSTS = re.compile(
    r"/(tag|tags|category|categories|author|authors|page|search|login|signin|signup|register|account|cart|"
    r"privacy|terms|legal|cookies?|about|contact|pricing|careers|jobs|feed|rss|wp-admin|wp-json|cdn-cgi|_next)(/|$)",
    re.I,
)


def _post_urls(links: list[str], start: str, limit: int) -> list[str]:
    """Likely article pages among a site's links: same site, not the index itself, not utility pages."""
    base = urlparse(start)
    host = base.netloc.lower().removeprefix("www.")
    prefix = base.path.rstrip("/")
    out: list[str] = []
    seen: set[str] = set()
    for link in links:
        p = urlparse(link)
        path = p.path.rstrip("/")
        if p.scheme not in ("http", "https") or p.netloc.lower().removeprefix("www.") != host:
            continue
        if not path or path == prefix or _NOT_POSTS.search(path + "/"):
            continue
        if re.search(r"\.(?!html?$)[a-z0-9]{2,5}$", path, re.I):  # files: images, pdf, xml
            continue
        clean = f"{p.scheme}://{p.netloc}{path}"
        if clean not in seen:
            seen.add(clean)
            out.append(clean)
    # Pasted a blog index like /blog: keep what lives under it when anything does.
    if prefix:
        under = [u for u in out if urlparse(u).path.startswith(prefix + "/")]
        out = under or out
    return out[:limit]


def _plain_links(url: str) -> list[str]:
    """Without Firecrawl: the sitemap plus links in the page HTML (misses posts rendered by JavaScript)."""
    parsed = urlparse(url)
    links: list[str] = []
    for sitemap in (f"{parsed.scheme}://{parsed.netloc}/sitemap.xml", f"{parsed.scheme}://{parsed.netloc}/sitemap_index.xml"):
        try:
            resp = httpx.get(sitemap, follow_redirects=True, timeout=20, headers=UA)
        except httpx.HTTPError:
            continue
        if resp.status_code < 400:
            links += re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", resp.text)
    try:
        resp = httpx.get(url, follow_redirects=True, timeout=20, headers=UA)
        if resp.status_code < 400:
            soup = BeautifulSoup(resp.text, "html.parser")
            links += [urljoin(str(resp.url), a["href"]) for a in soup.find_all("a", href=True)]
    except httpx.HTTPError:
        pass
    return links


def _title_from_url(u: str) -> str:
    slug = urlparse(u).path.rstrip("/").rsplit("/", 1)[-1]
    slug = re.sub(r"\.[a-z0-9]+$", "", slug)
    return slug.replace("-", " ").replace("_", " ").strip().capitalize() or urlparse(u).netloc


def crawl_site(url: str, limit: int, on_found=None, on_post=None, read_limit: int | None = None) -> list[FeedEntry]:
    """Find the posts on a site with no feed and read each one. Past read_limit, pages are only listed (title from the
    URL, no html): they show the writer what the rest of their archive holds without paying to read it."""
    if firecrawl.enabled():
        links = firecrawl.map_site(url, max(limit * 4, 100))
    else:
        links = _plain_links(url)
    urls = _post_urls(links, url, limit)
    if not urls:
        hint = "" if firecrawl.enabled() else " If the site builds its pages with JavaScript, set FIRECRAWL_API_KEY."
        raise FeedNotFound(f"We could not find any posts on {urlparse(url).netloc}.{hint}")
    if on_found:
        on_found(len(urls))

    def read(u: str) -> FeedEntry | None:
        try:
            return extract_article(u)
        except (FeedNotFound, httpx.HTTPError, firecrawl.FirecrawlError):
            return None

    to_read = urls if read_limit is None else urls[:read_limit]
    entries: list[FeedEntry] = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for i, entry in enumerate(pool.map(read, to_read)):
            if entry:
                entries.append(entry)
            if on_post:
                on_post(i + 1, len(to_read))
    entries += [FeedEntry(title=_title_from_url(u), url=u, published_at=None, html="") for u in urls[len(to_read):]]
    if not entries:
        raise FeedNotFound(f"We found {len(urls)} pages on {urlparse(url).netloc} but none had article text.")
    return entries


def fetch_substack_archive(site: str, known_urls: set[str], limit: int, on_page=None,
                           body_budget: int | None = None) -> list[FeedEntry]:
    """Posts beyond the ~20 the RSS feed carries, through Substack's public archive API. Only the first body_budget
    posts get their body fetched; the rest are listed from the archive metadata alone (title, date, link)."""
    out: list[FeedEntry] = []
    offset = 0
    with httpx.Client(follow_redirects=True, timeout=30, headers=UA) as client:
        while len(out) + len(known_urls) < limit:
            resp = client.get(f"{site}/api/v1/archive", params={"sort": "new", "offset": offset, "limit": 50})
            if resp.status_code >= 400:
                break
            page = resp.json()
            if not page:
                break
            offset += len(page)
            for item in page:
                url = item.get("canonical_url") or f"{site}/p/{item.get('slug')}"
                if url in known_urls or item.get("type") not in (None, "newsletter", "thread"):
                    continue
                if len(out) + len(known_urls) >= limit:
                    break
                if body_budget is not None and len(out) >= body_budget:
                    out.append(FeedEntry(title=item.get("title") or "Untitled", url=url,
                                         published_at=_parse_date(item.get("post_date")), html=""))
                    continue
                post = client.get(f"{site}/api/v1/posts/{item['slug']}")
                if post.status_code >= 400:
                    continue
                body = post.json().get("body_html") or item.get("truncated_body_text") or ""
                if not body:
                    continue
                out.append(FeedEntry(title=item.get("title") or "Untitled", url=url,
                                     published_at=_parse_date(item.get("post_date")), html=body))
                time.sleep(0.2)  # be polite to Substack
            if on_page:
                on_page(len(out))
    return out


# Storing


def source_slug(source: Source) -> str:
    if source.feed_url == IMPORTS_FEED:
        return "imports"
    return slugify(urlparse(source.site_url or source.feed_url).netloc or str(source.id), 50)


def rebuild_index(db: Session, workspace_id: uuid.UUID) -> str:
    docs = db.scalars(
        select(Document).where(Document.workspace_id == workspace_id, Document.path.is_not(None))
    ).all()
    rows = sorted(
        (index_line(d.path, d.title, d.published_at, (d.metadata_json or {}).get("headings", [])) for d in docs),
        reverse=True,
    )
    header = "# Archive index\n\ndate | path | title | section headings\n\n"
    return header + "\n".join(rows) + "\n"


def imports_source(db: Session, workspace_id: uuid.UUID) -> Source:
    """Single articles and uploaded files live under one built in source that does not count to limits."""
    source = db.scalar(select(Source).where(Source.workspace_id == workspace_id, Source.feed_url == IMPORTS_FEED))
    if not source:
        source = Source(workspace_id=workspace_id, feed_url=IMPORTS_FEED, platform="imports",
                        title="Imported posts and files", sync_status="ok")
        db.add(source)
        db.flush()
    return source


def store_entries(
    db: Session, source: Source, entries: list[FeedEntry], progress=None
) -> tuple[int, int, list[uuid.UUID]]:
    """Write documents, raw HTML and corpus files. Returns (indexed, skipped, changed document ids)."""
    corpus = Corpus(source.workspace_id)
    folder = source_slug(source)
    indexed = skipped = 0
    changed: list[uuid.UUID] = []
    files: dict[str, str] = {}
    taken = set(db.scalars(select(Document.path).where(Document.workspace_id == source.workspace_id)).all())
    total = max(len(entries), 1)
    for i, entry in enumerate(entries):
        payload = entry.html or "\n\n".join(t for _, t in (entry.sections or []))
        content_hash = hashlib.sha256(payload.encode()).hexdigest()
        doc = db.scalar(select(Document).where(Document.source_id == source.id, Document.url == entry.url))
        if doc and doc.content_hash == content_hash and doc.path:
            skipped += 1
            continue
        sections = entry.sections if entry.sections is not None else html_to_sections(entry.html)
        if not sections:
            skipped += 1
            continue
        # Postgres text cannot hold NUL bytes, and some PDFs (icon glyphs) extract with them.
        sections = [(h and h.replace("\x00", ""), t.replace("\x00", "")) for h, t in sections]
        entry.title = entry.title.replace("\x00", "")
        if not doc:
            doc = Document(id=uuid.uuid4(), workspace_id=source.workspace_id, source_id=source.id, url=entry.url)
            db.add(doc)
        if not doc.path:
            path = post_path(folder, entry.title, entry.url, entry.published_at)
            n = 2
            while path in taken:
                path = path.removesuffix(".md").rsplit("--", 1)[0] + f"--{n}.md"
                n += 1
            doc.path = path
            taken.add(path)
        doc.title = entry.title
        doc.published_at = entry.published_at
        doc.content_hash = content_hash
        if entry.html:
            doc.raw_html_key = storage.put_text(
                keys.raw_html(source.workspace_id, source.id, doc.id), entry.html, "text/html; charset=utf-8"
            )
        doc.clean_text = "\n\n".join(f"## {h}\n{t}" if h else t for h, t in sections)
        doc.metadata_json = {
            **{k: v for k, v in (doc.metadata_json or {}).items() if k != "locked"},
            "headings": [h for h, _ in sections if h],
            "words": len(doc.clean_text.split()),
        }
        files[doc.path] = render_post(
            title=entry.title, url=entry.url, published_at=entry.published_at, source=folder, sections=sections
        )
        indexed += 1
        changed.append(doc.id)
        db.commit()
        if progress:
            progress(i + 1, total, entry.title)
    db.flush()
    files[INDEX] = rebuild_index(db, source.workspace_id)
    corpus.write_files(files)
    db.commit()
    return indexed, skipped, changed


# A sync discovers up to SCAN_CAP posts (or the plan's own limit, if higher) but only indexes the plan's
# indexed_posts. The rest are listed, not indexed: title, date and link only, no text and no corpus file. They exist
# to show the writer how much of their archive is waiting behind an upgrade. Upgrading re-syncs and indexes them.
SCAN_CAP = 200


def _newest_first(entries: list[FeedEntry]) -> list[FeedEntry]:
    """Dated posts newest first; undated ones (site crawls) keep their discovery order after them."""
    dated = sorted((e for e in entries if e.published_at), key=lambda e: e.published_at.timestamp(), reverse=True)
    return dated + [e for e in entries if not e.published_at]


def store_locked(db: Session, source: Source, entries: list[FeedEntry]) -> tuple[int, set[str]]:
    """List posts beyond the plan limit without indexing them: title, date and link only. Returns (count, corpus paths
    to remove): a post that was indexed before (a newer post pushed it out, or the plan went down) loses its file."""
    locked = 0
    remove: set[str] = set()
    for entry in entries:
        doc = db.scalar(select(Document).where(Document.source_id == source.id, Document.url == entry.url))
        if not doc:
            doc = Document(id=uuid.uuid4(), workspace_id=source.workspace_id, source_id=source.id, url=entry.url)
            db.add(doc)
        if doc.path:
            remove.add(doc.path)
            doc.path = None
        doc.title = entry.title
        doc.published_at = entry.published_at
        doc.content_hash = None  # indexed from scratch once the plan allows it
        doc.clean_text = ""
        doc.metadata_json = {"locked": True}
        locked += 1
    db.commit()
    return locked, remove


def ingest_source(db: Session, source: Source, job: Job, max_posts: int) -> dict:
    source.sync_status = "syncing"
    update_job(db, job, status="running", progress=0.02, message="Contacting your feed")
    fetch_limit = max(SCAN_CAP, max_posts)

    if source.feed_url.startswith(SITE_PREFIX):
        update_job(db, job, message="Mapping your site")
        entries = crawl_site(
            source.feed_url.removeprefix(SITE_PREFIX), fetch_limit,
            on_found=lambda n: update_job(db, job, progress=0.05, message=f"Found {n} pages, reading them"),
            on_post=lambda done, total: update_job(db, job, progress=0.05 + 0.05 * done / total,
                                                   message=f"Read {done} of {total} pages"),
            read_limit=max_posts,
        )
        title = None
    else:
        title, entries = fetch_feed(source.feed_url, fetch_limit)
    source.title = source.title or title
    if source.platform == "substack" and len(entries) < fetch_limit:
        site = f"{urlparse(source.feed_url).scheme}://{urlparse(source.feed_url).netloc}"
        update_job(db, job, progress=0.05, message="Reading your Substack archive")
        try:
            entries += fetch_substack_archive(
                site, {e.url for e in entries}, fetch_limit,
                on_page=lambda n: update_job(db, job, message=f"Found {len(entries) + n} posts in the archive"),
                body_budget=max(0, max_posts - len(entries)),
            )
        except (httpx.HTTPError, ValueError):
            log.warning("substack archive fetch failed for %s", site, exc_info=True)

    entries = _newest_first(entries)
    available, beyond = entries[:max_posts], entries[max_posts:]

    def progress(done: int, total: int, post_title: str) -> None:
        update_job(db, job, progress=0.1 + 0.7 * done / total, message=f"{post_title[:80]} is in orbit")

    update_job(db, job, progress=0.1, message=f"Indexing {len(available)} posts")
    indexed, skipped, changed = store_entries(db, source, available, progress)

    locked = 0
    if beyond:
        update_job(db, job, progress=0.85,
                   message=f"Found {len(beyond)} more posts. Your plan indexes the latest {max_posts}")
        locked, remove = store_locked(db, source, beyond)
        if remove:
            Corpus(source.workspace_id).write_files({INDEX: rebuild_index(db, source.workspace_id)}, remove=remove)

    source.sync_status = "ok"
    source.sync_error = None
    source.last_synced_at = datetime.now(UTC)
    db.commit()
    return {"indexed": indexed, "skipped": skipped, "found": len(entries), "limit": max_posts,
            "capped": locked > 0, "locked": locked, "available": len(available),
            "changed": [str(i) for i in changed]}


_VTT_TIME = re.compile(r"^(\d+:)?\d{1,2}:\d{2}[.,]\d{3}\s+-->\s+")


def vtt_to_text(text: str) -> str:
    """The spoken words of a WebVTT transcript: the header, notes, cue ids, timestamps and markup dropped, a line
    repeated from the cue before (rolling captions) kept once, the rest joined into paragraphs."""
    lines: list[str] = []
    in_cue = False
    skipping = False  # inside a NOTE / STYLE / REGION block, until the blank line
    for raw in text.lstrip("\ufeff").splitlines():
        line = raw.strip()
        if not line:
            in_cue = skipping = False
            continue
        if skipping or line.startswith(("WEBVTT", "NOTE", "STYLE", "REGION")) and not in_cue:
            skipping = True
            continue
        if _VTT_TIME.match(line):
            in_cue = True
            continue
        if not in_cue:
            continue  # a cue id
        line = re.sub(r"<[^>]+>", "", line).strip()
        if line and (not lines or lines[-1] != line):
            lines.append(line)
    return "\n\n".join(" ".join(lines[i:i + 8]) for i in range(0, len(lines), 8))


def entry_from_upload(filename: str, content_type: str, data: bytes) -> FeedEntry:
    name = filename.rsplit("/", 1)[-1]
    stem = re.sub(r"\.[A-Za-z0-9]+$", "", name).replace("-", " ").replace("_", " ").strip() or "Untitled"
    lower = name.lower()
    url = f"upload://{name}"
    if content_type == "application/pdf" or lower.endswith(".pdf"):
        return FeedEntry(title=stem, url=url, published_at=None, html="", sections=pdf_to_sections(data))
    text = data.decode("utf-8", errors="replace")
    if content_type == "text/html" or lower.endswith((".html", ".htm")):
        soup = BeautifulSoup(text, "html.parser")
        title = soup.title.get_text(strip=True) if soup.title else stem
        return FeedEntry(title=title, url=url, published_at=None, html=text)
    if lower.endswith(".vtt") or text.lstrip("\ufeff").startswith("WEBVTT"):
        text = vtt_to_text(text)
    sections = markdown_to_sections(text)
    first_heading = re.search(r"^#\s+(.+)$", text, re.M)
    title = first_heading.group(1).strip() if first_heading else stem
    if sections and sections[0][0] == title:
        sections[0] = (None, sections[0][1])
    return FeedEntry(title=title, url=url, published_at=None, html="", sections=sections)

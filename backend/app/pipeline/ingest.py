"""Ingestion: feed -> raw HTML to storage -> clean markdown files in the workspace corpus -> INDEX.md.

Three ways in, one pipeline out:
- feeds (Substack, Ghost, Medium, any RSS/Atom), with Substack's archive API for posts past the feed
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
from app.services.jobs import update_job
from app.services.storage import keys, storage

log = logging.getLogger(__name__)

_DROP = re.compile(r"(subscribe|share this post|leave a comment|thanks for reading)", re.I)
UA = {"User-Agent": "Mozilla/5.0 (compatible; NotestackBot/0.2; +https://notestack.ai)"}
IMPORTS_FEED = "notestack:imports"


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


def discover_feed(url: str) -> DiscoveredFeed:
    """Find a working feed for whatever the writer pasted, or raise FeedNotFound with a clear reason."""
    url = _with_scheme(url)
    guess, platform = normalize_feed_url(url)
    parsed_url = urlparse(url)
    site = f"{parsed_url.scheme}://{parsed_url.netloc}"
    candidates = [guess, url, f"{site}/feed", f"{site}/rss", f"{site}/rss.xml", f"{site}/feed.xml", f"{site}/atom.xml"]
    seen: set[str] = set()
    last: httpx.Response | None = None
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        parsed, resp = _parse_feed(candidate)
        last = resp or last
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
    for el in soup.find_all(["h1", "h2", "h3", "p", "li", "blockquote", "pre"]):
        text = el.get_text(" ", strip=True)
        if not text or (len(text) < 120 and _DROP.search(text)):
            continue
        if el.name in {"h1", "h2", "h3"}:
            sections.append((text, []))
        else:
            sections[-1][1].append(text)
    return [(h, "\n\n".join(p)) for h, p in sections if p]


def markdown_to_sections(text: str) -> list[tuple[str | None, str]]:
    sections: list[tuple[str | None, list[str]]] = [(None, [])]
    para: list[str] = []

    def flush() -> None:
        if para:
            sections[-1][1].append(" ".join(para).strip())
            para.clear()

    for line in text.splitlines():
        stripped = line.strip()
        heading = re.match(r"^#{1,3}\s+(.*)", stripped)
        if heading:
            flush()
            sections.append((heading.group(1).strip(), []))
        elif not stripped:
            flush()
        else:
            para.append(stripped)
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


def extract_article(url: str) -> FeedEntry:
    """Fetch one web page and keep the article body."""
    url = _with_scheme(url)
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


def fetch_substack_archive(site: str, known_urls: set[str], limit: int, on_page=None) -> list[FeedEntry]:
    """Posts beyond the ~20 the RSS feed carries, through Substack's public archive API."""
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
            **(doc.metadata_json or {}),
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


def ingest_source(db: Session, source: Source, job: Job, max_posts: int) -> dict:
    source.sync_status = "syncing"
    update_job(db, job, status="running", progress=0.02, message="Contacting your feed")

    title, entries = fetch_feed(source.feed_url, max_posts)
    source.title = source.title or title
    if source.platform == "substack" and len(entries) < max_posts:
        site = f"{urlparse(source.feed_url).scheme}://{urlparse(source.feed_url).netloc}"
        update_job(db, job, progress=0.05, message="Reading your Substack archive")
        try:
            entries += fetch_substack_archive(
                site, {e.url for e in entries}, max_posts,
                on_page=lambda n: update_job(db, job, message=f"Found {len(entries) + n} posts in the archive"),
            )
        except (httpx.HTTPError, ValueError):
            log.warning("substack archive fetch failed for %s", site, exc_info=True)

    def progress(done: int, total: int, post_title: str) -> None:
        update_job(db, job, progress=0.1 + 0.8 * done / total, message=f"{post_title[:80]} is in orbit")

    update_job(db, job, progress=0.1, message=f"Indexing {len(entries)} posts")
    indexed, skipped, changed = store_entries(db, source, entries, progress)

    source.sync_status = "ok"
    source.sync_error = None
    source.last_synced_at = datetime.now(UTC)
    db.commit()
    return {"indexed": indexed, "skipped": skipped, "found": len(entries), "changed": [str(i) for i in changed]}


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
    sections = markdown_to_sections(text)
    first_heading = re.search(r"^#\s+(.+)$", text, re.M)
    title = first_heading.group(1).strip() if first_heading else stem
    if sections and sections[0][0] == title:
        sections[0] = (None, sections[0][1])
    return FeedEntry(title=title, url=url, published_at=None, html="", sections=sections)

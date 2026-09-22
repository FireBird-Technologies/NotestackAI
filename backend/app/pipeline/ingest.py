"""Ingestion: feed -> raw HTML to R2 -> clean markdown files in the workspace corpus -> INDEX.md."""

import hashlib
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from time import mktime
from urllib.parse import urlparse

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


def normalize_feed_url(url: str) -> tuple[str, str]:
    """Accept 'name.substack.com', a Substack post URL, or any feed URL. Returns (feed_url, platform)."""
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    if host.endswith("substack.com") or "/p/" in parsed.path:
        return f"{parsed.scheme}://{host}/feed", "substack"
    if parsed.path.rstrip("/").endswith(("/feed", "/rss", ".xml", "/atom")):
        return url, "rss"
    if host.endswith("medium.com"):
        return f"https://medium.com/feed{parsed.path.rstrip('/')}", "medium"
    return f"{parsed.scheme}://{host}/feed", "rss"


def html_to_sections(html: str) -> list[tuple[str | None, str]]:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "form", "button", "iframe"]):
        tag.decompose()
    sections: list[tuple[str | None, list[str]]] = [(None, [])]
    for el in soup.find_all(["h1", "h2", "h3", "p", "li", "blockquote"]):
        text = el.get_text(" ", strip=True)
        if not text or (len(text) < 120 and _DROP.search(text)):
            continue
        if el.name in {"h1", "h2", "h3"}:
            sections.append((text, []))
        else:
            sections[-1][1].append(text)
    return [(h, "\n\n".join(p)) for h, p in sections if p]


@dataclass
class FeedEntry:
    title: str
    url: str
    published_at: datetime | None
    html: str


def fetch_feed(feed_url: str, limit: int) -> tuple[str | None, list[FeedEntry]]:
    resp = httpx.get(feed_url, follow_redirects=True, timeout=30, headers={"User-Agent": "NotestackBot/0.1"})
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


def source_slug(source: Source) -> str:
    return slugify(urlparse(source.site_url or source.feed_url).netloc or str(source.id), 50)


def rebuild_index(db: Session, workspace_id: uuid.UUID) -> str:
    docs = db.scalars(
        select(Document).where(Document.workspace_id == workspace_id, Document.path.is_not(None))
    ).all()
    rows = sorted(
        (index_line(d.path, d.title, d.published_at, d.metadata_json.get("headings", [])) for d in docs),
        reverse=True,
    )
    header = "# Archive index\n\ndate | path | title | section headings\n\n"
    return header + "\n".join(rows) + "\n"


def ingest_source(db: Session, source: Source, job: Job, max_posts: int) -> dict:
    source.sync_status = "syncing"
    update_job(db, job, status="running", progress=0.02, message="Contacting your feed")

    title, entries = fetch_feed(source.feed_url, max_posts)
    source.title = source.title or title
    corpus = Corpus(source.workspace_id)
    folder = source_slug(source)
    total = max(len(entries), 1)
    indexed = skipped = 0
    files: dict[str, str] = {}

    taken = set(
        db.scalars(select(Document.path).where(Document.workspace_id == source.workspace_id)).all()
    )
    for i, entry in enumerate(entries):
        content_hash = hashlib.sha256(entry.html.encode()).hexdigest()
        doc = db.scalar(select(Document).where(Document.source_id == source.id, Document.url == entry.url))
        if doc and doc.content_hash == content_hash and doc.path:
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
        doc.raw_html_key = storage.put_text(
            keys.raw_html(source.workspace_id, source.id, doc.id), entry.html, "text/html; charset=utf-8"
        )
        sections = html_to_sections(entry.html)
        doc.clean_text = "\n\n".join(f"## {h}\n{t}" if h else t for h, t in sections)
        doc.metadata_json = {**(doc.metadata_json or {}), "headings": [h for h, _ in sections if h]}
        files[doc.path] = render_post(
            title=entry.title, url=entry.url, published_at=entry.published_at, source=folder, sections=sections
        )
        indexed += 1
        db.commit()
        update_job(db, job, progress=0.05 + 0.85 * (i + 1) / total, message=f"{entry.title[:80]} is in orbit")

    update_job(db, job, progress=0.93, message="Writing your archive index")
    files[INDEX] = rebuild_index(db, source.workspace_id)
    corpus.write_files(files)

    source.sync_status = "ok"
    source.sync_error = None
    source.last_synced_at = datetime.now(UTC)
    db.commit()
    return {"indexed": indexed, "skipped": skipped, "found": len(entries)}

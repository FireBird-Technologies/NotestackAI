"""Ingestion: feed -> documents (raw HTML to R2) -> clean text -> chunks -> embeddings."""

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
import tiktoken
from bs4 import BeautifulSoup
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.llm.embeddings import embed_texts, embedding_provider
from app.models import Chunk, Document, Job, Source
from app.services.jobs import record_usage, update_job
from app.services.storage import keys, storage

log = logging.getLogger(__name__)

CHUNK_TOKENS = 350
CHUNK_OVERLAP = 60
_enc = tiktoken.get_encoding("cl100k_base")
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


def chunk_sections(sections: list[tuple[str | None, str]]) -> list[tuple[str | None, str, int]]:
    out: list[tuple[str | None, str, int]] = []
    for heading, text in sections:
        tokens = _enc.encode(text)
        start = 0
        while start < len(tokens):
            window = tokens[start : start + CHUNK_TOKENS]
            out.append((heading, _enc.decode(window), len(window)))
            if start + CHUNK_TOKENS >= len(tokens):
                break
            start += CHUNK_TOKENS - CHUNK_OVERLAP
    return out


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


def ingest_source(db: Session, source: Source, job: Job, max_posts: int) -> dict:
    source.sync_status = "syncing"
    update_job(db, job, status="running", progress=0.02, message="Contacting your feed")

    title, entries = fetch_feed(source.feed_url, max_posts)
    source.title = source.title or title
    total = max(len(entries), 1)
    indexed = skipped = 0
    embed_tokens = 0

    for i, entry in enumerate(entries):
        content_hash = hashlib.sha256(entry.html.encode()).hexdigest()
        doc = db.scalar(select(Document).where(Document.source_id == source.id, Document.url == entry.url))
        if doc and doc.content_hash == content_hash:
            skipped += 1
            continue
        if not doc:
            doc = Document(id=uuid.uuid4(), workspace_id=source.workspace_id, source_id=source.id, url=entry.url)
            db.add(doc)
        doc.title = entry.title
        doc.published_at = entry.published_at
        doc.content_hash = content_hash
        doc.raw_html_key = storage.put_text(
            keys.raw_html(source.workspace_id, source.id, doc.id), entry.html, "text/html; charset=utf-8"
        )
        sections = html_to_sections(entry.html)
        doc.clean_text = "\n\n".join(f"## {h}\n{t}" if h else t for h, t in sections)
        doc.chunks.clear()
        pieces = chunk_sections(sections)
        if pieces:
            result = embed_texts([f"{entry.title}\n{h or ''}\n{t}" for h, t, _ in pieces])
            embed_tokens += result.tokens
            for pos, ((heading, text, n_tokens), vec) in enumerate(zip(pieces, result.vectors, strict=True)):
                doc.chunks.append(
                    Chunk(
                        workspace_id=source.workspace_id,
                        position=pos,
                        heading=heading,
                        text=text,
                        token_count=n_tokens,
                        embedding=vec,
                    )
                )
        indexed += 1
        db.commit()
        update_job(db, job, progress=0.05 + 0.9 * (i + 1) / total, message=f"{entry.title[:80]} is in orbit")

    if embed_tokens:
        record_usage(
            db,
            workspace_id=source.workspace_id,
            kind="embedding",
            provider=embedding_provider(),
            model=settings.embedding_model,
            quantity=embed_tokens,
            unit="tokens",
            job=job,
        )
    source.sync_status = "ok"
    source.sync_error = None
    source.last_synced_at = datetime.now(UTC)
    db.commit()
    return {"indexed": indexed, "skipped": skipped, "found": len(entries)}

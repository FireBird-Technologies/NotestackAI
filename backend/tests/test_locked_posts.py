"""Posts past the plan's indexed_posts are listed, not indexed: no text, no corpus file, indexed on a bigger plan."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.models import Document, Job, Source, Workspace
from app.pipeline import ingest
from app.pipeline.ingest import FeedEntry, ingest_source
from app.routers.sources import is_locked


def _entries(n: int) -> list[FeedEntry]:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    # Oldest first on purpose: ingest must pick the newest posts regardless of feed order.
    return [
        FeedEntry(title=f"Post {i}", url=f"https://ada.example/p/{i}", published_at=start + timedelta(days=i),
                  html=f"<h2>Point {i}</h2><p>Paragraph for post number {i} with enough words to keep.</p>")
        for i in range(n)
    ]


def _setup(db, monkeypatch, n: int):
    monkeypatch.setattr(ingest, "fetch_feed", lambda url, limit: ("Ada", _entries(n)[:limit]))
    ws = Workspace(name="w", owner_id=uuid.uuid4())
    db.add(ws)
    db.flush()
    source = Source(workspace_id=ws.id, feed_url="https://ada.example/feed", platform="rss", title="Ada")
    db.add(source)
    db.flush()
    job = Job(workspace_id=ws.id, kind="ingest", params={"source_id": str(source.id)})
    db.add(job)
    db.commit()
    return ws, source, job


def _docs(db, source):
    return {d.title: d for d in db.scalars(select(Document).where(Document.source_id == source.id))}


def test_lists_every_post_but_indexes_only_the_latest(db_session, monkeypatch):
    ws, source, job = _setup(db_session, monkeypatch, 12)
    result = ingest_source(db_session, source, job, max_posts=5)

    assert result["found"] == 12 and result["available"] == 5 and result["locked"] == 7 and result["capped"]
    docs = _docs(db_session, source)
    assert len(docs) == 12
    available = {t for t, d in docs.items() if d.path}
    assert available == {f"Post {i}" for i in range(7, 12)}  # the five newest
    locked = [d for d in docs.values() if not d.path]
    assert len(locked) == 7
    assert all(is_locked(d) and d.clean_text == "" and d.title for d in locked)


def test_upgrade_unlocks_and_newer_posts_relock_the_oldest(db_session, monkeypatch):
    ws, source, job = _setup(db_session, monkeypatch, 12)
    ingest_source(db_session, source, job, max_posts=5)

    ingest_source(db_session, source, job, max_posts=500)
    docs = _docs(db_session, source)
    assert all(d.path for d in docs.values())
    assert not any(is_locked(d) for d in docs.values())

    ingest_source(db_session, source, job, max_posts=5)
    docs = _docs(db_session, source)
    assert sum(1 for d in docs.values() if d.path) == 5
    assert docs["Post 0"].path is None and is_locked(docs["Post 0"])


def test_scan_is_capped_per_sync(db_session, monkeypatch):
    ws, source, job = _setup(db_session, monkeypatch, ingest.SCAN_CAP + 50)
    result = ingest_source(db_session, source, job, max_posts=5)
    assert result["found"] == ingest.SCAN_CAP


def test_crawl_reads_only_the_pages_it_will_index(monkeypatch):
    read = []
    urls = [f"https://ada.example/posts/post-{i}" for i in range(20)]
    monkeypatch.setattr(ingest, "_plain_links", lambda url: urls)
    monkeypatch.setattr(ingest, "_post_urls", lambda links, url, limit: links[:limit])

    def fake_extract(u):
        read.append(u)
        return FeedEntry(title=u, url=u, published_at=None, html="<p>body text for the page</p>")

    monkeypatch.setattr(ingest, "extract_article", fake_extract)
    entries = ingest.crawl_site("https://ada.example", 200, read_limit=5)
    assert len(read) == 5 and len(entries) == 20
    assert all(e.html == "" for e in entries[5:])
    assert entries[5].title == "Post 5"

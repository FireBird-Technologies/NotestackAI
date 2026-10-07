"""End to end coverage for sources, notebooks, generation, Launchpad and settings. External services
(feeds, LLM, ElevenLabs, renderer, social APIs) are stubbed at their module seams."""

import time
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.models import (
    Artifact,
    CalendarItem,
    Document,
    EngagementEvent,
    Job,
    SocialAccount,
    Source,
    TrackedLink,
    UsageEvent,
    UserSavedVoice,
    Workspace,
)
from app.services.email import ConsoleEmailProvider
from tests.conftest import last_code

FEED = """<?xml version="1.0"?>
<rss version="2.0"><channel><title>Ada Writes</title><link>https://ada.example.com</link>
<item><title>On Pricing</title><link>https://ada.example.com/p/on-pricing</link>
<pubDate>Mon, 03 Mar 2025 10:00:00 GMT</pubDate>
<description><![CDATA[<h2>Why price high</h2><p>Charging more made my readers take the work seriously.</p>
<p>The paid tier doubled after I raised the price to ten dollars.</p>]]></description></item>
<item><title>Writing Every Day</title><link>https://ada.example.com/p/writing-every-day</link>
<pubDate>Tue, 04 Jun 2024 10:00:00 GMT</pubDate>
<description><![CDATA[<p>I write five hundred words before breakfast.</p>
<p>Habits beat inspiration.</p>]]></description>
</item></channel></rss>"""


class FakeResponse:
    def __init__(self, status: int = 200, text: str = "", content_type: str = "application/rss+xml",
                 url: str = "", json_data=None):
        self.status_code = status
        self.text = text
        self.content = text.encode()
        self.headers = {"content-type": content_type}
        self.url = url
        self._json = json_data

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("bad", request=None, response=self)


def fake_web(routes: dict):
    def get(url, *args, **kwargs):
        for prefix, resp in routes.items():
            if url.startswith(prefix):
                resp.url = url
                return resp
        return FakeResponse(404, "not found", "text/html", url)

    return get


@pytest.fixture()
def auth(client):
    client.post("/api/auth/email/register/start", json={"email": "ada@example.com", "password": "stardust-42",
                                                        "name": "Ada Lovelace"})
    r = client.post("/api/auth/email/register/verify", json={"email": "ada@example.com", "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture()
def feed(monkeypatch):
    monkeypatch.setattr(httpx, "get", fake_web({"https://ada.example.com/feed": FakeResponse(200, FEED)}))


@pytest.fixture()
def llm(monkeypatch):
    """Canned outputs per signature. Tests override entries in the returned dict."""
    from app.llm import run

    outputs: dict = {}
    calls: list[str] = []

    def predict(signature, *, db, workspace_id, job=None, lm=None, **inputs):
        name = signature.__name__
        calls.append(name)
        value = outputs[name]
        return value(**inputs) if callable(value) else value

    monkeypatch.setattr(run, "predict", predict)
    outputs["_calls"] = calls
    return outputs


def connect(client, auth, run_jobs):
    r = client.post("/api/sources", json={"url": "ada.example.com"}, headers=auth)
    assert r.status_code == 200, r.text
    jobs = run_jobs()
    assert jobs[0].status == "done", jobs[0].error
    return r.json()["source"]


def docs(client, auth):
    return client.get("/api/documents", headers=auth).json()["items"]


# Storage


def test_local_storage_signed_urls(client):
    from app.services.storage import storage

    storage.put_bytes("ws/x/file.txt", b"0123456789")
    url = storage.presign_get("ws/x/file.txt").split("8000", 1)[1]
    assert client.get(url).content == b"0123456789"
    ranged = client.get(url, headers={"Range": "bytes=2-4"})
    assert ranged.status_code == 206 and ranged.content == b"234"
    assert client.get(url.replace("sig=", "sig=0")).status_code == 403
    expired = storage._signed("GET", "ws/x/file.txt", -10)
    assert client.get(expired.split("8000", 1)[1]).status_code == 403
    put = storage.presign_put("ws/x/new.bin", "application/octet-stream").split("8000", 1)[1]
    assert client.put(put, content=b"abc").status_code == 200
    assert storage.get_bytes("ws/x/new.bin") == b"abc"
    assert client.get(url.replace("file.txt", "new.bin")).status_code == 403  # signature is per key


# Sources


def test_connect_rejects_missing_feed(client, auth, monkeypatch):
    monkeypatch.setattr(httpx, "get", fake_web({}))
    r = client.post("/api/sources", json={"url": "nobody.substack.com"}, headers=auth)
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "feed_not_found"


ARTICLE = "<html><head><title>{t}</title></head><body><article><h1>{t}</h1><p>{body}</p></article></body></html>"


def test_connect_site_without_feed_crawls_posts(client, auth, run_jobs, monkeypatch):
    body = "A long paragraph about writing in public. " * 10
    monkeypatch.setattr(httpx, "get", fake_web({
        "https://site.example.com/blog/first": FakeResponse(200, ARTICLE.format(t="First", body=body), "text/html"),
        "https://site.example.com/blog/second": FakeResponse(200, ARTICLE.format(t="Second", body=body), "text/html"),
        "https://site.example.com/blog": FakeResponse(200, (
            '<html><head><title>Site Blog</title></head><body><a href="/blog/first">1</a>'
            '<a href="/blog/second">2</a><a href="/about">About</a><a href="/logo.png">x</a></body></html>'
        ), "text/html"),
    }))
    r = client.post("/api/sources", json={"url": "https://site.example.com/blog"}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["source"]["platform"] == "website"
    assert r.json()["source"]["feed_url"] == "site:https://site.example.com/blog"
    jobs = run_jobs()
    assert jobs[0].status == "done", jobs[0].error
    assert {d["title"] for d in docs(client, auth)} == {"First", "Second"}


def test_crawl_uses_firecrawl_when_configured(monkeypatch):
    from app.pipeline import ingest
    from app.services import firecrawl

    monkeypatch.setattr(firecrawl, "enabled", lambda: True)
    monkeypatch.setattr(firecrawl, "map_site", lambda url, limit: [
        "https://js.example.com/", "https://js.example.com/blog/rendered-post", "https://js.example.com/privacy",
    ])
    text = "Rendered by JavaScript, still readable. " * 10
    monkeypatch.setattr(firecrawl, "scrape", lambda url: {
        "markdown": f"# Rendered Post\n\n{text}\n\n![hero](https://x/y.png) See [the docs](https://x).",
        "metadata": {"title": "Rendered Post", "sourceURL": url, "publishedTime": "2026-05-01T10:00:00Z"},
    })
    entries = ingest.crawl_site("https://js.example.com", 10)
    assert [e.title for e in entries] == ["Rendered Post"]
    assert entries[0].published_at.year == 2026
    body = entries[0].sections[0][1]
    assert "See the docs." in body and "[the docs]" not in body
    assert "![hero](https://x/y.png)" in [t for _, t in entries[0].sections][0]  # images kept for answers


def test_firecrawl_is_main_path_except_substack(feed, monkeypatch):
    from app.pipeline import ingest
    from app.services import firecrawl

    monkeypatch.setattr(firecrawl, "enabled", lambda: True)
    found = ingest.discover_feed("https://ada.example.com/feed")
    assert (found.platform, found.feed_url, found.title) == ("website", "site:https://ada.example.com", "Ada Writes")
    monkeypatch.setattr(httpx, "get", fake_web({"https://ada.substack.com/feed": FakeResponse(200, FEED)}))
    assert ingest.discover_feed("ada.substack.com").platform == "substack"


def test_connect_ingest_read_and_delete(client, auth, run_jobs, feed, db_session):
    source = connect(client, auth, run_jobs)
    assert source["title"] == "Ada Writes"
    items = docs(client, auth)
    assert {d["title"] for d in items} == {"On Pricing", "Writing Every Day"}
    listed = client.get("/api/sources", headers=auth).json()
    assert listed[0]["document_count"] == 2 and listed[0]["sync_status"] == "ok"

    post = client.get(f"/api/documents/{items[0]['id']}", headers=auth).json()
    assert post["lines"][0] == "---" and any("paid tier" in ln or "breakfast" in ln for ln in post["lines"])
    assert client.get("/api/documents", params={"q": "breakfast"}, headers=auth).json()["total"] == 1

    # Re-sync is a no-op for unchanged posts.
    client.post(f"/api/sources/{source['id']}/sync", headers=auth)
    assert run_jobs()[0].result["skipped"] == 2

    r = client.delete(f"/api/sources/{source['id']}", headers=auth)
    assert r.json()["removed_posts"] == 2
    assert docs(client, auth) == []


def test_import_url_and_markdown_upload(client, auth, run_jobs, monkeypatch):
    article = FakeResponse(200, "<html><head><title>Loose Post</title>"
                                "<meta property='article:published_time' content='2024-01-02T00:00:00Z'></head>"
                                "<body><article><h1>Loose Post</h1><p>Standalone essay text lives here.</p>"
                                "</article></body></html>", "text/html")
    monkeypatch.setattr(httpx, "get", fake_web({"https://elsewhere.example.com/essay": article}))
    r = client.post("/api/sources/url", json={"url": "https://elsewhere.example.com/essay"}, headers=auth)
    assert r.status_code == 200
    assert run_jobs()[0].status == "done"

    start = client.post("/api/storage/uploads", json={"filename": "notes.md", "content_type": "text/markdown",
                                                      "size_bytes": 60}, headers=auth).json()
    client.put(start["upload_url"].split("8000", 1)[1], content=b"# Field Notes\n\n## Day one\nIt rained all day.\n")
    client.post(f"/api/storage/uploads/{start['upload_id']}/complete", headers=auth)
    r = client.post("/api/sources/upload", json={"upload_id": start["upload_id"]}, headers=auth)
    assert run_jobs()[0].status == "done", r.text
    titles = {d["title"] for d in docs(client, auth)}
    assert titles == {"Loose Post", "Field Notes"}
    sources = client.get("/api/sources", headers=auth).json()
    assert len(sources) == 1 and sources[0]["is_imports"]


# Notebooks


def test_notebook_crud_chat_history_and_summary(client, auth, run_jobs, feed, llm, db_session):
    connect(client, auth, run_jobs)
    items = docs(client, auth)
    pricing = next(d for d in items if d["title"] == "On Pricing")
    nb = client.post("/api/notebooks", json={"title": "Money", "document_ids": [pricing["id"]]}, headers=auth).json()
    assert nb["added"] == 1
    assert client.patch(f"/api/notebooks/{nb['id']}", json={"title": "Pricing"}, headers=auth).json()["title"] == \
        "Pricing"
    listed = client.get("/api/notebooks", headers=auth).json()
    assert listed[0]["document_count"] == 1

    path = pricing["path"]
    llm["SummarizeNotebook"] = {
        "summary": "Raising prices worked [1]. Also the moon is cheese [2].",
        "themes": ["Pricing"],
        "citations": [{"marker": 1, "path": path, "line_start": 12, "line_end": 14},
                      {"marker": 2, "path": "sources/fake.md", "line_start": 1, "line_end": 2}],
    }
    art = client.post("/api/artifacts/generate", json={"type": "summary", "notebook_id": nb["id"]},
                      headers=auth).json()
    assert art["job"]["status"] == "queued"
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert done["status"] == "ready"
    assert len(done["content"]["citations"]) == 1  # the invented citation was dropped
    assert "[2]" not in done["content"]["summary"]
    assert client.get(f"/api/notebooks/{nb['id']}", headers=auth).json()["summary"].startswith("Raising")

    # Chat history endpoints
    from app.models import Chat, Message

    chat = Chat(workspace_id=db_session.get(Source, uuid.UUID(pricing["source_id"])).workspace_id,
                notebook_id=uuid.UUID(nb["id"]), title="q")
    db_session.add(chat)
    db_session.flush()
    db_session.add(Message(chat_id=chat.id, role="user", content="Why price high?"))
    db_session.commit()
    chats = client.get(f"/api/notebooks/{nb['id']}/chats", headers=auth).json()
    assert chats[0]["id"] == str(chat.id)
    assert client.get(f"/api/notebooks/chats/{chat.id}/messages", headers=auth).json()[0]["text"] == "Why price high?"

    client.delete(f"/api/notebooks/{nb['id']}/documents/{pricing['id']}", headers=auth)
    assert client.get(f"/api/notebooks/{nb['id']}", headers=auth).json()["documents"] == []
    assert client.delete(f"/api/notebooks/{nb['id']}", headers=auth).status_code == 200


def test_summary_of_empty_notebook_fails_cleanly(client, auth, run_jobs, llm):
    nb = client.post("/api/notebooks", json={"title": "Empty"}, headers=auth).json()
    art = client.post("/api/artifacts/generate", json={"type": "summary", "notebook_id": nb["id"]},
                      headers=auth).json()
    job = run_jobs()[0]
    assert job.status == "failed" and job.attempts == 1  # permanent, no retries
    assert client.get(f"/api/artifacts/{art['id']}", headers=auth).json()["status"] == "failed"


# Topics, voice, resurfacing


def test_topic_map_and_notebook_from_topic(client, auth, run_jobs, feed, llm):
    connect(client, auth, run_jobs)
    llm["ExtractTopics"] = lambda title, **_: {"topics": [
        {"name": "Pricing" if "Pricing" in title else "Habits", "weight": 0.9},
        {"name": "Writing Business", "weight": 0.5},
        {"name": "Writing business", "weight": 0.4},
    ]}
    llm["ConsolidateTopics"] = {"groups": [
        {"canonical": "Writing Business", "members": ["Writing Business", "Writing business"],
         "summary": "Making writing pay."},
    ]}
    client.post("/api/topics/rebuild", headers=auth)
    assert run_jobs()[0].status == "done"
    graph = client.get("/api/topics", headers=auth).json()
    names = {n["name"]: n for n in graph["nodes"]}
    assert set(names) == {"Pricing", "Habits", "Writing Business"}
    assert names["Writing Business"]["post_count"] == 2
    assert len(graph["edges"]) == 2
    detail = client.get(f"/api/topics/{names['Writing Business']['id']}", headers=auth).json()
    assert len(detail["posts"]) == 2
    # Insight: Habits was only written about in 2024, long before the archive's recent window.
    assert names["Habits"]["status"] == "dormant" and names["Pricing"]["recent_posts"] == 1
    assert len(names["Pricing"]["timeline"]) == 12 and sum(names["Writing Business"]["timeline"]) == 2
    assert graph["galaxies"] and graph["galaxies"][0]["name"] == "Writing Business"
    assert graph["insights"]["dormant"][0]["name"] == "Habits"
    assert graph["insights"]["pairs"][0]["posts"] == 1
    assert {r["name"] for r in detail["related"]} == {"Pricing", "Habits"}
    assert detail["first_at"] < detail["last_at"]
    nb = client.post(f"/api/notebooks/from-topic/{names['Pricing']['id']}", headers=auth).json()
    assert nb["added"] == 1


def topic_metas(session_factory) -> dict[str, dict]:
    with session_factory() as db:
        return {d.title: d.metadata_json or {} for d in db.query(Document).filter(Document.path.is_not(None))}


def test_a_post_the_model_fails_on_is_tried_again(client, auth, run_jobs, feed, llm, monkeypatch, session_factory):
    from app.pipeline import generate
    monkeypatch.setattr(generate, "TAG_BACKOFF", (0.0, 0.0))
    connect(client, auth, run_jobs)
    tries: dict[str, int] = {}

    def extract(title, **_):
        tries[title] = tries.get(title, 0) + 1
        if tries[title] == 1:
            raise TimeoutError("the model timed out")  # once per post: the second try works
        if tries[title] == 2 and "Pricing" in title:
            return {"topics": []}  # an empty answer is not a result: tried a third time
        return {"topics": [{"name": "Writing", "weight": 0.8}]}

    llm["ExtractTopics"] = extract
    llm["ConsolidateTopics"] = {"groups": []}
    client.post("/api/topics/rebuild", headers=auth)
    job = run_jobs()[0]
    metas = topic_metas(session_factory)
    assert job.status == "done" and job.result["tagged"] == len(metas) and job.result["failed"] == 0
    assert all(m["topics"] == [{"name": "Writing", "weight": 0.8}] for m in metas.values())
    assert max(tries.values()) == 3


def test_every_post_gets_topics_through_the_sweep(client, auth, run_jobs, feed, llm, monkeypatch, session_factory):
    from app import worker
    from app.config import settings
    from app.pipeline import generate
    monkeypatch.setattr(generate, "TAG_BACKOFF", (0.0, 0.0))
    monkeypatch.setattr(settings, "llm_api_key", "test-key")
    llm["ConsolidateTopics"] = {"groups": []}
    llm["ExtractTopics"] = lambda **_: (_ for _ in ()).throw(TimeoutError("the model is down"))
    connect(client, auth, run_jobs)  # the import's topics job runs too, and tags nothing
    metas = topic_metas(session_factory)
    assert metas and all("topics" not in m and m["topics_failures"] == 1 for m in metas.values())

    worker.topics_backfill(session_factory)
    worker.topics_backfill(session_factory)  # one job per workspace, not one per sweep
    llm["ExtractTopics"] = {"topics": [{"name": "Pricing", "weight": 0.9}]}  # the model is back
    jobs = run_jobs()
    assert len(jobs) == 1 and jobs[0].result["tagged"] == len(metas)
    assert all(m["topics"] and "topics_failures" not in m for m in topic_metas(session_factory).values())
    worker.topics_backfill(session_factory)
    assert not run_jobs()  # all tagged: nothing to do


def test_the_sweep_gives_up_on_a_post_that_keeps_failing(client, auth, run_jobs, feed, llm, monkeypatch,
                                                         session_factory):
    from app import worker
    from app.config import settings
    from app.pipeline import generate
    monkeypatch.setattr(generate, "TAG_BACKOFF", (0.0, 0.0))
    monkeypatch.setattr(settings, "llm_api_key", "test-key")
    llm["ConsolidateTopics"] = {"groups": []}
    llm["ExtractTopics"] = lambda **_: (_ for _ in ()).throw(TimeoutError("always"))
    connect(client, auth, run_jobs)
    for _ in range(generate.MAX_TAG_FAILURES):
        worker.topics_backfill(session_factory)
        run_jobs()
    assert all(m["topics_failures"] == generate.MAX_TAG_FAILURES for m in topic_metas(session_factory).values())
    worker.topics_backfill(session_factory)
    assert not run_jobs()


def test_voice_profile_build_and_edit(client, auth, run_jobs, feed, llm):
    connect(client, auth, run_jobs)
    profile = {"tone": ["warm"], "sentence_length": "short", "vocabulary": ["readers"], "structure_habits": [],
               "openings": ["A number"], "avoid": ["jargon"], "summary": "Plain and direct."}
    llm["BuildVoiceProfile"] = {"profile": profile}
    client.post("/api/voice/build", json={"document_ids": []}, headers=auth)
    assert run_jobs()[0].status == "done"
    voice = client.get("/api/voice", headers=auth).json()
    assert voice["profile"]["summary"] == "Plain and direct."
    r = client.put("/api/voice", json={"host_voices": {"host_a": "abc", "host_b": "def"}}, headers=auth)
    assert r.json()["host_voices"] == {"host_a": "abc", "host_b": "def"}
    bad = client.post("/api/voice/consent", json={"upload_id": str(uuid.uuid4()), "agreed": True,
                                                  "consent_text": "nope"}, headers=auth)
    assert bad.status_code == 400


def test_resurface_scan_and_suggestions(client, auth, run_jobs, feed, llm):
    connect(client, auth, run_jobs)
    llm["EvergreenScore"] = lambda title, **_: {"score": 0.9 if "Writing" in title else 0.2,
                                                "reason": "Timeless habit advice", "angle": "Still true"}
    client.post("/api/resurface/scan", headers=auth)
    assert run_jobs()[0].status == "done"
    data = client.get("/api/resurface", headers=auth).json()
    assert data["unscored"] == 0
    assert data["evergreen"][0]["title"] == "Writing Every Day"
    assert data["evergreen"][0]["angle"] == "Still true"


# Audio, video, launch kit


def test_audio_overview_and_limits(client, auth, run_jobs, feed, llm, monkeypatch, db_session):
    from app.config import settings
    from app.services import tts

    connect(client, auth, run_jobs)
    doc = docs(client, auth)[0]
    monkeypatch.setattr(settings, "elevenlabs_api_key", "test")
    calls = []

    def fake_synth(ws, text, voice, vs=None, prev=None, nxt=None):
        calls.append((text, voice, prev, nxt, vs.stability if vs else None))
        return b"\x00" * 16000  # 1 second at 128 kbps

    monkeypatch.setattr(tts, "synthesize", fake_synth)
    client.put("/api/voice", json={"host_voices": {"host_a": "voiceA", "host_b": "voiceB"},
                                   "delivery": {"host_b": {"stability": 0.9, "similarity_boost": 0.7,
                                                           "style": 0.1, "speed": 1.1}}}, headers=auth)
    llm["PodcastScript"] = {"lines": [
        {"speaker": "host_a", "text": "Welcome in.", "sources": []},
        {"speaker": "host_b", "text": "Prices went up.", "sources": [{"path": doc["path"], "line_start": 12,
                                                                      "line_end": 13}]},
    ]}
    art = client.post("/api/artifacts/generate", json={"type": "audio_overview", "document_id": doc["id"],
                                                       "minutes": 5}, headers=auth).json()
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert done["status"] == "ready", done["content"]
    assert done["content"]["duration_s"] == 2.0
    # Each line hears its neighbour; hosts use their own voice and delivery settings.
    by_text = {c[0]: c for c in calls}
    assert by_text["Welcome in."][1] == "voiceA" and by_text["Welcome in."][3] == "Prices went up."
    assert by_text["Prices went up."][1] == "voiceB" and by_text["Prices went up."][2] == "Welcome in."
    assert by_text["Prices went up."][4] == 0.9
    assert done["url"] and client.get(done["url"].split("8000", 1)[1]).content == b"\x00" * 32000

    ws_id = db_session.get(Document, uuid.UUID(doc["id"])).workspace_id
    db_session.add(UsageEvent(workspace_id=ws_id, kind="tts", provider="elevenlabs", quantity=240 * 60,
                              unit="seconds"))
    db_session.commit()
    r = client.post("/api/artifacts/generate", json={"type": "audio_overview", "document_id": doc["id"],
                                                     "minutes": 5}, headers=auth)
    assert r.status_code == 402 and r.json()["detail"]["code"] == "plan_limit"


def test_native_video_moved_to_blog2video(client, auth, run_jobs, feed):
    connect(client, auth, run_jobs)
    doc = docs(client, auth)[0]
    r = client.post("/api/artifacts/generate", json={"type": "video", "document_id": doc["id"], "style": "short"},
                    headers=auth)
    assert r.status_code == 410


def test_audiogram_hands_off_and_renderer_callback(client, auth, monkeypatch, db_session, run_jobs):
    from app.config import settings
    from app.models import Artifact, Workspace
    from app.pipeline import media

    ws = db_session.query(Workspace).one()
    audio = Artifact(workspace_id=ws.id, type="audio_overview", status="ready", storage_key="ws/x/audio.mp3",
                     content_json={"title": "Pricing", "duration_s": 42, "segments": []})
    db_session.add(audio)
    db_session.commit()
    sent = {}
    monkeypatch.setattr(media, "request_render", lambda job, artifact, comp, props=None, stills=None:
                        sent.update(comp=comp, props=props, job=str(job.id)))
    art = client.post("/api/artifacts/generate", json={"type": "video", "style": "audiogram",
                                                       "audio_artifact_id": str(audio.id)}, headers=auth).json()
    job = run_jobs()[0]
    assert job.status == "running"  # handed off to the renderer
    assert sent["comp"] == "AudiogramSquare"
    r = client.post(f"/api/internal/jobs/{sent['job']}/progress", headers={"x-internal-token": settings.internal_token},
                    json={"status": "done", "progress": 1, "storage_key": "ws/x/video.mp4", "render_seconds": 12})
    assert r.status_code == 200
    assert client.get(f"/api/artifacts/{art['id']}", headers=auth).json()["status"] == "ready"


def test_renderer_down_fails_without_retry(client, auth, run_jobs, feed, llm, monkeypatch):
    connect(client, auth, run_jobs)
    doc = docs(client, auth)[0]

    def refuse(*args, **kwargs):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(httpx, "post", refuse)
    llm["PickQuotes"] = lambda passages, **_: {"quotes": [{"quote": "Charging more made my readers take the work "
                                                                    "seriously.",
                                                           "source": {"path": doc["path"], "line_start": 1,
                                                                      "line_end": 20}}]}
    art = client.post("/api/artifacts/generate", json={"type": "quote_card", "document_id": doc["id"]},
                      headers=auth).json()
    job = run_jobs()[0]
    assert job.status == "failed" and "Renderer is not running" in job.error
    assert client.get(f"/api/artifacts/{art['id']}", headers=auth).json()["status"] == "failed"


def test_launch_kit(client, auth, run_jobs, feed, llm, monkeypatch, db_session):
    from app.pipeline import media

    connect(client, auth, run_jobs)
    doc = next(d for d in docs(client, auth) if d["title"] == "On Pricing")
    ref = {"path": doc["path"], "line_start": 12, "line_end": 14}
    llm.update({
        "ExtractClaims": {"claims": [{"claim": "Higher prices signal value", "sources": [ref]},
                                     {"claim": "Unsupported", "sources": [{**ref, "line_start": 999}]}]},
        "HookGenerator": {"hooks": [{"text": "I doubled my price.", "strength": 0.9, "rationale": "number"}]},
        "PlatformAdapter": lambda platform, **_: {"posts": [f"{platform} post one", f"{platform} post two"]},
        "SeoPack": {"seo": {"title_options": ["On Pricing"], "meta_description": "Why I charge more.",
                            "slug": "on-pricing", "keywords": ["pricing"], "internal_links": []}},
        "CarouselSlides": {"slides": [{"heading": "Charge more", "body": "It works."}]},
        "PickQuotes": {"quotes": [{"quote": "Charging more made my readers take the work seriously.",
                                   "source": ref}]},
    })
    from app.services import renderer

    monkeypatch.setattr(media, "request_render", lambda *a, **k: None)
    monkeypatch.setattr(renderer, "available", lambda: True)
    art = client.post("/api/artifacts/generate", json={"type": "launch_kit", "document_id": doc["id"]},
                      headers=auth).json()
    run_jobs()
    kit = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert kit["status"] == "ready", kit["content"]
    c = kit["content"]
    assert len(c["claims"]) == 1  # the unverifiable claim was dropped
    assert set(c["posts"]) == {"x_thread", "linkedin", "substack_notes", "bluesky"}
    assert len(c["quote_card_ids"]) == 1
    card = client.get(f"/api/artifacts/{c['quote_card_ids'][0]}", headers=auth).json()
    assert card["status"] == "rendering"  # its own job ran and handed off

    edited = client.patch(f"/api/artifacts/{art['id']}", json={"content": {"posts": {**c["posts"],
                                                                                    "linkedin": ["Edited"]}}},
                          headers=auth).json()
    assert edited["content"]["posts"]["linkedin"] == ["Edited"]
    assert edited["content"]["quote_card_ids"] == c["quote_card_ids"]

    listing = client.get("/api/artifacts", params={"type": "launch_kit"}, headers=auth).json()
    assert listing["total"] == 1

    # Renderer down: the kit keeps its quotes as text and makes no quote cards that could only fail.
    monkeypatch.setattr(renderer, "available", lambda: False)
    art = client.post("/api/artifacts/generate", json={"type": "launch_kit", "document_id": doc["id"]},
                      headers=auth).json()
    run_jobs()
    kit = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert kit["status"] == "ready"
    assert kit["content"]["quotes"] and kit["content"]["quote_card_ids"] == []
    assert client.delete(f"/api/artifacts/{art['id']}", headers=auth).status_code == 200


# Launchpad


def _bluesky(client, auth, monkeypatch):
    from app.services.social import bluesky

    monkeypatch.setattr(bluesky, "create_session", lambda handle, pw: {"did": "did:plc:ada", "handle": handle,
                                                                       "accessJwt": "jwt"})
    r = client.post("/api/social/bluesky", json={"handle": "ada.bsky.social", "app_password": "abcd-efgh-ijkl"},
                    headers=auth)
    assert r.status_code == 200, r.text
    return r.json()["accounts"][0]


def test_schedule_and_publish_bluesky_thread(client, auth, monkeypatch, session_factory, db_session, run_jobs):
    from app.services import launchpad
    from app.services.social import bluesky

    account = _bluesky(client, auth, monkeypatch)
    published = {}

    def publish(db, acct, posts, media=None):
        published["posts"] = posts
        return "at://did:plc:ada/app.bsky.feed.post/abc", "https://bsky.app/profile/ada.bsky.social/post/abc"

    monkeypatch.setattr(bluesky, "publish", publish)
    too_long = client.post("/api/calendar", json={"platform": "bluesky", "content": "x" * 400,
                                                  "scheduled_at": datetime.now(UTC).isoformat(),
                                                  "social_account_id": account["id"]}, headers=auth)
    assert too_long.status_code == 422
    item = client.post("/api/calendar", json={
        "platform": "bluesky", "content": "First", "thread": ["Second", " "],
        "scheduled_at": (datetime.now(UTC) - timedelta(minutes=1)).isoformat(), "social_account_id": account["id"],
    }, headers=auth).json()
    assert item["auto_post"] is True

    assert launchpad.publish_due(session_factory) == 1  # queued as a publish_post job
    assert [j.kind for j in run_jobs()] == ["publish_post"]
    assert published["posts"] == ["First", "Second"]
    got = client.get("/api/calendar", headers=auth).json()[0]
    assert got["status"] == "posted" and got["external_url"].startswith("https://bsky.app/")
    assert client.patch(f"/api/calendar/{item['id']}", json={"content": "late"}, headers=auth).status_code == 409


def test_substack_notes_send_reminder_email(client, auth, session_factory, run_jobs):
    from app.services import launchpad

    ConsoleEmailProvider.sent.clear()
    item = client.post("/api/calendar", json={"platform": "substack_notes", "content": "A note",
                                              "scheduled_at": (datetime.now(UTC) - timedelta(seconds=5)).isoformat()},
                       headers=auth).json()
    assert item["remind_by_email"] is True
    launchpad.publish_due(session_factory)
    run_jobs()
    assert client.get("/api/calendar", headers=auth).json()[0]["status"] == "reminded"
    assert ConsoleEmailProvider.sent[-1].subject == "Time to post on Substack Notes"


def test_publish_retries_then_fails(client, auth, monkeypatch, session_factory, run_jobs):
    from app.services import launchpad
    from app.services.social import SocialError, bluesky

    account = _bluesky(client, auth, monkeypatch)

    def boom(db, acct, posts, media=None):
        raise SocialError("Bluesky 500: busy")

    monkeypatch.setattr(bluesky, "publish", boom)
    item = client.post("/api/calendar", json={"platform": "bluesky", "content": "Hi", "social_account_id":
                                              account["id"], "scheduled_at": datetime.now(UTC).isoformat()},
                       headers=auth).json()
    r = client.post(f"/api/calendar/{item['id']}/publish", headers=auth).json()
    assert r["status"] == "scheduled" and "busy" in r["error"]  # retry queued
    for _ in range(2):
        with session_factory() as db:
            db.query(CalendarItem).update({"scheduled_at": datetime.now(UTC) - timedelta(seconds=1)})
            db.commit()
        launchpad.publish_due(session_factory)
        run_jobs()
    assert client.get("/api/calendar", headers=auth).json()[0]["status"] == "failed"


def test_tracked_link_counts_clicks(client, auth, db_session):
    ws = db_session.query(Workspace).first()
    item = CalendarItem(workspace_id=ws.id, platform="x", scheduled_at=datetime.now(UTC), content="x",
                        status="posted")
    db_session.add(item)
    db_session.flush()
    db_session.add(TrackedLink(workspace_id=ws.id, slug="abc1234", target_url="https://ada.example.com/p/x",
                               calendar_item_id=item.id))
    db_session.commit()
    r = client.get("/l/abc1234", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "https://ada.example.com/p/x"
    assert db_session.query(EngagementEvent).count() == 1
    assert client.get("/api/calendar", headers=auth).json()[0]["clicks"] == 1
    assert client.get("/l/nope", follow_redirects=False).status_code == 404


def test_oauth_link_is_bound_to_the_starting_workspace(client, auth, monkeypatch, db_session):
    import json

    from app.auth import encode_signed
    from app.services.crypto import encrypt

    ws = db_session.query(Workspace).first()
    info = {"access_token": "tok", "refresh_token": "ref", "expires_in": 7200, "external_id": "42",
            "handle": "ada", "scope": "tweet.write"}

    def ticket(ws_id):
        return encode_signed({"typ": "social_link", "ws": str(ws_id), "platform": "x",
                              "data": encrypt(json.dumps(info))}, timedelta(minutes=5))

    assert client.post("/api/social/complete", json={"ticket": ticket(uuid.uuid4())}, headers=auth).status_code == 403
    r = client.post("/api/social/complete", json={"ticket": ticket(ws.id)}, headers=auth)
    assert r.status_code == 200
    acct = db_session.query(SocialAccount).one()
    assert acct.platform == "x" and acct.access_token != "tok"  # stored encrypted
    assert client.post("/api/social/x/start", headers=auth).status_code == 503  # no client id configured


def test_oauth_callback_redirects_with_ticket(client, monkeypatch):
    from app.auth import encode_signed
    from app.services.social import linkedin

    monkeypatch.setattr(linkedin, "exchange_code", lambda code: {"access_token": "t", "external_id": "p",
                                                                 "handle": "Ada", "expires_in": 60})
    state = encode_signed({"typ": "social_state", "nonce": "n", "ws": str(uuid.uuid4()), "platform": "linkedin"},
                          timedelta(minutes=5))
    r = client.get("/api/social/linkedin/callback", params={"code": "c", "state": state}, follow_redirects=False)
    assert r.status_code == 302 and "link=" in r.headers["location"] and "/app/launchpad" in r.headers["location"]
    bad = client.get("/api/social/linkedin/callback", params={"code": "c", "state": "junk"}, follow_redirects=False)
    assert "error=" in bad.headers["location"]


# Launchpad: posting what was made (images and videos) to X and LinkedIn


def _made(db, ws, type_, *, status="ready", key=None, **content):
    """An artifact as the pipeline leaves it (its file in storage when it has one)."""
    from app.models import Artifact
    from app.services.storage import storage

    if key:
        storage.put_bytes(key, b"PNG" if key.endswith(".png") else bytes(range(256)) * 400)  # a 100 KB "video"
    a = Artifact(workspace_id=ws.id, type=type_, status=status, storage_key=key,
                 content_json={"title": f"A {type_}", **content})
    db.add(a)
    db.commit()
    return a


def _account(db, ws, platform, scopes="tweet.read tweet.write users.read offline.access media.write"):
    from app.services.crypto import encrypt

    acct = SocialAccount(workspace_id=ws.id, platform=platform, handle="ada", external_id="p42",
                         access_token=encrypt("tok"), scopes=scopes, status="active")
    db.add(acct)
    db.commit()
    return acct


def _reply(code: int, method: str, url: str, data: dict | None = None, headers: dict | None = None):
    return httpx.Response(code, json=data, headers=headers, request=httpx.Request(method, url))


def _schedule(client, auth, artifact, platform, account=None):
    r = client.post("/api/calendar", json={
        "platform": platform, "content": "Look at this", "artifact_id": str(artifact.id),
        "scheduled_at": (datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
        **({"social_account_id": str(account.id)} if account else {})}, headers=auth)
    return r


def test_postable_lists_what_can_be_posted(client, auth, db_session):
    ws = db_session.query(Workspace).first()
    quote = _made(db_session, ws, "quote_card", key="ws/q/quotecard.png", quote="Ship it", source="Ada")
    _made(db_session, ws, "audio_overview", key="ws/a/audio.mp3")
    _made(db_session, ws, "video", status="processing", provider="blog2video")  # not rendered yet
    done = _made(db_session, ws, "video", status="processing", provider="blog2video", video_url="https://v/x.mp4")
    unrendered = _made(db_session, ws, "video", status="ready", provider="blog2video", b2v_status="generated")
    _made(db_session, ws, "summary", summary="Raise prices once a year [1].")
    got = {a["id"]: a for a in client.get("/api/launchpad/postable", headers=auth).json()}
    assert {a["type"] for a in got.values()} == {"quote_card", "video", "summary"}  # no audio, no unfinished video
    assert str(done.id) in got and got[str(quote.id)]["thumb_url"] and got[str(quote.id)]["media"] == "image"
    # Made but not rendered: listed, flagged; the rendered one is not.
    assert got[str(unrendered.id)]["needs_render"] is True and got[str(done.id)]["needs_render"] is False
    assert got[str(quote.id)]["prefill"] == {"x": ['"Ship it" (Ada)'], "linkedin": '"Ship it" (Ada)'}
    summary = next(a for a in got.values() if a["type"] == "summary")
    assert summary["prefill"]["linkedin"] == "Raise prices once a year." and summary["media"] == "text"


def test_scheduling_refuses_what_cannot_go_out(client, auth, db_session):
    ws = db_session.query(Workspace).first()
    audio = _made(db_session, ws, "audio_overview", key="ws/a/audio.mp3")
    long_video = _made(db_session, ws, "video", key="ws/v/audiogram.mp4", duration_s=200)
    quote = _made(db_session, ws, "quote_card", key="ws/q/quotecard.png")
    assert _schedule(client, auth, audio, "x").status_code == 400
    r = _schedule(client, auth, long_video, "x")
    assert r.status_code == 400 and "2:20" in r.json()["detail"]
    linkedin_acct = _account(db_session, ws, "linkedin", scopes="openid profile w_member_social")
    assert _schedule(client, auth, long_video, "linkedin", linkedin_acct).status_code == 200  # LinkedIn takes it
    assert _schedule(client, auth, quote, "bluesky").status_code == 400  # images: X and LinkedIn only


def test_x_posts_images_and_a_video(client, auth, db_session, monkeypatch, session_factory, run_jobs):
    from app.services import launchpad
    from app.services.social import x

    ws = db_session.query(Workspace).first()
    acct = _account(db_session, ws, "x")
    calls = []

    def call(method, url, **kw):
        path = url.split("/2/", 1)[1]
        calls.append((method, path, kw))
        if path == "media/upload" and method == "POST":
            return _reply(200, method, url, {"data": {"id": f"img{len(calls)}"}})
        if path == "media/upload/initialize":
            return _reply(200, method, url, {"data": {"id": "vid1"}})
        if path.endswith("/append"):
            return _reply(204, method, url)
        if path.endswith("/finalize"):
            return _reply(200, method, url, {"data": {"processing_info": {"state": "pending", "check_after_secs": 1}}})
        if path == "media/upload":  # STATUS
            return _reply(200, method, url, {"data": {"processing_info": {"state": "succeeded"}}})
        return _reply(201, method, url, {"data": {"id": "t1"}})  # tweets

    monkeypatch.setattr(x, "_call", call)
    monkeypatch.setattr(x.time, "sleep", lambda s: None)
    monkeypatch.setattr(x, "CHUNK", 30000)
    carousel = _made(db_session, ws, "carousel", key="ws/c/slide-01.png",
                     slide_keys=[f"ws/c/slide-0{i}.png" for i in range(1, 7)])
    for i in range(1, 7):
        from app.services.storage import storage
        storage.put_bytes(f"ws/c/slide-0{i}.png", b"PNG")
    assert _schedule(client, auth, carousel, "x", acct).status_code == 200
    launchpad.publish_due(session_factory)
    run_jobs()
    uploads = [c for c in calls if c[1] == "media/upload"]
    tweet = next(c for c in calls if c[1] == "tweets")
    assert len(uploads) == 4  # X takes 4 images: the first 4 slides
    assert tweet[2]["json"]["media"]["media_ids"] == [f"img{i}" for i in range(1, 5)]
    assert client.get("/api/calendar", headers=auth).json()[0]["status"] == "posted"

    calls.clear()
    video = _made(db_session, ws, "video", key="ws/v/audiogram.mp4", duration_s=30)
    _schedule(client, auth, video, "x", acct)
    launchpad.publish_due(session_factory)
    run_jobs()
    paths = [c[1] for c in calls]
    assert paths[0] == "media/upload/initialize" and paths.count("media/upload/vid1/append") == 4  # 102400 bytes
    assert paths[-3:] == ["media/upload/vid1/finalize", "media/upload", "tweets"]
    assert calls[-1][2]["json"]["media"] == {"media_ids": ["vid1"]}


def test_x_accounts_from_before_media_must_reconnect(client, auth, db_session, monkeypatch, session_factory,
                                                     run_jobs):
    from app.services import launchpad
    from app.services.social import x

    ws = db_session.query(Workspace).first()
    acct = _account(db_session, ws, "x", scopes="tweet.read tweet.write users.read offline.access")
    monkeypatch.setattr(x, "_call", lambda *a, **k: pytest.fail("nothing should be sent"))
    quote = _made(db_session, ws, "quote_card", key="ws/q/quotecard.png")
    r = _schedule(client, auth, quote, "x", acct)  # refused up front now
    assert r.status_code == 409 and "Reconnect X" in r.json()["detail"]["message"]
    got = client.get("/api/social/accounts", headers=auth).json()["accounts"][0]
    assert got["needs_reconnect"] is True and got["can_post_media"] is False
    # Scheduled earlier, the scope gone since: refused at publish time without a call, as a reconnect.
    with session_factory() as db:
        db.add(CalendarItem(workspace_id=ws.id, platform="x", content="Hi", artifact_id=quote.id,
                            social_account_id=acct.id, scheduled_at=datetime.now(UTC) - timedelta(minutes=1)))
        db.commit()
    launchpad.publish_due(session_factory)
    run_jobs()
    item = client.get("/api/calendar", headers=auth).json()[0]
    assert item["status"] == "paused" and "Reconnect X" in item["error"]


def test_linkedin_posts_images_and_a_video(client, auth, db_session, monkeypatch, session_factory, run_jobs):
    from app.services import launchpad
    from app.services.social import linkedin

    ws = db_session.query(Workspace).first()
    acct = _account(db_session, ws, "linkedin", scopes="openid profile w_member_social")
    calls = []

    def call(method, url, **kw):
        calls.append((method, url, kw))
        if url.endswith("/rest/images"):
            return _reply(200, method, url, {"value": {"uploadUrl": f"https://up/img{len(calls)}",
                                                       "image": f"urn:li:image:{len(calls)}"}})
        if url.endswith("/rest/videos") and kw["params"]["action"] == "initializeUpload":
            return _reply(200, method, url, {"value": {"video": "urn:li:video:9", "uploadToken": "",
                                                       "uploadInstructions": [
                                                           {"uploadUrl": "https://up/v1", "firstByte": 0, "lastByte": 59999},
                                                           {"uploadUrl": "https://up/v2", "firstByte": 60000,
                                                            "lastByte": 102399}]}})
        if url.startswith("https://up/"):
            return _reply(200, method, url, headers={"etag": f'"e-{url[-2:]}"'})
        if "/rest/videos/" in url:
            return _reply(200, method, url, {"status": "AVAILABLE"})
        if url.endswith("/rest/posts"):
            return _reply(201, method, url, headers={"x-restli-id": "urn:li:share:1"})
        return _reply(200, method, url)  # finalize

    monkeypatch.setattr(linkedin, "_call", call)
    quote = _made(db_session, ws, "quote_card", key="ws/q/quotecard.png")
    carousel = _made(db_session, ws, "carousel", key="ws/c/slide-01.png",
                     slide_keys=["ws/q/quotecard.png"] * 3)
    video = _made(db_session, ws, "video", key="ws/v/audiogram.mp4", duration_s=200)
    bodies = []
    for a in (quote, carousel, video):
        calls.clear()
        _schedule(client, auth, a, "linkedin", acct)
        launchpad.publish_due(session_factory)
        run_jobs()
        bodies.append(next(c for c in calls if c[1].endswith("/rest/posts"))[2]["json"]["content"])
        if a is video:
            puts = [c for c in calls if c[1].startswith("https://up/v")]
            assert [len(c[2]["content"]) for c in puts] == [60000, 42400]
            fin = next(c for c in calls if c[1].endswith("/rest/videos") and c[2]["params"]["action"] == "finalizeUpload")
            assert fin[2]["json"]["finalizeUploadRequest"]["uploadedPartIds"] == ["e-v1", "e-v2"]
    assert bodies[0] == {"media": {"id": "urn:li:image:1"}}
    assert len(bodies[1]["multiImage"]["images"]) == 3
    assert bodies[2] == {"media": {"id": "urn:li:video:9"}}
    assert {i["status"] for i in client.get("/api/calendar", headers=auth).json()} == {"posted"}


def test_publish_now_with_media_goes_through_a_job(client, auth, db_session, monkeypatch, run_jobs):
    from app.services.social import linkedin

    ws = db_session.query(Workspace).first()
    acct = _account(db_session, ws, "linkedin", scopes="openid profile w_member_social")
    monkeypatch.setattr(linkedin, "publish", lambda db, a, posts, media=None: ("urn:li:share:2", "https://li/2"))
    quote = _made(db_session, ws, "quote_card", key="ws/q/quotecard.png")
    item = client.post("/api/calendar", json={"platform": "linkedin", "content": "Hi", "artifact_id": str(quote.id),
                                              "social_account_id": str(acct.id),
                                              "scheduled_at": (datetime.now(UTC) + timedelta(days=1)).isoformat()},
                       headers=auth).json()
    assert item["artifact"]["type"] == "quote_card"
    r = client.post(f"/api/calendar/{item['id']}/publish", headers=auth).json()
    assert r["status"] == "publishing"  # the upload runs in a job
    run_jobs()
    assert client.get("/api/calendar", headers=auth).json()[0]["status"] == "posted"
    # The attachment can be changed or removed before it goes out.
    other = client.post("/api/calendar", json={"platform": "linkedin", "content": "Later", "artifact_id": str(quote.id),
                                               "social_account_id": str(acct.id),
                                               "scheduled_at": (datetime.now(UTC) + timedelta(days=1)).isoformat()},
                        headers=auth).json()
    r = client.patch(f"/api/calendar/{other['id']}", json={"artifact_id": None}, headers=auth).json()
    assert r["artifact"] is None


# Settings and activity


def test_settings_and_usage(client, auth):
    s = client.get("/api/settings", headers=auth).json()
    assert s["user"]["name"] == "Ada Lovelace" and s["usage"]["used"]["launch_kits"] == 0
    r = client.patch("/api/settings", json={"name": "Ada L", "workspace_name": "Ada HQ", "brand_accent": "#FF0000",
                                            "training_opt_in": True}, headers=auth).json()
    assert r["user"]["name"] == "Ada L" and r["workspace"]["name"] == "Ada HQ"
    assert r["brand"]["accent"] == "#ff0000" and r["workspace"]["training_opt_in"] is True
    assert client.patch("/api/settings", json={"brand_accent": "red"}, headers=auth).status_code == 422


def test_active_jobs_listing(client, auth, feed):
    client.post("/api/sources", json={"url": "ada.example.com"}, headers=auth)
    active = client.get("/api/jobs", params={"active": 1}, headers=auth).json()
    assert active[0]["kind"] == "ingest" and active[0]["status"] == "queued"


def test_worker_loop_runs_in_background(tmp_path, monkeypatch):
    """The embedded worker thread (RUN_WORKER_IN_API) drains jobs without a second process."""
    import threading

    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app import worker
    from app.db import Base
    from app.services.jobs import create_job

    # A real file database: the in-memory test engine shares one connection across threads.
    engine = create_engine(f"sqlite:///{tmp_path / 'w.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    with session_factory() as db:
        ws = Workspace(name="w", owner_id=uuid.uuid4())
        db.add(ws)
        db.commit()
        job = create_job(db, ws.id, "noop")
    monkeypatch.setattr(worker, "SessionLocal", session_factory)
    monkeypatch.setitem(worker.HANDLERS, "noop", lambda db, j: worker.Done({"ok": True}))
    monkeypatch.setattr(worker, "PERIODIC", [])
    real_run_job = worker.run_job
    monkeypatch.setattr(worker, "run_job", lambda job_id: real_run_job(job_id, session_factory=session_factory))
    stop = threading.Event()
    thread = worker.start_background(stop)
    deadline = time.time() + 5
    status = None
    while time.time() < deadline:
        with session_factory() as db:
            status = db.get(Job, job.id).status
        if status == "done":
            break
        time.sleep(0.05)
    stop.set()
    thread.join(timeout=5)
    assert status == "done"


def test_artifact_ownership(client, auth, db_session):
    other = Artifact(workspace_id=uuid.uuid4(), type="summary", status="ready", content_json={})
    db_session.add(other)
    db_session.commit()
    assert client.get(f"/api/artifacts/{other.id}", headers=auth).status_code == 404


# Voice pipeline (ElevenLabs stubbed)


def saved_voices(db_session) -> dict[str, str]:
    """The workspace's voices (the one list for audio and video): voice id -> name."""
    db_session.expire_all()
    return {v.voice_id: v.name for v in db_session.query(UserSavedVoice)}


def test_voice_library_preview_and_script(client, auth, monkeypatch, feed, run_jobs, db_session):
    from app.config import settings
    from app.services import tts

    monkeypatch.setattr(settings, "elevenlabs_api_key", "test")
    monkeypatch.setattr(tts, "search_library", lambda **kw: {"voices": [{
        "public_owner_id": "owner-1", "voice_id": "lib-voice-1",
                                                                          "name": "Narrator"}], "has_more": False})
    monkeypatch.setattr(tts, "add_library_voice", lambda owner, vid, name: "added-" + vid)
    monkeypatch.setattr(tts, "synthesize", lambda ws, text, voice, vs=None, *a: b"\x00" * 8000)

    assert client.get("/api/voice/library", params={"gender": "female"}, headers=auth).json()["voices"][0]["name"] == \
        "Narrator"
    r = client.post("/api/voice/library/add", json={
        "public_owner_id": "owner-1", "voice_id": "lib-voice-1", "name": "Narrator",
                                                    "use_as": "host_b"}, headers=auth).json()
    assert r["voice_id"] == "added-lib-voice-1" and r["host_voices"]["host_b"] == "added-lib-voice-1"
    assert saved_voices(db_session) == {"added-lib-voice-1": "Narrator"}  # added, so saved

    prev = client.post("/api/voice/preview", json={"voice_id": "added-lib-voice-1", "text": "Hello there",
                                                   "delivery": {"stability": 0.3, "similarity_boost": 0.8,
                                                                "style": 0, "speed": 0.9}}, headers=auth).json()
    assert prev["seconds"] == 0.5 and client.get(prev["url"].split("8000", 1)[1]).status_code == 200

    connect(client, auth, run_jobs)
    script = client.get("/api/voice/reading-script", headers=auth).json()
    assert script["words"] > 5 and script["title"]


def test_voice_clone_multi_sample_sets_host_and_preview(client, auth, monkeypatch, run_jobs, db_session):
    from app.config import settings
    from app.services import tts

    monkeypatch.setattr(settings, "elevenlabs_api_key", "test")
    sent = {}

    def fake_clone(name, samples, remove_background_noise=True, description=""):
        sent.update(n=len(samples), noise=remove_background_noise, name=name)
        return "clone-1"

    monkeypatch.setattr(tts, "clone_voice", fake_clone)
    monkeypatch.setattr(tts, "synthesize", lambda ws, text, voice, vs=None, *a: b"\x00" * 16000)
    ids = []
    for i in range(2):
        start = client.post("/api/storage/uploads", json={"filename": f"take{i}.webm", "content_type": "audio/webm",
                                                          "size_bytes": 4}, headers=auth).json()
        client.put(start["upload_url"].split("8000", 1)[1], content=b"RIFF")
        client.post(f"/api/storage/uploads/{start['upload_id']}/complete", headers=auth)
        ids.append(start["upload_id"])
    consent_text = client.get("/api/voice", headers=auth).json()["clone"]["consent_text"]
    r = client.post("/api/voice/consent", json={"upload_ids": ids, "agreed": True, "consent_text": consent_text,
                                                "remove_background_noise": False}, headers=auth)
    assert r.status_code == 200, r.text
    assert run_jobs()[0].status == "done"
    assert sent == {"n": 2, "noise": False, "name": "Ada Lovelace (Notestack)"}
    voice = client.get("/api/voice", headers=auth).json()
    assert voice["clone"]["status"] == "ready" and voice["host_voices"]["host_a"] == "clone-1"
    assert voice["clone"]["preview_url"]
    assert saved_voices(db_session) == {"clone-1": "My voice"}


def test_a_designed_voice_is_saved_to_the_voices(client, auth, monkeypatch, db_session):
    from app.config import settings
    from app.services import tts

    monkeypatch.setattr(settings, "elevenlabs_api_key", "test")
    monkeypatch.setattr(tts, "create_designed_voice", lambda name, description, generated: "designed-1")
    r = client.post("/api/voice/design/save", json={"generated_voice_id": "gen-12345", "name": "Narrator",
                                                    "description": "A calm narrator"}, headers=auth)
    assert r.status_code == 200 and r.json()["voice_id"] == "designed-1"
    assert saved_voices(db_session) == {"designed-1": "Narrator"}
    client.post("/api/voice/design/save", json={"generated_voice_id": "gen-12345", "name": "Narrator"}, headers=auth)
    assert len(saved_voices(db_session)) == 1  # saved once


def test_audio_overview_hosts_are_picked_from_the_voices(client, auth, run_jobs, feed, llm, monkeypatch,
                                                         db_session):
    from app.config import settings
    from app.services import tts

    connect(client, auth, run_jobs)
    doc = docs(client, auth)[0]
    monkeypatch.setattr(settings, "elevenlabs_api_key", "test")
    used = []
    monkeypatch.setattr(tts, "synthesize", lambda ws, text, voice, vs=None, *a: used.append((text, voice)) or
                        b"\x00" * 16000)
    llm["PodcastScript"] = {"lines": [{"speaker": "host_a", "text": "Welcome in.", "sources": []},
                                      {"speaker": "host_b", "text": "Thanks.", "sources": []}]}
    ws_id = db_session.get(Document, uuid.UUID(doc["id"])).workspace_id
    db_session.add_all([UserSavedVoice(workspace_id=ws_id, voice_id=v, name=v) for v in ("mine-1", "mine-2")])
    db_session.commit()
    body = {"type": "audio_overview", "document_id": doc["id"], "minutes": 3}
    art = client.post("/api/artifacts/generate", json={**body, "host_a": "mine-2", "host_b": "mine-1"},
                      headers=auth).json()
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert done["content"]["voices"] == {"host_a": "mine-2", "host_b": "mine-1"}
    assert dict(used) == {"Welcome in.": "mine-2", "Thanks.": "mine-1"}
    # Only the workspace's own voices (or the defaults).
    r = client.post("/api/artifacts/generate", json={**body, "host_a": "someone-elses"}, headers=auth)
    assert r.status_code == 400
    # None picked: the defaults, as before.
    art = client.post("/api/artifacts/generate", json=body, headers=auth).json()
    run_jobs()
    voices = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()["content"]["voices"]
    assert voices == {"host_a": settings.elevenlabs_voice_a, "host_b": settings.elevenlabs_voice_b}


def test_tts_retries_rate_limits(monkeypatch):
    from app.config import settings
    from app.services import tts

    monkeypatch.setattr(settings, "elevenlabs_api_key", "test")
    monkeypatch.setattr(tts.time, "sleep", lambda s: None)
    responses = [httpx.Response(429, json={"detail": "slow down"}), httpx.Response(200, content=b"mp3")]
    monkeypatch.setattr(httpx, "request", lambda *a, **k: responses.pop(0))
    assert tts._request("POST", "/text-to-speech/x").content == b"mp3"
    monkeypatch.setattr(httpx, "request", lambda *a, **k: httpx.Response(401, json={"detail": {"message": "bad"}}))
    with pytest.raises(tts.TTSError, match="API key"):
        tts._request("GET", "/voices")


# Chat: memory and triage (no LLM calls for chatter)


def _no_research(monkeypatch):
    import dspy

    def boom(*a, **k):
        raise AssertionError("research agent should not run")

    monkeypatch.setattr(dspy, "ReAct", boom)


def test_small_talk_needs_no_model(monkeypatch, tmp_path):
    from app.corpus import Corpus
    from app.pipeline import research as r

    _no_research(monkeypatch)
    monkeypatch.setattr(r, "triage", lambda *a: (_ for _ in ()).throw(AssertionError("no triage for chatter")))
    out = r.research(Corpus(uuid.uuid4(), cache_dir=str(tmp_path)), {"a.md": "On Pricing"}, "thanks!",
                     history=[r.Turn("user", "q"), r.Turn("assistant", "a")])
    assert out.kind == "chitchat" and "helped" in out.text and out.prompt_tokens == 0


def test_jev_triage_routes_off_topic_without_llm(monkeypatch, tmp_path):
    from app.config import settings
    from app.corpus import Corpus
    from app.pipeline import research as r
    from app.services import jev

    _no_research(monkeypatch)
    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    seen = {}

    def decide(state, questions, timeout=6.0):
        seen.update(state=state, questions=questions)
        return {"intent": jev.Choice("off_topic", 0.93, {}), "depth": jev.Choice("quick", 0.8, {})}

    monkeypatch.setattr(jev, "decide", decide)
    monkeypatch.setattr(r, "triage_llm", lambda *a: (_ for _ in ()).throw(AssertionError("LLM triage not needed")))
    out = r.research(Corpus(uuid.uuid4(), cache_dir=str(tmp_path)), {"a.md": "On Pricing"},
                     "Write me a python script", history=[r.Turn("user", "What did I say about pricing?")])
    assert out.kind == "off_topic" and "On Pricing" in out.text
    assert seen["questions"]["intent"]["criteria"]["archive"]
    assert "pricing" in seen["state"]["conversation"]


def test_jev_low_confidence_or_failure_still_researches(monkeypatch, tmp_path):
    from app.config import settings
    from app.pipeline import research as r
    from app.services import jev

    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    monkeypatch.setattr(jev, "decide", lambda *a, **k: {"intent": jev.Choice("off_topic", 0.4, {}),
                                                         "depth": jev.Choice("deep", 0.9, {})})
    assert r.triage("hmm what about that", [], "nb").kind == "archive"

    def down(*a, **k):
        raise jev.JevError("down")

    monkeypatch.setattr(jev, "decide", down)
    monkeypatch.setattr(r, "triage_llm", lambda *a: r.Triage("archive", "standalone q", "quick", ""))
    t = r.triage("tell me more", [], "nb")
    assert t.question == "standalone q" and t.depth == "quick"


def test_jev_request_shape(monkeypatch):
    from app.config import settings
    from app.services import jev

    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    captured = {}

    def post(url, json, timeout, headers):
        captured.update(url=url, body=json, headers=headers)
        return httpx.Response(200, json={"answers": {"intent": {"type": "choice", "choice": "archive",
                                                                "confidence": 0.9,
                                                                "probabilities": {"archive": 0.9}}}})

    monkeypatch.setattr(httpx, "post", post)
    out = jev.decide("state", {"intent": {"instructions": "?", "criteria": {"archive": "x"}}})
    assert out["intent"].choice == "archive"
    assert captured["url"].endswith("/v1/systemone") and captured["headers"]["Authorization"] == "Bearer sk-test"
    assert captured["body"]["questions"]["intent"]["type"] == "choice" and captured["body"]["model"] == "jev-latest"


def test_chat_passes_history_as_memory(client, auth, run_jobs, feed, monkeypatch):
    from app.pipeline.research import ResearchResult
    from app.routers import notebooks as nbr

    connect(client, auth, run_jobs)
    doc = docs(client, auth)[0]
    nb = client.post("/api/notebooks", json={"title": "N", "document_ids": [doc["id"]]}, headers=auth).json()
    calls = []

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile=""):
        calls.append((question, [(t.role, t.text) for t in history or []], notebook_title))
        return ResearchResult(f"answer to {question}", False, [])

    monkeypatch.setattr(nbr, "research", fake_research)

    def ask(q, chat_id=None):
        body = client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": q, "chat_id": chat_id},
                           headers=auth).text
        import json as _json
        import re as _re
        return _json.loads(_re.search(r"event: status\ndata: (.*)", body).group(1))["chat_id"]

    chat_id = ask("What did I say about pricing?")
    ask("Why?", chat_id)
    assert calls[0][1] == [] and calls[0][2] == "N"
    assert calls[1][1] == [("user", "What did I say about pricing?"),
                           ("assistant", "answer to What did I say about pricing?")]


def _memory_chat(client, auth, run_jobs, monkeypatch, kind="archive", key="x"):
    """Connect a blog, make a notebook, turn the memory job on, and ask one question with research faked."""
    from app.config import settings
    from app.pipeline.research import ResearchResult
    from app.routers import notebooks as nbr

    connect(client, auth, run_jobs)
    doc = docs(client, auth)[0]
    nb = client.post("/api/notebooks", json={"title": "N", "document_ids": [doc["id"]]}, headers=auth).json()
    monkeypatch.setattr(settings, "llm_api_key", key)  # after connect, so no import follow up jobs are queued
    monkeypatch.setattr(settings, "memory_notice_wait_seconds", 0)
    seen = []

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile=""):
        seen.append(profile)
        return ResearchResult("ok", False, [], kind=kind)

    monkeypatch.setattr(nbr, "research", fake_research)
    return nb, seen


def test_chat_passes_saved_notes_to_research(client, auth, run_jobs, feed, monkeypatch):
    nb, seen = _memory_chat(client, auth, run_jobs, monkeypatch)
    client.put("/api/memory/audience", json={"value": "indie founders"}, headers=auth)
    client.put("/api/memory/tone", json={"value": "short answers"}, headers=auth)
    other = client.post("/api/notebooks", json={"title": "Other"}, headers=auth).json()
    for notebook in (nb, other):  # the same notes reach every notebook in the workspace
        client.post(f"/api/notebooks/{notebook['id']}/chat", json={"question": "Why?"}, headers=auth)
    assert all("- audience: indie founders" in p and "- tone: short answers" in p for p in seen) and len(seen) == 2


def test_memory_job_saves_notes_from_a_chat_message(client, auth, run_jobs, feed, llm, monkeypatch):
    nb, _ = _memory_chat(client, auth, run_jobs, monkeypatch)
    llm["UpdateMemory"] = {"operations": [{"op": "add", "key": "audience", "value": "indie founders"}]}
    client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "I write for indie founders"}, headers=auth)
    jobs = run_jobs()
    assert [j.kind for j in jobs] == ["memory_update"] and jobs[0].status == "done"
    assert jobs[0].result["saved"] == [{"op": "add", "key": "audience", "value": "indie founders"}]
    items = client.get("/api/memory", headers=auth).json()["items"]
    assert [(i["key"], i["source"]) for i in items] == [("audience", "auto")]


def test_memory_job_only_reads_the_writers_message(client, auth, run_jobs, feed, llm, monkeypatch):
    nb, _ = _memory_chat(client, auth, run_jobs, monkeypatch)
    seen = {}

    def extract(**inputs):
        seen.update(inputs)
        return {"operations": []}

    llm["UpdateMemory"] = extract
    client.put("/api/memory/tone", json={"value": "short answers"}, headers=auth)
    client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "What did I say about pricing?"}, headers=auth)
    run_jobs()
    assert seen["message"] == "What did I say about pricing?"
    assert seen["saved_notes"] == "- tone: short answers"


def test_memory_job_skips_the_llm_when_jev_sees_nothing_lasting(client, auth, run_jobs, feed, llm, monkeypatch):
    from app.config import settings
    from app.services import jev

    nb, _ = _memory_chat(client, auth, run_jobs, monkeypatch)
    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    asked = {}

    def decide(state, questions, timeout=6.0):
        asked.update(state=state, questions=questions)
        return {"remember": jev.Choice("no", 0.9, {})}

    monkeypatch.setattr(jev, "decide", decide)
    client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "What did I say about pricing?"}, headers=auth)
    jobs = run_jobs()
    assert jobs[0].result == {"saved": [], "skipped": "nothing lasting"}
    assert "UpdateMemory" not in llm["_calls"]
    assert asked["state"] == {"message": "What did I say about pricing?"}
    assert "yes" in asked["questions"]["remember"]["criteria"]

    # A shaky "no" is not trusted: the LLM decides.
    monkeypatch.setattr(jev, "decide", lambda *a, **k: {"remember": jev.Choice("no", 0.3, {})})
    llm["UpdateMemory"] = {"operations": []}
    client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "I like short answers"}, headers=auth)
    run_jobs()
    assert "UpdateMemory" in llm["_calls"]


def test_no_memory_job_for_small_talk_or_without_an_llm_key(client, auth, run_jobs, feed, monkeypatch, db_session):
    from app.models import Job

    nb, _ = _memory_chat(client, auth, run_jobs, monkeypatch, kind="chitchat")
    client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "thanks!"}, headers=auth)
    assert db_session.query(Job).filter_by(kind="memory_update").count() == 0

    nb, _ = _memory_chat(client, auth, run_jobs, monkeypatch, key="")
    client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "I write for founders"}, headers=auth)
    assert db_session.query(Job).filter_by(kind="memory_update").count() == 0


def test_chat_stream_says_what_was_saved(client, auth, run_jobs, feed, monkeypatch):
    from app.routers import notebooks as nbr

    nb, _ = _memory_chat(client, auth, run_jobs, monkeypatch)

    async def learned(*a, **k):
        return [{"op": "add", "key": "audience", "value": "indie founders"}]

    monkeypatch.setattr(nbr, "_learn", learned)
    body = client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "I write for founders"}, headers=auth).text
    assert body.index("event: answer") < body.index("event: memory") < body.index("event: done")
    assert '"key": "audience"' in body


def test_mind_map_tree_is_capped_and_sources_verified(client, auth, run_jobs, feed, llm):
    connect(client, auth, run_jobs)
    pricing = next(d for d in docs(client, auth) if d["title"] == "On Pricing")
    nb = client.post("/api/notebooks", json={"title": "Money", "document_ids": [pricing["id"]]}, headers=auth).json()
    good = {"path": pricing["path"], "line_start": 12, "line_end": 14}
    fake = {"path": "sources/fake.md", "line_start": 1, "line_end": 2}
    detail = {"label": "Raise slowly", "note": "Small steps.", "sources": [good, fake]}
    llm["ExtractIdeas"] = {"ideas": [{"label": f"Idea {i}", "note": "n", "sources": [good], "details": [detail] * 6}
                                     for i in range(8)]}
    llm["ArrangeMindMap"] = {"centre": "Pricing", "overview": "How prices change.", "branches": [
        {"label": f"Theme {i}", "note": "n", "ideas": [f"0.{i}"]} for i in range(8)]}
    art = client.post("/api/artifacts/generate", json={"type": "mind_map", "notebook_id": nb["id"],
                      "document_ids": [pricing["id"]], "focus": "pricing"}, headers=auth).json()
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert done["status"] == "ready" and done["type_label"] == "Mind Constellation"
    root = done["content"]["root"]
    assert len(root["children"]) == 8  # one branch per stored idea, under the cap of 10
    leaf = root["children"][0]["children"][0]["children"]
    assert len(leaf) == 4 and len(leaf[0]["sources"]) == 1  # the invented source was dropped
    assert done["content"]["node_count"] == 1 + 8 * (1 + 1 + 4)


def test_mind_map_reuses_stored_ideas_instead_of_rereading_posts(client, auth, run_jobs, feed, llm):
    connect(client, auth, run_jobs)
    pricing = next(d for d in docs(client, auth) if d["title"] == "On Pricing")
    nb = client.post("/api/notebooks", json={"title": "Money", "document_ids": [pricing["id"]]}, headers=auth).json()
    ref = {"path": pricing["path"], "line_start": 1, "line_end": 3}
    llm["ExtractIdeas"] = {"ideas": [{"label": "Raise slowly", "note": "n", "sources": [ref], "details": []}]}
    llm["ArrangeMindMap"] = {"centre": "Pricing", "overview": "x", "branches": [
        {"label": "Theme", "note": "n", "ideas": ["0.0"]}]}
    for focus in ("pricing", "trust"):
        client.post("/api/artifacts/generate", json={"type": "mind_map", "notebook_id": nb["id"], "focus": focus},
                    headers=auth)
        run_jobs()
    assert llm["_calls"].count("ExtractIdeas") == 1  # read once, arranged twice
    assert llm["_calls"].count("ArrangeMindMap") == 2


def test_extract_ideas_job_stores_ideas_on_the_post(client, auth, run_jobs, feed, llm, db_session):
    from app.models import Document
    from app.pipeline.generate import extract_ideas, ideas_fresh

    connect(client, auth, run_jobs)
    doc = db_session.get(Document, uuid.UUID(docs(client, auth)[0]["id"]))
    ref = {"path": doc.path, "line_start": 1, "line_end": 3}
    llm["ExtractIdeas"] = {"ideas": [{"label": "An idea", "note": "n", "sources": [ref], "details": []}]}
    assert not ideas_fresh(doc)
    assert extract_ideas(db_session, None, doc.workspace_id, [str(doc.id)])["extracted"] == 1
    db_session.refresh(doc)
    assert ideas_fresh(doc) and doc.metadata_json["ideas"][0]["sources"] == [ref]
    extract_ideas(db_session, None, doc.workspace_id, [str(doc.id)])
    assert llm["_calls"].count("ExtractIdeas") == 1  # current ideas are not re-extracted


def _two_post_notebook(client, auth, run_jobs):
    connect(client, auth, run_jobs)
    items = docs(client, auth)
    a, b = items[0], items[1]
    nb = client.post("/api/notebooks", json={"title": "Two", "document_ids": [a["id"], b["id"]]},
                     headers=auth).json()
    return a, b, nb


def _cited_docs(content):
    found = set()

    def walk(n):
        found.update(s["document_id"] for s in n["sources"])
        for c in n["children"]:
            walk(c)

    walk(content["root"])
    return found


def test_mind_map_files_ideas_the_model_left_out_so_no_post_is_dropped(client, auth, run_jobs, feed, llm):
    a, b, nb = _two_post_notebook(client, auth, run_jobs)

    def ideas(title, **inputs):
        path = a["path"] if title == a["title"] else b["path"]
        return {"ideas": [{"label": f"{title} idea", "note": "n", "details": [],
                           "sources": [{"path": path, "line_start": 1, "line_end": 3}]}]}

    llm["ExtractIdeas"] = ideas
    # the model only places the first post's idea
    llm["ArrangeMindMap"] = {"centre": "Both", "overview": "x", "branches": [
        {"label": "Theme", "note": "n", "ideas": ["0.0", "9.9"]}]}
    art = client.post("/api/artifacts/generate", json={"type": "mind_map", "notebook_id": nb["id"],
                      "focus": "only the first"}, headers=auth).json()
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert done["status"] == "ready"
    assert _cited_docs(done["content"]) == {a["id"], b["id"]}
    assert done["content"]["covered_count"] == 2
    assert done["content"]["root"]["children"][-1]["label"] == "More from your posts"


def test_mind_map_falls_back_to_opening_lines_when_extraction_fails(client, auth, run_jobs, feed, llm):
    a, b, nb = _two_post_notebook(client, auth, run_jobs)

    def ideas(title, **inputs):
        if title == b["title"]:
            raise RuntimeError("model down")
        return {"ideas": [{"label": "Idea", "note": "n", "details": [],
                           "sources": [{"path": a["path"], "line_start": 1, "line_end": 3}]}]}

    llm["ExtractIdeas"] = ideas
    llm["ArrangeMindMap"] = {"centre": "Both", "overview": "x", "branches": []}
    art = client.post("/api/artifacts/generate", json={"type": "mind_map", "notebook_id": nb["id"]},
                      headers=auth).json()
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert _cited_docs(done["content"]) == {a["id"], b["id"]}


def test_thumbs_feedback_is_saved_with_the_recall_trace(client, auth, run_jobs, feed, monkeypatch, db_session):
    import json as _json
    import re as _re

    from app.models import MessageFeedback
    from app.pipeline.research import ResearchResult
    from app.routers import notebooks as nbr

    connect(client, auth, run_jobs)
    doc = docs(client, auth)[0]
    nb = client.post("/api/notebooks", json={"title": "N", "document_ids": [doc["id"]]}, headers=auth).json()

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **_):
        return ResearchResult("The answer", False, [], steps=[("search", "pricing")],
                              recall={"route": {"memory": "lookup", "topic": "pricing"}, "memory_notes": "earlier: x"})

    monkeypatch.setattr(nbr, "research", fake_research)
    body = client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "What about pricing?"}, headers=auth).text
    chat_id = _json.loads(_re.search(r"event: status\ndata: (.*)", body).group(1))["chat_id"]
    msg_id = _json.loads(_re.search(r"event: answer\ndata: (.*)", body).group(1))["message_id"]

    url = f"/api/notebooks/messages/{msg_id}/feedback"
    down = client.put(url, json={"rating": "down", "reasons": ["forgot_chat", "nonsense"], "comment": " lost the thread "},
                      headers=auth).json()["feedback"]
    assert down == {"rating": "down", "reasons": ["forgot_chat"], "comment": "lost the thread"}  # unknown tag dropped

    client.put(url, json={"rating": "up"}, headers=auth)  # rating again replaces, it does not add a second row
    assert db_session.query(MessageFeedback).count() == 1
    client.put(url, json={"rating": "down", "reasons": ["wrong"]}, headers=auth)

    shown = client.get(f"/api/notebooks/chats/{chat_id}/messages", headers=auth).json()
    assert shown[-1]["feedback"]["rating"] == "down" and shown[0]["feedback"] is None

    rows = client.get("/api/notebooks/feedback/export?rating=down", headers=auth).json()
    assert len(rows) == 1
    r = rows[0]
    assert r["question"] == "What about pricing?" and r["answer"] == "The answer" and r["reasons"] == ["wrong"]
    assert r["recall"]["route"]["memory"] == "lookup" and r["recall"]["steps"] == [{"kind": "search", "detail": "pricing"}]
    assert client.get("/api/notebooks/feedback/export?rating=up", headers=auth).json() == []

    assert client.put(url, json={"rating": None}, headers=auth).json() == {"feedback": None}
    assert client.get("/api/notebooks/feedback/export", headers=auth).json() == []
    user_msg = shown[0]["id"]
    assert client.put(f"/api/notebooks/messages/{user_msg}/feedback", json={"rating": "up"}, headers=auth).status_code == 404


def _quiz_output(path):
    ref = {"path": path, "line_start": 1, "line_end": 3}
    fake = {"path": "sources/fake.md", "line_start": 1, "line_end": 2}
    return {"questions": [
        {"type": "multiple_choice", "question": "Q1?", "options": ["a", "b", "c"], "correct": [1, 2],
         "explanation": "e", "sources": [ref, fake]},
        {"type": "multiple_select", "question": "Q2?", "options": ["a", "b", "c"], "correct": [0], "explanation": "e"},
        {"type": "fill_blank", "question": "The answer is", "answer": "x", "accepted": ["y"], "explanation": "e"},
        {"type": "short_answer", "question": "Why?", "answer": "Because.", "explanation": "e"},
        {"type": "multiple_choice", "question": "No right option", "options": ["a", "b"], "correct": [9],
         "explanation": "e"},
    ]}


def test_quiz_from_posts_keeps_only_playable_questions_and_real_sources(client, auth, run_jobs, feed, llm):
    connect(client, auth, run_jobs)
    pricing = next(d for d in docs(client, auth) if d["title"] == "On Pricing")
    nb = client.post("/api/notebooks", json={"title": "Money", "document_ids": [pricing["id"]]}, headers=auth).json()
    llm["GenerateQuiz"] = _quiz_output(pricing["path"])
    art = client.post("/api/artifacts/generate", json={
        "type": "quiz", "notebook_id": nb["id"], "document_ids": [pricing["id"]], "difficulty": "hard",
        "question_types": ["multiple_choice", "multiple_select", "fill_blank", "short_answer"]}, headers=auth).json()
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert done["status"] == "ready" and done["type_label"] == "Quiz"
    qs = done["content"]["questions"]
    assert [q["type"] for q in qs] == ["multiple_choice", "multiple_choice", "fill_blank", "short_answer"]
    assert qs[0]["correct"] == [1] and len(qs[0]["sources"]) == 1  # one right answer; the invented source is gone
    assert qs[1]["correct"] == [0]  # a multiple select with one right answer is asked as a multiple choice
    assert qs[2]["question"].count("____") == 1 and qs[2]["accepted"] == ["y"]
    assert done["content"]["question_count"] == 4 and done["content"]["source"]["kind"] == "posts"


def test_quiz_from_a_chat_belongs_to_the_chats_notebook(client, auth, run_jobs, feed, llm, db_session):
    from app.models import Chat, Message, Notebook

    connect(client, auth, run_jobs)
    pricing = next(d for d in docs(client, auth) if d["title"] == "On Pricing")
    nb = client.post("/api/notebooks", json={"title": "Money", "document_ids": [pricing["id"]]}, headers=auth).json()
    row = db_session.get(Notebook, uuid.UUID(nb["id"]))
    chat = Chat(workspace_id=row.workspace_id, notebook_id=row.id, title="Pricing chat")
    db_session.add(chat)
    db_session.flush()
    db_session.add_all([Message(chat_id=chat.id, role="user", content="How should I price?"),
                        Message(chat_id=chat.id, role="assistant", content="Raise slowly [1].")])
    db_session.commit()
    llm["GenerateQuiz"] = _quiz_output(pricing["path"])
    art = client.post("/api/artifacts/generate", json={"type": "quiz", "chat_ids": [str(chat.id)]},
                      headers=auth).json()
    assert art["notebook_id"] == nb["id"]
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert done["status"] == "ready" and done["content"]["source"]["kind"] == "chats"
    assert all(q["sources"] == [] for q in done["content"]["questions"])  # a chat has no lines to cite
    missing = client.post("/api/artifacts/generate", json={"type": "quiz", "chat_ids": [str(uuid.uuid4())]},
                          headers=auth)
    assert missing.status_code == 404


def _notebook_with_pricing(client, auth, run_jobs):
    connect(client, auth, run_jobs)
    pricing = next(d for d in docs(client, auth) if d["title"] == "On Pricing")
    nb = client.post("/api/notebooks", json={"title": "Money", "document_ids": [pricing["id"]]}, headers=auth).json()
    return pricing, nb


def test_flashcards_drop_repeats_empties_and_invented_sources(client, auth, run_jobs, feed, llm):
    pricing, nb = _notebook_with_pricing(client, auth, run_jobs)
    good = {"path": pricing["path"], "line_start": 1, "line_end": 3}
    fake = {"path": "sources/fake.md", "line_start": 1, "line_end": 2}
    llm["GenerateFlashcards"] = {"cards": [
        {"front": "Raise slowly?", "back": "Yes.", "sources": [good, fake]},
        {"front": "raise slowly?", "back": "Repeat.", "sources": []},
        {"front": "No back", "back": "", "sources": []},
    ]}
    art = client.post("/api/artifacts/generate", json={"type": "flashcards", "notebook_id": nb["id"],
                      "document_ids": [pricing["id"]], "count": "fewer"}, headers=auth).json()
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert done["status"] == "ready" and done["type_label"] == "Flashcards"
    cards = done["content"]["cards"]
    assert len(cards) == 1 and len(cards[0]["sources"]) == 1


def _make_report(client, auth, run_jobs, llm, pricing, nb):
    good = {"path": pricing["path"], "line_start": 1, "line_end": 3}
    fake = {"path": "sources/fake.md", "line_start": 1, "line_end": 2}
    llm["WriteReport"] = {"report_title": "Pricing Brief", "markdown": "## One\nFirst point [1].\n\n## Two\nSecond [2].",
                          "citations": [{"marker": 1, **good}, {"marker": 2, **fake}]}
    llm["SuggestEmbeds"] = {"suggestions": [
        {"after_block_id": "b1", "kind": "flashcards", "brief": "Terms", "why": "Learn them"},
        {"after_block_id": "nope", "kind": "quiz", "brief": "x", "why": "y"},
        {"after_block_id": "b2", "kind": "mind_map", "brief": "Links", "why": "See them"}]}
    art = client.post("/api/artifacts/generate", json={
        "type": "report", "notebook_id": nb["id"], "document_ids": [pricing["id"]], "report_format": "document",
        "template_id": "briefing", "instructions": "Write a brief."}, headers=auth).json()
    run_jobs()
    return client.get(f"/api/artifacts/{art['id']}", headers=auth).json()


def test_document_report_is_blocks_with_checked_citations_and_suggestions(client, auth, run_jobs, feed, llm):
    pricing, nb = _notebook_with_pricing(client, auth, run_jobs)
    done = _make_report(client, auth, run_jobs, llm, pricing, nb)
    c = done["content"]
    assert done["status"] == "ready" and done["type_label"] == "Report" and c["format"] == "document"
    assert [b["type"] for b in c["blocks"]] == ["prose", "prose"] and c["blocks"][0]["id"] == "b1"
    assert len(c["citations"]) == 1 and "[2]" not in c["blocks"][1]["text"]  # the invented source was dropped
    assert [s["after_block_id"] for s in c["suggestions"]] == ["b1", "b2"]  # the unknown section was dropped
    assert c["sources"][0]["title"] == "On Pricing"


def test_add_and_remove_a_suggested_visual(client, auth, run_jobs, feed, llm):
    pricing, nb = _notebook_with_pricing(client, auth, run_jobs)
    done = _make_report(client, auth, run_jobs, llm, pricing, nb)
    llm["GenerateFlashcards"] = {"cards": [{"front": "Term", "back": "Meaning", "sources": []}]}
    r = client.post(f"/api/reports/{done['id']}/blocks", json={
        "kind": "flashcards", "after_block_id": "b1", "suggestion_id": "s1", "brief": "Terms"}, headers=auth)
    assert r.status_code == 200, r.text
    run_jobs()
    c = client.get(f"/api/artifacts/{done['id']}", headers=auth).json()["content"]
    assert [b["type"] for b in c["blocks"]] == ["prose", "flashcards", "prose"]
    assert c["blocks"][1]["after"] == "b1" and [s["id"] for s in c["suggestions"]] == ["s2"]
    added = c["blocks"][1]["id"]
    assert client.delete(f"/api/reports/{done['id']}/blocks/b1", headers=auth).status_code == 404  # prose stays
    assert client.delete(f"/api/reports/{done['id']}/blocks/{added}", headers=auth).status_code == 200
    # a kind of visual the report does not know is refused
    assert client.post(f"/api/reports/{done['id']}/blocks", json={"kind": "poem"}, headers=auth).status_code == 422


def test_shared_report_shows_only_the_whitelist_and_can_be_revoked(client, auth, run_jobs, feed, llm):
    import json

    pricing, nb = _notebook_with_pricing(client, auth, run_jobs)
    done = _make_report(client, auth, run_jobs, llm, pricing, nb)
    share = client.post(f"/api/artifacts/{done['id']}/share", headers=auth).json()
    assert share["shared"] and "/r/" in share["url"]
    token = share["url"].rsplit("/", 1)[1]
    public = client.get(f"/api/public/reports/{token}")  # no auth header
    assert public.status_code == 200 and public.headers["x-robots-tag"].startswith("noindex")
    body = public.json()
    raw = json.dumps(body)
    assert body["title"] == "Pricing Brief" and "[1]" not in raw
    for leak in (pricing["path"], pricing["id"], '"quote"', '"span"', '"suggestions"', "Write a brief.",
                 str(done["id"]), '"citations"'):
        assert leak not in raw
    assert body["sources"]["posts"][0]["title"] == "On Pricing"
    client.patch(f"/api/artifacts/{done['id']}/share", json={"show_sources": False}, headers=auth)
    assert "sources" not in client.get(f"/api/public/reports/{token}").json()
    client.patch("/api/settings", json={"allow_public_links": False}, headers=auth)
    assert client.get(f"/api/public/reports/{token}").status_code == 404  # the workspace switch ends every link
    assert client.post(f"/api/artifacts/{done['id']}/share", headers=auth).status_code == 403
    client.patch("/api/settings", json={"allow_public_links": True}, headers=auth)
    assert client.delete(f"/api/artifacts/{done['id']}/share", headers=auth).json()["shared"] is False
    assert client.get(f"/api/public/reports/{token}").status_code == 404
    assert client.get("/api/public/reports/not-a-token").status_code == 404


def test_interactive_report_only_suggests_visuals_until_the_reader_adds_them(client, auth, run_jobs, feed, llm,
                                                                              monkeypatch):
    from app.llm import run

    pricing, nb = _notebook_with_pricing(client, auth, run_jobs)
    good = {"path": pricing["path"], "line_start": 1, "line_end": 3}
    llm["PlanInteractiveReport"] = {"report_title": "Pricing, Visually", "sections": [
        {"heading": "Why price", "brief": "b",
         "embed": {"kind": "flashcards", "title": "Terms", "brief": "terms", "why": "Learn them"}},
        {"heading": "How to raise", "brief": "b",
         "embed": {"kind": "flashcards", "title": "Again", "brief": "x", "why": "dup"}},
        {"heading": "Compare", "brief": "b",
         "embed": {"kind": "table", "title": "Options", "brief": "options", "why": "Not a kind we offer"}}]}
    monkeypatch.setattr(run, "predict_many", lambda sig, inputs, **kw: [
        {"markdown": f"Body {i} [1].", "citations": [{"marker": 1, **good}]} for i, _ in enumerate(inputs)])
    art = client.post("/api/artifacts/generate", json={
        "type": "report", "notebook_id": nb["id"], "document_ids": [pricing["id"]], "report_format": "interactive",
        "instructions": "Make it interactive."}, headers=auth).json()
    run_jobs()
    c = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()["content"]
    assert c["format"] == "interactive"
    assert [b["type"] for b in c["blocks"]] == ["prose", "prose", "prose"]  # nothing is built until the reader asks
    assert [(s["after_block_id"], s["kind"]) for s in c["suggestions"]] == [("b1", "flashcards")]  # a table is not a visual we offer
    assert "GenerateFlashcards" not in llm["_calls"]
    assert [x["marker"] for x in c["citations"]] == [1, 2, 3] and "[3]" in c["blocks"][2]["text"]  # renumbered

    r = client.post(f"/api/reports/{art['id']}/blocks", json={
        "kind": "table", "after_block_id": "b3", "brief": "options"}, headers=auth)
    assert r.status_code == 422  # only a mind map, flashcards, a quiz or an infographic can be added

    llm["PlanInteractiveReport"] = {"report_title": "x", "sections": []}  # an unusable plan
    llm["WriteReport"] = {"report_title": "Plain", "markdown": "## A\nText.\n\n## B\nMore.", "citations": []}
    art2 = client.post("/api/artifacts/generate", json={
        "type": "report", "notebook_id": nb["id"], "document_ids": [pricing["id"]], "report_format": "interactive"},
        headers=auth).json()
    run_jobs()
    done = client.get(f"/api/artifacts/{art2['id']}", headers=auth).json()
    assert done["status"] == "ready" and done["content"]["format"] == "document"


def test_quiz_can_be_made_from_posts_and_chats_together(client, auth, run_jobs, feed, llm, db_session):
    from app.models import Chat, Message, Notebook

    pricing, nb = _notebook_with_pricing(client, auth, run_jobs)
    row = db_session.get(Notebook, uuid.UUID(nb["id"]))
    chat = Chat(workspace_id=row.workspace_id, notebook_id=row.id, title="Pricing chat")
    db_session.add(chat)
    db_session.flush()
    db_session.add_all([Message(chat_id=chat.id, role="user", content="How should I price?"),
                        Message(chat_id=chat.id, role="assistant", content="Raise slowly.")])
    db_session.commit()
    seen = {}

    def quiz(**inputs):
        seen["material"] = inputs["material"]
        return {"questions": [{"type": "multiple_choice", "question": "Q?", "options": ["a", "b"], "correct": [0],
                               "explanation": "e", "sources": []}]}

    llm["GenerateQuiz"] = quiz
    art = client.post("/api/artifacts/generate", json={
        "type": "quiz", "notebook_id": nb["id"], "document_ids": [pricing["id"]], "chat_ids": [str(chat.id)]},
        headers=auth).json()
    assert art["notebook_id"] == nb["id"]
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert done["status"] == "ready" and done["content"]["source"]["kind"] == "mixed"
    assert done["content"]["source"]["document_ids"] == [pricing["id"]] and len(done["content"]["source"]["chat_ids"]) == 1
    assert any(m.startswith("FILE ") for m in seen["material"]) and any(m.startswith("CHAT ") for m in seen["material"])


def test_a_quiz_section_the_ai_wrote_becomes_a_suggestion_unless_it_was_asked_for(client, auth, run_jobs, feed, llm):
    pricing, nb = _notebook_with_pricing(client, auth, run_jobs)
    llm["WriteReport"] = {"report_title": "Pricing", "citations": [], "markdown":
                          "## Why price\nText.\n\n## How to raise\nMore.\n\n## Quick quiz\n1. What is a price? (Answer: x)"}
    llm["SuggestEmbeds"] = {"suggestions": []}

    def make(instructions):
        art = client.post("/api/artifacts/generate", json={
            "type": "report", "notebook_id": nb["id"], "document_ids": [pricing["id"]], "report_format": "document",
            "instructions": instructions}, headers=auth).json()
        run_jobs()
        return client.get(f"/api/artifacts/{art['id']}", headers=auth).json()["content"]

    c = make("Write a short brief.")
    assert [b["text"].split("\n")[0] for b in c["blocks"]] == ["## Why price", "## How to raise"]  # no quiz in the text
    assert [(s["after_block_id"], s["kind"]) for s in c["suggestions"]] == [("b2", "quiz")]  # offered, not added

    c = make("Write a study guide with a quiz at the end.")  # the reader asked for it: it stays
    assert [b["text"].split("\n")[0] for b in c["blocks"]][-1] == "## Quick quiz" and c["suggestions"] == []


# ---- infographics ----------------------------------------------------------------------------------------------

def _fake_infographic(**over):
    out = {"title": "Pricing <script>x</script> Plan", "subtitle": "How to raise prices", "items_label": "Ideas",
           "items": [{"name": f"Idea {i}", "text": "A short plain sentence about it."} for i in range(4)],
           "steps_label": "Steps", "steps": [{"name": f"Step {i}", "text": "Do the thing."} for i in range(5)],
           "rule": "Raise slowly.", "notes": ["One.", "Two.", "Three."]}
    return {"infographic": {**out, **over}}


def test_every_theme_escapes_and_clamps_model_text():
    from app.infographics.content import SAMPLE, STRESS, clamp
    from app.infographics.render import build_html
    from app.infographics.themes import THEMES

    evil = clamp({**SAMPLE, "title": "<img src=x onerror=alert(1)> Hello", "rule": "<script>bad()</script> ok"})
    assert "<" not in evil["title"] and "<" not in evil["rule"]
    long = clamp(STRESS)
    assert len(long["title"]) <= 60 and len(long["items"]) == 5 and len(long["steps"]) == 8
    assert clamp({**SAMPLE, "items": SAMPLE["items"][:2]}) is None  # too few to draw
    for tid in THEMES:
        html = build_html(tid, evil)
        assert "<script" not in html and "onerror" not in html and "Hello" in html, tid
    for tid in THEMES:
        assert '<div class="mark">notestack.ai</div>' in build_html(tid, evil)  # every theme carries the mark


def test_infographic_is_a_page_at_once_and_can_be_shared_by_link(client, auth, run_jobs, feed, llm):
    pricing, nb = _notebook_with_pricing(client, auth, run_jobs)
    llm["ExtractIdeas"] = {"ideas": []}
    llm["PlanInfographic"] = _fake_infographic()
    art = client.post("/api/artifacts/generate", json={"type": "infographic", "notebook_id": nb["id"],
                      "document_ids": [pricing["id"]], "theme": "galaxy", "instructions": "About raising prices"},
                      headers=auth).json()
    assert art["type_label"] == "Infographic"
    run_jobs()
    done = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert done["status"] == "ready" and done["content"]["theme"] == "galaxy" and not done["download_url"]
    assert "Idea 0" in done["content"]["html"] and "<script" not in done["content"]["html"]
    assert 'class="mark">notestack.ai' in done["content"]["html"]

    share = client.post(f"/api/artifacts/{art['id']}/share", headers=auth).json()
    assert share["shared"] and "/r/" in share["url"]
    token = share["url"].rsplit("/", 1)[1]
    public = client.get(f"/api/public/reports/{token}")  # no auth header
    assert public.status_code == 200 and public.headers["x-robots-tag"].startswith("noindex")
    body = public.json()
    assert body["kind"] == "infographic" and "Idea 0" in body["html"]
    raw = str(body)
    for leak in (pricing["path"], pricing["id"], art["id"], "About raising prices", "document_ids"):
        assert leak not in raw
    assert client.delete(f"/api/artifacts/{art['id']}/share", headers=auth).json()["shared"] is False
    assert client.get(f"/api/public/reports/{token}").status_code == 404


def test_infographic_needs_a_source_and_enough_text_and_obeys_its_limit(client, auth, run_jobs, feed, llm, monkeypatch):
    from app.pipeline import infographic

    pricing, nb = _notebook_with_pricing(client, auth, run_jobs)
    llm["ExtractIdeas"] = {"ideas": []}
    llm["PlanInfographic"] = _fake_infographic(items=[])
    art = client.post("/api/artifacts/generate", json={"type": "infographic", "notebook_id": nb["id"],
                      "document_ids": [pricing["id"]]}, headers=auth).json()
    run_jobs()
    failed = client.get(f"/api/artifacts/{art['id']}", headers=auth).json()
    assert failed["status"] == "failed" and "enough" in failed["content"]["error"]

    assert client.post("/api/artifacts/generate", json={"type": "infographic", "notebook_id": nb["id"],
                       "document_ids": []}, headers=auth).status_code == 400
    import dataclasses

    from app.services import usage

    real = usage.effective_plan
    monkeypatch.setattr(usage, "effective_plan", lambda db, ws: dataclasses.replace(real(db, ws), infographics=1))
    r = client.post("/api/artifacts/generate", json={"type": "infographic", "notebook_id": nb["id"],
                    "document_ids": [pricing["id"]]}, headers=auth)
    assert r.status_code == 402


def test_a_report_can_add_an_infographic_that_shows_on_the_shared_page(client, auth, run_jobs, feed, llm):
    pricing, nb = _notebook_with_pricing(client, auth, run_jobs)
    done = _make_report(client, auth, run_jobs, llm, pricing, nb)
    llm["ExtractIdeas"] = {"ideas": []}
    llm["PlanInfographic"] = _fake_infographic()
    r = client.post(f"/api/reports/{done['id']}/blocks", json={"kind": "infographic", "after_block_id": "b1",
                    "brief": "The steps to raise prices", "theme": "moonbase"}, headers=auth)
    assert r.status_code == 200, r.text
    run_jobs()  # adds the block, and writes the infographic it points at
    block = next(b for b in client.get(f"/api/artifacts/{done['id']}", headers=auth).json()["content"]["blocks"]
                 if b["type"] == "infographic")
    assert block["theme"] == "moonbase" and block["status"] == "ready" and "Idea 0" in block["html"]
    token = client.post(f"/api/artifacts/{done['id']}/share", headers=auth).json()["url"].rsplit("/", 1)[1]
    public = client.get(f"/api/public/reports/{token}").json()
    shared = next(b for b in public["blocks"] if b["type"] == "infographic")
    assert "Idea 0" in shared["html"] and "artifact_id" not in shared and "theme" not in shared

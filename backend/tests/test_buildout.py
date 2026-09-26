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
    nb = client.post(f"/api/notebooks/from-topic/{names['Pricing']['id']}", headers=auth).json()
    assert nb["added"] == 1


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
    monkeypatch.setattr(tts, "synthesize", lambda ws, text, voice: b"\x00" * 16000)  # 1 second at 128 kbps
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
    assert done["url"] and client.get(done["url"].split("8000", 1)[1]).content == b"\x00" * 32000

    ws_id = db_session.get(Document, uuid.UUID(doc["id"])).workspace_id
    db_session.add(UsageEvent(workspace_id=ws_id, kind="tts", provider="elevenlabs", quantity=240 * 60,
                              unit="seconds"))
    db_session.commit()
    r = client.post("/api/artifacts/generate", json={"type": "audio_overview", "document_id": doc["id"],
                                                     "minutes": 5}, headers=auth)
    assert r.status_code == 402 and r.json()["detail"]["code"] == "plan_limit"


def test_video_hands_off_and_renderer_callback(client, auth, run_jobs, feed, llm, monkeypatch):
    from app.pipeline import media

    connect(client, auth, run_jobs)
    doc = docs(client, auth)[0]
    sent = {}
    monkeypatch.setattr(media, "request_render", lambda job, artifact, comp, props=None, stills=None:
                        sent.update(comp=comp, props=props, job=str(job.id)))
    llm["VideoStoryboard"] = {"scenes": [
        {"type": "title", "on_screen_text": "Charge more", "narration": "", "duration_hint_s": 2.5, "visual": ""},
        {"type": "section", "on_screen_text": "Readers valued it", "narration": "", "duration_hint_s": 3,
         "visual": ""},
    ]}
    art = client.post("/api/artifacts/generate", json={"type": "video", "document_id": doc["id"], "style": "short"},
                      headers=auth).json()
    job = run_jobs()[0]
    assert job.status == "running"  # handed off to the renderer
    assert sent["comp"] == "ShortVertical" and sent["props"]["hook"] == "Charge more"
    from app.config import settings

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
    monkeypatch.setattr(media, "request_render", lambda *a, **k: None)
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


def test_schedule_and_publish_bluesky_thread(client, auth, monkeypatch, session_factory, db_session):
    from app.services import launchpad
    from app.services.social import bluesky

    account = _bluesky(client, auth, monkeypatch)
    published = {}

    def publish(db, acct, posts):
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

    assert launchpad.publish_due(session_factory) == 1
    assert published["posts"] == ["First", "Second"]
    got = client.get("/api/calendar", headers=auth).json()[0]
    assert got["status"] == "posted" and got["external_url"].startswith("https://bsky.app/")
    assert client.patch(f"/api/calendar/{item['id']}", json={"content": "late"}, headers=auth).status_code == 409


def test_substack_notes_send_reminder_email(client, auth, session_factory):
    from app.services import launchpad

    ConsoleEmailProvider.sent.clear()
    item = client.post("/api/calendar", json={"platform": "substack_notes", "content": "A note",
                                              "scheduled_at": (datetime.now(UTC) - timedelta(seconds=5)).isoformat()},
                       headers=auth).json()
    assert item["remind_by_email"] is True
    launchpad.publish_due(session_factory)
    assert client.get("/api/calendar", headers=auth).json()[0]["status"] == "reminded"
    assert ConsoleEmailProvider.sent[-1].subject == "Time to post on Substack Notes"


def test_publish_retries_then_fails(client, auth, monkeypatch, session_factory):
    from app.services import launchpad
    from app.services.social import SocialError, bluesky

    account = _bluesky(client, auth, monkeypatch)

    def boom(db, acct, posts):
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

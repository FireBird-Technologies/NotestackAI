"""Videos through blog2video, with a fake blog2video: API key, denylist, the 3-step create (link, post, upload,
multi-link), our own quotas and counters, premium gating, and workspace isolation for videos, templates, voices
and styles (the integration guide's acceptance checklist)."""

import json
import json as jsonlib
import logging
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from app.config import settings
from app.models import (
    Artifact,
    B2VCustomVoice,
    B2VStyle,
    B2VTemplate,
    B2VVideo,
    Chat,
    Citation,
    Document,
    DocumentTopic,
    Job,
    Message,
    Notebook,
    Subscription,
    Topic,
    UsageCounter,
    User,
    UserSavedVoice,
    VoiceConsent,
    VoiceProfile,
    Workspace,
)
from app.services import blog2video, video_focus, video_limits, video_quota
from tests.conftest import last_code

KEY = "b2v_live_test_key"
API = "https://b2v.test"
SARAH, BELLA = "EXAVITQu4vr4xnSDxMaL", "hpp4J3VqNfWAUOO0d1Us"  # a free and a paid built-in voice

DEFAULTS: dict[str, object] = {
    "GET /api/templates": [{"id": "default", "name": "Default"}, {"id": "geometric", "name": "Geometric",
                                                                 "preview_colors": {"accent": "#FF0000"}}],
    "GET /api/crafted-templates": [{"id": "crafted_neon", "name": "Neon"}],
    "GET /api/voices/prebuilt": {"voices": [
        {"voice_id": SARAH, "name": "Sarah - Mature", "preview_url": "https://cdn.test/sarah.mp3",
         "labels": {"gender": "female", "accent": "american"}, "description": "Warm", "plan": "free"},
        {"voice_id": BELLA, "name": "Bella - Bright", "preview_url": "https://cdn.test/bella.mp3",
         "labels": {"gender": "female", "accent": "british"}, "description": "Bright", "plan": "paid"}]},
    "GET /api/background-music/tracks": [{"track_id": "corporate_upbeat", "display_name": "Corporate Upbeat"}],
    "GET /api/video-styles": {"styles": [
        {"id": "explainer", "name": "Explainer", "kind": "builtin"},
        {"id": "your_style", "name": "Your Style", "kind": "learned"},
        {"id": "custom:7", "custom_id": 7, "name": "Mine", "kind": "custom", "guidance": "Short."},
        {"id": "custom:9", "custom_id": 9, "name": "Theirs", "kind": "custom", "guidance": "Long."}]},
    "POST /api/voices/custom": {"id": 31, "voice_id": "vc_designed", "name": "Narrator", "preview_url": None},
    "POST /api/voices/clone": {"id": 32, "voice_id": "vc_clone", "name": "Me", "preview_url": None},
    "POST /api/voices/design-from-prompt": {"previews": [{"generated_voice_id": "g1", "audio_base_64": "AAA",
                                                          "media_type": "audio/mpeg", "duration_secs": 3}]},
    "POST /api/video-styles/custom": {"id": "custom:41", "custom_id": 41, "name": "Punchy", "guidance": "Punchy."},
    "POST /api/custom-templates": {"id": 58, "name": "Brand"},
    "POST /api/custom-templates/extract-theme-from-prompt": {"extractable": True, "theme": {"colors": {}}},
    "GET /api/auth/me": {"plan": "pro", "video_limit": 150, "videos_used_this_period": 145, "can_create_video": True,
                         "ai_edit_allowance_remaining": 4000, "ai_edit_credits": 0, "custom_template_limit": 20,
                         "custom_templates_created": 3},
}


class FakeB2V:
    """Records every call; answers from a queue of (status, body) per "METHOD path", else a sensible default."""

    def __init__(self):
        self.calls: list[dict] = []
        self.queued: dict[str, list[tuple[int, object]]] = {}
        self.next_id = 812

    def queue(self, method: str, path: str, *answers: tuple[int, object]):
        self.queued.setdefault(f"{method} {path}", []).extend(answers)

    def paths(self, method: str | None = None) -> list[str]:
        return [c["path"] for c in self.calls if method is None or c["method"] == method]

    def __call__(self, method, url, json=None, params=None, data=None, files=None, timeout=None, headers=None):
        if json is not None:
            jsonlib.dumps(json)  # what httpx does: anything that is not plain JSON fails here, as it would for real
        path = url.removeprefix(API)
        key = f"{method} {path}"
        self.calls.append({"method": method, "path": path, "json": json, "data": data, "files": files,
                           "headers": headers or {}, "params": params})
        answers = self.queued.get(key)
        ctype = "application/json"
        if answers:
            status, body = answers.pop(0)
            if isinstance(body, Exception):
                raise body
        elif key in DEFAULTS:
            status, body = 200, DEFAULTS[key]
        elif key in ("POST /api/v1/videos", "POST /api/projects/upload"):
            vid, self.next_id = self.next_id, self.next_id + 1
            status, body = (202, {"video_id": vid, "state": "queued"}) if "v1" in path else (200, {"id": vid})
        elif path.startswith("/api/embed/token/"):
            status, body = 200, {"embed_token": "t", "preview_url": f"{API}/embed/t"}
        elif path.endswith("/status"):
            status, body = 200, {"status": "scripted", "step": 2, "running": True, "ready": False, "error": None,
                                 "video_url": None}
        elif method == "GET" and path.startswith("/api/projects/") and path.count("/") == 3:
            status, body = 200, {"id": int(path.rsplit("/", 1)[1]), "status": "generated", "r2_video_url": None,
                                 "scenes": [{"id": 2, "order": 2, "title": "B"}, {"id": 1, "order": 1, "title": "A"}]}
        elif path in ("/api/voice/preview",) or path.endswith("/download"):
            return httpx.Response(200, content=b"ID3audio", headers={"content-type": "audio/mpeg"},
                                  request=httpx.Request(method, url))
        else:
            status, body = 200, {"ok": True}
        return httpx.Response(status, content=_json(body), headers={"content-type": ctype},
                              request=httpx.Request(method, url))


def _json(body) -> bytes:
    return json.dumps(body).encode()


@pytest.fixture()
def b2v(monkeypatch):
    fake = FakeB2V()
    monkeypatch.setattr(settings, "b2v_api_base_url", API)
    monkeypatch.setattr(settings, "b2v_api_key", KEY)
    monkeypatch.setattr(blog2video.httpx, "request", fake)
    monkeypatch.setattr(blog2video.time, "sleep", lambda s: None)
    blog2video.clear_cache()
    return fake


def register(client, email: str) -> dict:
    client.post("/api/auth/email/register/start", json={"email": email, "password": "stardust-42", "name": "Ada"})
    r = client.post("/api/auth/email/register/verify", json={"email": email, "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture()
def owner(client, db_session):
    headers = register(client, "ada@example.com")
    return headers, db_session.scalar(select(Workspace))


@pytest.fixture()
def other(client, db_session, owner):
    headers = register(client, "grace@example.com")
    ws = db_session.scalar(select(Workspace).where(Workspace.id != owner[1].id))
    return headers, ws


@pytest.fixture()
def free_plan(monkeypatch):
    monkeypatch.setattr(settings, "billing_enabled", True)


def add_doc(db, ws, url: str, text: str = "") -> Document:
    doc = Document(workspace_id=ws.id, title="On Pricing", url=url, clean_text=text, path="sources/x/pricing.md")
    db.add(doc)
    db.commit()
    return doc


def creates(fake: FakeB2V) -> list[dict]:
    return [c for c in fake.calls if c["method"] == "POST" and c["path"] == "/api/v1/videos"]


def used(db, ws) -> int:
    db.expire_all()
    return db.scalar(select(Subscription).where(Subscription.workspace_id == ws.id)).videos_used


def make_video(client, headers, **body) -> dict:
    r = client.post("/api/videos", json={"url": "https://ada.example.com/p/a", **body}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def age(db, row: B2VVideo) -> None:
    row.created_at = datetime.now(UTC) - timedelta(hours=1)
    db.commit()


# Client


def test_sends_our_api_key(b2v):
    blog2video.account()
    assert b2v.calls[0]["headers"]["Authorization"] == f"Bearer {KEY}"


def test_create_retries_with_the_same_idempotency_key(b2v):
    b2v.queue("POST", "/api/v1/videos", (0, httpx.ConnectTimeout("slow")), (503, {"detail": "busy"}))
    assert blog2video.create_video({"url": "https://a.test"}, "ws:1")["video_id"] == 812
    assert [c["headers"]["Idempotency-Key"] for c in b2v.calls] == ["ws:1"] * 3


def test_other_calls_are_not_retried(b2v):
    b2v.queue("GET", "/api/auth/me", (500, {"detail": "boom"}))
    with pytest.raises(blog2video.Upstream):
        blog2video.account()
    assert len(b2v.calls) == 1


@pytest.mark.parametrize("status", [401, 402, 403])
def test_account_problems_alert_ops(b2v, caplog, status):
    b2v.queue("GET", "/api/auth/me", (status, {"detail": {"error": "x"}}))
    with caplog.at_level(logging.ERROR), pytest.raises(blog2video.Upstream if status != 402
                                                       else blog2video.AccountOutOfVideos):
        blog2video.account()
    assert "ALERT" in caplog.text and KEY not in caplog.text


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/projects"), ("POST", "/api/projects/bulk"), ("GET", "/api/projects"),
    ("GET", "/api/projects/template-availability"), ("GET", "/api/voices/saved"), ("POST", "/api/voices/saved"),
    ("DELETE", "/api/voices/saved/abc"), ("PATCH", "/api/video-styles/builtin/explainer"),
    ("PUT", "/api/video-styles/pin"), ("PUT", "/api/video-styles/selection"), ("PATCH", "/api/video-styles/your-style"),
    ("DELETE", "/api/auth/me/script-preferences"),
])
def test_account_wide_endpoints_are_never_called(b2v, method, path):
    with pytest.raises(blog2video.Denied):
        blog2video.request(method, path)
    assert b2v.calls == []


# Create: the 3 steps


def test_link_create_forwards_every_wizard_field(client, b2v, owner, db_session):
    headers, ws = owner
    body = {"stock_footage_enabled": False, "aspect_ratio": "portrait",
            "video_length": "medium", "logo_position": "top_left", "logo_opacity": 0.5, "template": "geometric",
            "video_style": "storytelling", "accent_color": "#FF5A1F", "bg_color": "#0B0B0F", "text_color": "#FFFFFF",
            "content_language": "es", "voice_gender": "female", "voice_accent": "british",
            "custom_voice_id": SARAH, "voice_emotion": '["0.5","1.0","calm","0","1"]',
            "bgm_track_id": "corporate_upbeat", "bgm_volume": 0.2}
    art = make_video(client, headers, **body)
    call = creates(b2v)[0]
    for k, v in body.items():
        assert call["json"][k] == v, k
    assert call["json"]["script_review_enabled"] is False
    assert call["headers"]["Idempotency-Key"].startswith(f"{ws.id}:")
    assert call["json"]["external_user_id"] == str(ws.id)
    row = db_session.scalar(select(B2VVideo))
    assert (row.b2v_video_id, row.quota_state, row.created_via, row.template_ref) == (812, "charged", "v1", "geometric")
    assert art["content"]["b2v_video_id"] == 812 and used(db_session, ws) == 1


def test_script_review_is_always_off(client, b2v, owner):
    make_video(client, owner[0], script_review_enabled=True)  # an old client asking for it is ignored
    assert creates(b2v)[0]["json"]["script_review_enabled"] is False


def test_create_from_feed_post_and_uploaded_post(client, b2v, owner, db_session):
    headers, ws = owner
    doc = add_doc(db_session, ws, "https://ada.example.com/p/pricing")
    client.post("/api/videos", json={"document_id": str(doc.id)}, headers=headers)
    assert creates(b2v)[-1]["json"]["url"] == "https://ada.example.com/p/pricing"
    doc = add_doc(db_session, ws, "upload://notes.md", "Charging more made my readers take the work seriously. " * 3)
    client.post("/api/videos", json={"document_id": str(doc.id)}, headers=headers)
    sent = creates(b2v)[-1]["json"]
    assert "url" not in sent and sent["content"].startswith("Charging more")


def test_notebook_posts_make_one_combined_video(client, b2v, owner, db_session):
    headers, ws = owner
    new = add_doc(db_session, ws, "https://ada.example.com/p/new", "Raise prices once a year, and say why. " * 3)
    old = add_doc(db_session, ws, "https://ada.example.com/p/old", "Start cheaper than you think you should. " * 3)
    new.title, new.published_at = "Annual raises", datetime(2026, 5, 1, tzinfo=UTC)
    old.title, old.published_at = "Starting out", datetime(2025, 1, 1, tzinfo=UTC)
    nb = Notebook(workspace_id=ws.id, title="Pricing series")
    db_session.add(nb)
    db_session.commit()
    r = client.post("/api/videos", json={"document_ids": [str(new.id), str(old.id)], "notebook_id": str(nb.id)},
                    headers=headers)
    assert r.status_code == 201 and r.json()["content"]["title"] == "Pricing series"
    sent = creates(b2v)[-1]["json"]
    assert len(creates(b2v)) == 1 and "url" not in sent and sent["title"] == "Pricing series"
    assert not {"document_ids", "notebook_id", "document_id"} & set(sent)  # the source is not a wizard option
    assert sent["content"].index("# Starting out") < sent["content"].index("# Annual raises")
    assert used(db_session, ws) == 1


def test_one_ticked_post_goes_by_its_link(client, b2v, owner, db_session):
    headers, ws = owner
    doc = add_doc(db_session, ws, "https://ada.example.com/p/pricing")
    client.post("/api/videos", json={"document_ids": [str(doc.id)]}, headers=headers)
    assert creates(b2v)[-1]["json"]["url"] == "https://ada.example.com/p/pricing"


def test_locked_posts_are_refused_before_charging(client, b2v, owner, db_session):
    headers, ws = owner
    ok = add_doc(db_session, ws, "https://ada.example.com/p/a", "Enough text to make a video from, really. " * 3)
    locked = add_doc(db_session, ws, "https://ada.example.com/p/b")
    locked.path, locked.metadata_json = None, {"locked": True}
    db_session.commit()
    for body in ({"document_id": str(locked.id)}, {"document_ids": [str(ok.id), str(locked.id)]}):
        r = client.post("/api/videos", json=body, headers=headers)
        assert r.status_code == 400 and "not indexed" in r.json()["detail"]
    assert not creates(b2v) and used(db_session, ws) == 0


def add_chat(db, ws, turns: list[tuple[str, str]], title: str | None = "Pricing chat") -> Chat:
    nb = Notebook(workspace_id=ws.id, title="Pricing series")
    db.add(nb)
    db.flush()
    chat = Chat(workspace_id=ws.id, notebook_id=nb.id, title=title)
    db.add(chat)
    db.flush()
    for i, (role, text) in enumerate(turns):
        db.add(Message(chat_id=chat.id, role=role, content=text,
                       created_at=datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=i)))
    db.commit()
    return chat


def test_chat_is_sent_as_its_transcript_after_the_context_prompt(client, b2v, owner, db_session):
    from app.routers.videos import CHAT_CONTEXT
    headers, ws = owner
    chat = add_chat(db_session, ws, [("user", "How often should I raise prices?"),
                                     ("assistant", "Once a year, and tell readers why [1]. Grandfather the early ones [2].")])
    r = client.post("/api/videos", json={"chat_ids": [str(chat.id)]}, headers=headers)
    assert r.status_code == 201 and r.json()["content"]["title"] == "Pricing chat"
    sent = creates(b2v)[-1]["json"]
    assert sent["title"] == "Pricing chat" and "chat_ids" not in sent and "url" not in sent
    assert sent["content"].startswith(CHAT_CONTEXT)
    assert "User: How often should I raise prices?" in sent["content"]
    assert "Assistant: Once a year, and tell readers why. Grandfather the early ones." in sent["content"]
    assert used(db_session, ws) == 1


def test_several_chats_make_one_video(client, b2v, owner, other, db_session):
    from app.routers.videos import CHAT_CONTEXT
    headers, ws = owner
    a = add_chat(db_session, ws, [("user", "How often should I raise prices?"),
                                  ("assistant", "Once a year, and tell readers why it is happening.")])
    b = add_chat(db_session, ws, [("user", "Should early readers keep their price?"),
                                  ("assistant", "Yes, grandfather them: they took the risk first.")], title="Early readers")
    r = client.post("/api/videos", json={"chat_ids": [str(a.id), str(b.id)]}, headers=headers)
    assert r.status_code == 201 and r.json()["content"]["title"] == "Pricing chat + 1 more"
    content = creates(b2v)[-1]["json"]["content"]
    assert content.startswith(CHAT_CONTEXT)
    assert content.index("# Pricing chat") < content.index("User: How often") < content.index("# Early readers")
    assert "Assistant: Yes, grandfather them" in content
    # Six is over the cap; one chat that is not ours makes it 404.
    six = [str(add_chat(db_session, ws, [("user", "Q?"), ("assistant", "A long enough answer.")]).id) for _ in range(6)]
    assert client.post("/api/videos", json={"chat_ids": six}, headers=headers).status_code == 422
    theirs = add_chat(db_session, other[1], [("user", "Q?"), ("assistant", "A.")])
    r = client.post("/api/videos", json={"chat_ids": [str(a.id), str(theirs.id)]}, headers=headers)
    assert r.status_code == 404 and len(creates(b2v)) == 1


def test_chats_list_across_notebooks_only_answered_ones(client, owner, other, db_session):
    headers, ws = owner
    answered = add_chat(db_session, ws, [("user", "Q?"), ("assistant", "A.")])
    add_chat(db_session, ws, [("user", "Unanswered?")])
    add_chat(db_session, other[1], [("user", "Q?"), ("assistant", "A.")])
    r = client.get("/api/notebooks/chats", headers=headers)
    assert r.status_code == 200
    assert [(c["id"], c["notebook_title"]) for c in r.json()] == [(str(answered.id), "Pricing series")]


def test_chat_source_is_checked(client, b2v, owner, other, db_session):
    headers, ws = owner
    theirs = add_chat(db_session, other[1], [("user", "Q?"), ("assistant", "A long enough answer, really.")])
    assert client.post("/api/videos", json={"chat_ids": [str(theirs.id)]}, headers=headers).status_code == 404
    empty = add_chat(db_session, ws, [("user", "Anyone there?")])
    assert client.post("/api/videos", json={"chat_ids": [str(empty.id)]}, headers=headers).status_code == 400
    doc = add_doc(db_session, ws, "https://ada.example.com/p/a")
    r = client.post("/api/videos", json={"chat_ids": [str(empty.id)], "document_id": str(doc.id)}, headers=headers)
    assert r.status_code == 422
    assert not creates(b2v) and used(db_session, ws) == 0


def test_another_workspaces_post_is_404(client, b2v, owner, other, db_session):
    headers, ws = owner
    mine = add_doc(db_session, ws, "https://ada.example.com/p/a", "Enough text to make a video from, really. " * 3)
    theirs = add_doc(db_session, other[1], "https://bo.example.com/p/b")
    r = client.post("/api/videos", json={"document_ids": [str(mine.id), str(theirs.id)]}, headers=headers)
    assert r.status_code == 404 and not creates(b2v)


def test_upload_goes_to_blog2video_and_generates(client, b2v, owner, db_session):
    headers, ws = owner
    files = [("files", ("notes.md", b"# Notes\n" * 20, "text/markdown")), ("files", ("deck.pptx", b"x", "app/x"))]
    r = client.post("/api/videos/upload", files=files, data={"options": json.dumps({"video_length": "medium"})},
                    headers=headers)
    assert r.status_code == 201, r.text
    upload = next(c for c in b2v.calls if c["path"] == "/api/projects/upload")
    assert [f[1][0] for f in upload["files"]] == ["notes.md", "deck.pptx"]
    assert upload["data"]["video_length"] == "medium" and upload["data"]["script_review_enabled"] == "false"
    assert "/api/projects/812/generate" in b2v.paths("POST")
    row = db_session.scalar(select(B2VVideo))
    assert row.created_via == "upload" and row.idempotency_key is None
    client.get(f"/api/videos/{r.json()['id']}/status", headers=headers)
    assert "/api/projects/812/status" in b2v.paths("GET")  # uploads are not under /api/v1


def test_upload_rejects_wrong_files_before_charging(client, b2v, owner, db_session):
    headers, ws = owner
    r = client.post("/api/videos/upload", files=[("files", ("a.exe", b"x", "app/x"))], headers=headers)
    assert r.status_code == 400 and used(db_session, ws) == 0 and b2v.calls == []


def test_multi_link_makes_one_video_per_link(client, b2v, owner, db_session):
    headers, ws = owner
    r = client.post("/api/videos/batch", json={"urls": ["https://a.test/1", "https://a.test/2", "nope"],
                                               "bgm_track_id": "corporate_upbeat"}, headers=headers)
    assert r.status_code == 201 and len(r.json()) == 2
    calls = creates(b2v)
    assert len({c["headers"]["Idempotency-Key"] for c in calls}) == 2
    assert all("bgm_track_id" not in c["json"] for c in calls)  # music is single-video only
    assert used(db_session, ws) == 2


def test_our_account_out_of_videos_refunds_the_user(client, b2v, owner, db_session, caplog):
    headers, ws = owner
    b2v.queue("POST", "/api/v1/videos", (402, {"detail": {"error": "quota_exceeded"}}))
    with caplog.at_level(logging.ERROR):
        r = client.post("/api/videos", json={"url": "https://ada.example.com/p/a"}, headers=headers)
    assert r.status_code == 503 and "temporarily unavailable" in r.json()["detail"] and "ALERT" in caplog.text
    assert db_session.scalar(select(Artifact).where(Artifact.type == "video")) is None
    assert db_session.scalar(select(B2VVideo)).quota_state == "refunded" and used(db_session, ws) == 0


def test_validation_error_refunds_and_says_what_was_wrong(client, b2v, owner, db_session):
    headers, ws = owner
    b2v.queue("POST", "/api/v1/videos", (422, {"detail": [{"loc": ["body", "url"], "msg": "could not fetch"}]}))
    r = client.post("/api/videos", json={"url": "https://ada.example.com/p/a"}, headers=headers)
    assert r.status_code == 400 and "url: could not fetch" in r.json()["detail"] and used(db_session, ws) == 0


def test_slow_catalog_is_a_clean_error_not_a_500(client, b2v, owner, db_session):
    headers, ws = owner
    b2v.queue("GET", "/api/templates", (0, httpx.ReadTimeout("slow")))
    r = client.post("/api/videos", json={"url": "https://ada.example.com/p/a", "template": "geometric"},
                    headers=headers)
    assert r.status_code == 502 and "not responding" in r.json()["detail"]
    assert not creates(b2v) and used(db_session, ws) == 0


def test_expired_catalog_is_used_when_blog2video_is_slow(client, b2v, owner):
    make_video(client, owner[0], template="geometric")  # fills the catalog cache
    for key, (at, value) in list(blog2video._cache.items()):
        blog2video._cache[key] = (at - 2 * blog2video.CATALOG_TTL, value)  # an hour and more ago
    b2v.queue("GET", "/api/templates", (0, httpx.ReadTimeout("slow")))
    make_video(client, owner[0], template="geometric")
    assert len(creates(b2v)) == 2


def test_no_answer_after_retries_refunds(client, b2v, owner, db_session):
    headers, ws = owner
    b2v.queue("POST", "/api/v1/videos", *[(0, httpx.ConnectError("down"))] * 3)
    r = client.post("/api/videos", json={"url": "https://ada.example.com/p/a"}, headers=headers)
    assert r.status_code == 502 and len(creates(b2v)) == 3 and used(db_session, ws) == 0


def test_local_limit_blocks_without_calling_out(client, b2v, owner, db_session):
    headers, ws = owner
    client.get("/api/videos/quota", headers=headers)  # syncs the row
    sub = db_session.scalar(select(Subscription).where(Subscription.workspace_id == ws.id))
    sub.videos_used = sub.video_limit
    db_session.commit()
    r = client.post("/api/videos", json={"url": "https://ada.example.com/p/a"}, headers=headers)
    assert r.status_code == 402 and r.json()["detail"]["code"] == "plan_limit" and not creates(b2v)


def test_two_workspaces_same_url_get_separate_videos(client, b2v, owner, other):
    make_video(client, owner[0])
    make_video(client, other[0])
    calls = creates(b2v)
    assert calls[0]["headers"]["Idempotency-Key"].split(":")[0] != calls[1]["headers"]["Idempotency-Key"].split(":")[0]


def test_not_configured(client, owner):
    r = client.post("/api/videos", json={"url": "https://ada.example.com/p/a"}, headers=owner[0])
    assert r.status_code == 503


# Isolation: another workspace's ids are refused before blog2video is called


@pytest.fixture()
def theirs(db_session, other):
    _, ws = other
    db_session.add_all([B2VTemplate(b2v_template_id=77, workspace_id=ws.id, name="Theirs", ready=True),
                        B2VStyle(b2v_style_id=9, workspace_id=ws.id, name="Theirs"),
                        B2VCustomVoice(b2v_custom_voice_id=90, workspace_id=ws.id, voice_id="vc_theirs", name="T",
                                       source="clone")])
    db_session.commit()


@pytest.mark.parametrize("field,value", [("template", "custom_77"), ("video_style", "custom:9"),
                                         ("custom_voice_id", "vc_theirs"), ("video_style", "your_style"),
                                         ("template", "custom_12345"), ("template", "not-a-template"),
                                         ("template", "crafted_other")])
def test_foreign_references_are_refused_before_calling_out(client, b2v, owner, theirs, db_session, field, value):
    headers, ws = owner
    r = client.post("/api/videos", json={"url": "https://ada.example.com/p/a", field: value}, headers=headers)
    assert r.status_code == 404 and not creates(b2v) and used(db_session, ws) == 0


def test_own_references_pass(client, b2v, owner, db_session):
    headers, ws = owner
    db_session.add_all([B2VTemplate(b2v_template_id=58, workspace_id=ws.id, name="Mine", ready=True),
                        B2VStyle(b2v_style_id=7, workspace_id=ws.id, name="Mine"),
                        B2VCustomVoice(b2v_custom_voice_id=31, workspace_id=ws.id, voice_id="vc_mine", name="M",
                                       source="prompt")])
    db_session.commit()
    make_video(client, headers, template="custom_58", video_style="custom:7", custom_voice_id="vc_mine")
    make_video(client, headers, template="crafted_neon")


def test_template_still_generating_is_refused(client, b2v, owner, db_session):
    headers, ws = owner
    db_session.add(B2VTemplate(b2v_template_id=58, workspace_id=ws.id, name="Mine", ready=False))
    db_session.commit()
    r = client.post("/api/videos", json={"url": "https://a.test/x", "template": "custom_58"}, headers=headers)
    assert r.status_code == 400 and not creates(b2v)


def test_other_workspace_video_is_404_everywhere(client, b2v, owner, other):
    art = make_video(client, owner[0])
    b2v.calls.clear()
    for method, path in [("GET", ""), ("GET", "/status"), ("GET", "/script"), ("DELETE", ""),
                         ("PUT", "/p/scenes/1"), ("POST", "/p/render")]:
        r = client.request(method, f"/api/videos/{art['id']}{path}", json={}, headers=other[0])
        assert r.status_code == 404, (method, path)
    assert b2v.calls == []


def test_catalog_shows_only_this_workspace(client, b2v, owner, theirs, db_session):
    headers, ws = owner
    db_session.add_all([B2VStyle(b2v_style_id=7, workspace_id=ws.id, name="Mine"),
                        B2VTemplate(b2v_template_id=58, workspace_id=ws.id, name="Mine", ready=True),
                        B2VTemplate(b2v_template_id=59, workspace_id=ws.id, name="Not yet", ready=False)])
    db_session.commit()
    cat = client.get("/api/videos/catalog", headers=headers).json()
    assert [s["id"] for s in cat["video_styles"]] == ["explainer", "custom:7"]
    assert [t["id"] for t in cat["my_templates"]] == ["custom_58"]


@pytest.fixture()
def house(monkeypatch):
    """Our account has the two house styles (made on blog2video itself, not by any workspace)."""
    styles = DEFAULTS["GET /api/video-styles"]["styles"] + [
        {"id": "custom:21", "custom_id": 21, "name": "Deep dive", "kind": "custom", "guidance": "Context first."},
        {"id": "custom:20", "custom_id": 20, "name": "Overview", "kind": "custom", "guidance": "Neutral."}]
    monkeypatch.setitem(DEFAULTS, "GET /api/video-styles", {"styles": styles})


def test_catalog_offers_only_the_house_styles(client, b2v, owner, house, db_session):
    headers, ws = owner
    db_session.add(B2VStyle(b2v_style_id=7, workspace_id=ws.id, name="Mine"))
    db_session.commit()
    styles = client.get("/api/videos/catalog", headers=headers).json()["video_styles"]
    assert [(s["id"], s["name"], s["kind"]) for s in styles] == [("custom:20", "Overview", "house"),
                                                                 ("custom:21", "Deep dive", "house")]
    assert all(s["description"] and "length" not in s for s in styles)


@pytest.mark.parametrize("style,length", [("custom:20", "short"), ("custom:21", "medium")])
def test_house_style_sets_the_length(client, b2v, owner, house, free_plan, style, length):
    make_video(client, owner[0], video_style=style, video_length="detailed")
    sent = creates(b2v)[-1]["json"]
    assert sent["video_style"] == style and sent["video_length"] == length


def test_other_account_styles_stay_refused(client, b2v, owner, house):
    r = client.post("/api/videos", json={"url": "https://a.test/x", "video_style": "custom:9"}, headers=owner[0])
    assert r.status_code == 404 and not creates(b2v)


@pytest.fixture()
def suggest(monkeypatch):
    """The AI's focus suggestions, canned: records what it was given."""
    from app.llm import run
    seen: list[dict] = []

    def predict(signature, *, db, workspace_id, job=None, lm=None, **inputs):
        seen.append({"signature": signature.__name__, **inputs})
        topic = lambda title, desc="": {"title": title, "description": desc}  # noqa: E731
        return {"topics": [topic("Why prices go up.", "Why raises happen.  Once a year,\n with notice."),
                           topic("why prices go up"), topic("Grandfathering early readers", "Keep early prices."),
                           topic("Annual raises", "One raise a year."), topic("A fourth one")]}

    monkeypatch.setattr(run, "predict", predict)
    return seen


def test_focus_topics_for_posts_a_chat_and_one_post(client, owner, db_session, suggest):
    headers, ws = owner
    a = add_doc(db_session, ws, "https://ada.example.com/p/a", "Raise prices once a year, and say why. " * 3)
    b = add_doc(db_session, ws, "https://ada.example.com/p/b", "Start cheaper than you think you should. " * 3)
    chat = add_chat(db_session, ws, [("user", "How often should I raise prices?"),
                                     ("assistant", "Once a year, and tell readers why it is happening [1].")])
    for body in ({"document_ids": [str(a.id), str(b.id)]}, {"chat_ids": [str(chat.id)]}, {"document_id": str(a.id)}):
        r = client.post("/api/videos/focus-topics", json=body, headers=headers)
        assert r.status_code == 200, r.text
        assert r.json()["topics"] == [
            {"title": "Why prices go up", "description": "Why raises happen. Once a year, with notice."},
            {"title": "Grandfathering early readers", "description": "Keep early prices."},
            {"title": "Annual raises", "description": "One raise a year."}]
    assert [s["signature"] for s in suggest] == ["VideoFocusAngles"] * 3  # no topics to show: the AI writes them
    # Each item is a title and the start of its text: a little, never the whole post or transcript.
    posts, chat_item, one = (s["items"] for s in suggest)
    assert len(posts) == 2 and all(p.startswith("On Pricing\n") for p in posts)
    assert any("Raise prices once a year" in p for p in posts) and any("Start cheaper" in p for p in posts)
    assert chat_item == ["Pricing chat\nHow often should I raise prices?\nOnce a year, and tell readers why it is "
                         "happening."]
    assert one[0].startswith("On Pricing\nRaise prices")


def test_focus_material_is_short_and_untitled_chats_still_get_topics(client, owner, db_session, suggest):
    headers, ws = owner
    long = add_doc(db_session, ws, "https://ada.example.com/p/a", "Pricing is a promise to your readers. " * 200)
    other = add_doc(db_session, ws, "https://ada.example.com/p/b", "Grandfather the people who came early. " * 200)
    untitled = add_chat(db_session, ws, [("user", "Should I raise prices?"), ("assistant", "Yes, once a year [1].")],
                        title=None)
    r = client.post("/api/videos/focus-topics", json={"document_ids": [str(long.id), str(other.id)]}, headers=headers)
    assert len(r.json()["topics"]) == 3
    assert all(len(i) < 450 and i.endswith("...") for i in suggest[-1]["items"])  # 400 characters of text per post
    titled = add_chat(db_session, ws, [("user", "What about early readers?"), ("assistant", "Keep their price.")])
    r = client.post("/api/videos/focus-topics", json={"chat_ids": [str(untitled.id), str(titled.id)]}, headers=headers)
    assert len(r.json()["topics"]) == 3 and len(suggest[-1]["items"]) == 2
    r = client.post("/api/videos/focus-topics", json={"chat_ids": [str(untitled.id)]}, headers=headers)
    assert len(r.json()["topics"]) == 3
    assert suggest[-1]["items"] == ["Should I raise prices?\nYes, once a year."]


def test_unusable_topics_get_one_fresh_retry(client, owner, db_session, monkeypatch):
    from app.llm import run
    headers, ws = owner
    doc = add_doc(db_session, ws, "https://ada.example.com/p/a", "Raise prices once a year, and say why. " * 3)
    lms = []
    answers = [  # what GLM did: the word "Description" as every title, then a proper answer
        {"topics": [{"topic": "Description", "summary": f"Angle {i}."} for i in range(3)]},
        {"topics": [{"topic": "Annual raises", "summary": "One raise a year."},
                    {"topic": "Grandfathering early readers", "summary": "Keep early prices."},
                    {"topic": "Saying why prices go up", "summary": "Explain the raise."}]},
    ]

    def predict(signature, *, db, workspace_id, job=None, lm=None, **inputs):
        lms.append(lm)
        return answers[len(lms) - 1]

    monkeypatch.setattr(run, "predict", predict)
    r = client.post("/api/videos/focus-topics", json={"document_id": str(doc.id)}, headers=headers)
    assert [t["title"] for t in r.json()["topics"]] == ["Annual raises", "Grandfathering early readers",
                                                        "Saying why prices go up"]
    assert len(lms) == 2 and lms[0] is not lms[1]  # the retry is a fresh call, not the cached bad answer


def test_focus_topics_check_the_source(client, owner, other, db_session, suggest):
    headers, ws = owner
    theirs = add_chat(db_session, other[1], [("user", "Q?"), ("assistant", "A long enough answer, really.")])
    assert client.post("/api/videos/focus-topics", json={"chat_ids": [str(theirs.id)]}, headers=headers).status_code == 404
    locked = add_doc(db_session, ws, "https://ada.example.com/p/b")
    locked.path, locked.metadata_json = None, {"locked": True}
    db_session.commit()
    r = client.post("/api/videos/focus-topics", json={"document_id": str(locked.id)}, headers=headers)
    assert r.status_code == 400 and not suggest


# Focus topics: the workspace's own, shown as they are


@pytest.fixture()
def angles(monkeypatch):
    """The AI, canned: VideoFocusAngles (only when there are no topics to show) answers three fixed angles.
    ExtractTopics (tagging on demand) answers per post from `tag_answers` (title -> tags; None = the call failed)."""
    from app.llm import run
    calls: dict = {"focus": [], "tagged": [], "tag_answers": {}}

    def predict(signature, *, db, workspace_id, job=None, lm=None, **inputs):
        calls["focus"].append(inputs)
        return {"topics": [{"topic": f"AI angle {i}", "summary": "Written by the AI.", "tag": ""} for i in range(3)]}

    def predict_many(signature, inputs_list, *, db, workspace_id, lm=None, workers=5):
        calls["tagged"].append([i["title"] for i in inputs_list])
        answers = [calls["tag_answers"].get(i["title"], []) for i in inputs_list]
        return [None if a is None else {"topics": [{"name": n, "weight": 0.8} for n in a]} for a in answers]

    monkeypatch.setattr(run, "predict", predict)
    monkeypatch.setattr(run, "predict_many", predict_many)
    monkeypatch.setattr(settings, "llm_api_key", "test-key")
    return calls


def tagged_doc(db, ws, slug: str, tags: list[str], title: str = "On Pricing",
               weights: list[float] | None = None) -> Document:
    doc = add_doc(db, ws, f"https://ada.example.com/p/{slug}", f"All about {slug}. " * 20)
    weights = weights or [0.8] * len(tags)
    doc.title = title
    doc.metadata_json = {"topics": [{"name": t, "weight": w} for t, w in zip(tags, weights, strict=True)]}
    db.commit()
    return doc


def merge(db, ws, name: str, summary: str, *links: tuple[Document, float]) -> Topic:
    """A topic of the topic table (what rebuild_topics makes), linked to posts with a weight."""
    topic = Topic(workspace_id=ws.id, name=name, slug=name.lower().replace(" ", "-"), summary=summary,
                  post_count=len(links))
    db.add(topic)
    db.flush()
    db.add_all([DocumentTopic(document_id=d.id, topic_id=topic.id, weight=w) for d, w in links])
    db.commit()
    return topic


def focus(client, headers, **body) -> list[dict]:
    r = client.post("/api/videos/focus-topics", json=body, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["topics"]


def test_a_tag_shared_by_the_selection_outranks_one_posts_strongest(owner, db_session):
    _, ws = owner
    docs = [add_doc(db_session, ws, f"https://ada.example.com/p/{i}", "Text.") for i in range(3)]
    merge(db_session, ws, "Pricing", "How to price.", *[(d, 0.5) for d in docs])
    merge(db_session, ws, "Churn", "", (docs[0], 1.0))
    pool = video_focus.build_pool(db_session, ws.id, {str(d.id): {d.id: 1.0} for d in docs}, docs)
    assert [c.name for c in pool] == ["Pricing", "Churn"]
    assert pool[0].summary == "How to price." and len(pool[0].sources) == 3 and pool[0].merged


def test_a_posts_own_tags_join_the_merged_topics(owner, db_session):
    """The merge folds a post's specific tags into a few broad topics; the specific ones still count."""
    _, ws = owner
    doc = tagged_doc(db_session, ws, "a", ["Content Repurposing", "Video Marketing", "Finance Writing"])
    merge(db_session, ws, "Finance Substacks", "Growing a finance newsletter.", (doc, 0.9))
    merge(db_session, ws, "Finance Writing", "", (doc, 0.4))
    pool = video_focus.build_pool(db_session, ws.id, {str(doc.id): {doc.id: 1.0}}, [doc])
    assert sorted((c.name, c.merged) for c in pool) == [
        ("Content Repurposing", False), ("Finance Substacks", True), ("Finance Writing", True),  # once, merged
        ("Video Marketing", False)]


def test_existing_topics_are_shown_as_they_are_without_the_ai(client, owner, db_session, angles):
    headers, ws = owner
    doc = tagged_doc(db_session, ws, "a", ["Chinese LLMs", "Token Pricing", "Software Margins"],
                     weights=[0.9, 0.7, 0.5])
    merge(db_session, ws, "AI & China LLM Competition", "Why Chinese LLMs are cheaper.", (doc, 0.9))
    cards = focus(client, headers, document_id=str(doc.id))
    # Merged topics first (with their summary), then the post's own tags (a name only), best first.
    assert cards == [{"title": "AI & China LLM Competition", "description": "Why Chinese LLMs are cheaper."},
                     {"title": "Chinese LLMs", "description": ""},
                     {"title": "Token Pricing", "description": ""}]
    assert not angles["focus"] and not angles["tagged"]  # no AI at all


def test_a_fresh_tag_that_names_a_merged_topic_is_shown_with_its_summary(client, owner, db_session, angles):
    headers, ws = owner
    merge(db_session, ws, "Annual Raises", "Once a year, with notice.")
    doc = tagged_doc(db_session, ws, "a", ["annual raises"])
    assert focus(client, headers, document_id=str(doc.id)) == [
        {"title": "Annual Raises", "description": "Once a year, with notice."}]  # one topic: one card, no AI
    assert not angles["focus"]


def test_several_posts_show_their_shared_topics_first_spread_over_the_posts(client, owner, db_session, angles):
    headers, ws = owner
    a, b, c = (tagged_doc(db_session, ws, s, [f"{s} own"], title=f"Post {s}") for s in "abc")
    merge(db_session, ws, "Pricing", "Shared by all.", (a, 0.5), (b, 0.5), (c, 0.5))
    merge(db_session, ws, "A Big", "Post a's main topic.", (a, 1.0))
    merge(db_session, ws, "A Small", "Post a again.", (a, 0.9))
    merge(db_session, ws, "B Side", "Post b's.", (b, 0.8))
    cards = focus(client, headers, document_ids=[str(d.id) for d in (a, b, c)])
    # Pricing (in all three) first; then post a's topics are already covered, so b's comes before a's second one.
    assert [x["title"] for x in cards] == ["Pricing", "A Big", "B Side"]
    assert not angles["focus"]


def test_untagged_posts_are_tagged_on_demand_then_shown(client, owner, db_session, angles):
    headers, ws = owner
    docs = [add_doc(db_session, ws, f"https://ada.example.com/p/{i}", "Some text. " * 20) for i in range(7)]
    for i, d in enumerate(docs):
        d.title, d.published_at = f"Post {i}", datetime(2026, 1, 1 + i, tzinfo=UTC)
    db_session.commit()
    angles["tag_answers"] = {f"Post {i}": [f"Theme {i}", "Pricing"] for i in range(7)}
    angles["tag_answers"]["Post 6"] = None  # that call failed
    body = {"document_ids": [str(d.id) for d in docs]}
    cards = focus(client, headers, **body)
    assert angles["tagged"] == [["Post 6", "Post 5", "Post 4", "Post 3", "Post 2"]]  # the newest five
    assert cards[0] == {"title": "Pricing", "description": ""} and len(cards) == 3  # in 4 posts: first
    assert not angles["focus"]
    db_session.expire_all()
    assert [d.metadata_json.get("topics", [{}])[0].get("name") for d in docs] == [
        None, None, "Theme 2", "Theme 3", "Theme 4", "Theme 5", None]
    jobs = db_session.scalars(select(Job).where(Job.workspace_id == ws.id, Job.kind == "topics")).all()
    assert len(jobs) == 1 and jobs[0].params == {}
    focus(client, headers, **body)  # the job is still queued: not again
    assert len(db_session.scalars(select(Job).where(Job.workspace_id == ws.id, Job.kind == "topics")).all()) == 1


def test_with_no_topics_to_show_the_ai_writes_them(client, owner, db_session, angles, monkeypatch):
    headers, ws = owner
    monkeypatch.setattr(settings, "llm_api_key", "")  # nothing is tagged
    doc = add_doc(db_session, ws, "https://ada.example.com/p/a", "Raise prices once a year. " * 5)
    cards = focus(client, headers, document_id=str(doc.id))
    assert [c["title"] for c in cards] == ["AI angle 0", "AI angle 1", "AI angle 2"] and not angles["tagged"]
    assert angles["focus"][0]["candidate_tags"] == [] and angles["focus"][0]["avoid_titles"] == []


def cite(db, chat: Chat, *docs: Document) -> None:
    answer = db.scalars(select(Message).where(Message.chat_id == chat.id, Message.role == "assistant")).first()
    db.add_all([Citation(message_id=answer.id, document_id=d.id, marker=i + 1, path="sources/x/p.md", line_start=1,
                         line_end=2) for i, d in enumerate(docs)])
    db.commit()


def test_a_chat_shows_the_topics_of_the_posts_it_cites(client, owner, db_session, angles):
    headers, ws = owner
    a = tagged_doc(db_session, ws, "a", ["Annual Raises"])
    b = tagged_doc(db_session, ws, "b", ["Grandfathering"])
    tagged_doc(db_session, ws, "c", ["Never Cited"])
    merge(db_session, ws, "Pricing", "How to price.", (a, 0.9), (b, 0.9))
    chat = add_chat(db_session, ws, [("user", "How should I price?"),
                                     ("assistant", "Once a year [1], keep early [2].")])
    cite(db_session, chat, a, b)
    cards = focus(client, headers, chat_ids=[str(chat.id)])
    assert cards[0] == {"title": "Pricing", "description": "How to price."}
    assert {c["title"] for c in cards[1:]} == {"Annual Raises", "Grandfathering"} and not angles["focus"]


def test_a_chats_cited_posts_get_tagged_and_locked_ones_are_skipped(client, owner, db_session, angles):
    headers, ws = owner
    fresh = add_doc(db_session, ws, "https://ada.example.com/p/fresh", "New post. " * 20)
    fresh.title = "Fresh"
    locked = add_doc(db_session, ws, "https://ada.example.com/p/locked")
    locked.title, locked.path, locked.metadata_json = "Locked", None, {"locked": True}
    db_session.commit()
    angles["tag_answers"] = {"Fresh": ["Pricing", "Churn"]}
    chat = add_chat(db_session, ws, [("user", "Q?"), ("assistant", "An answer [1] [2].")])
    cite(db_session, chat, fresh, locked)
    cards = focus(client, headers, chat_ids=[str(chat.id)])
    assert angles["tagged"] == [["Fresh"]] and {c["title"] for c in cards} == {"Pricing", "Churn"}


def test_a_chat_without_citations_gets_ai_topics(client, owner, db_session, angles):
    headers, ws = owner
    chat = add_chat(db_session, ws, [("user", "Hi there"), ("assistant", "Hello! Ask me about your posts.")])
    cards = focus(client, headers, chat_ids=[str(chat.id)])
    assert len(cards) == 3 and angles["focus"] and not angles["tagged"]
    assert angles["focus"][0]["items"] == ["Pricing chat\nHi there\nHello! Ask me about your posts."]


@pytest.mark.parametrize("style,length,words", [("custom:20", "short", "overview of that topic"),
                                                ("custom:21", "medium", "deep dive into that topic")])
def test_focus_goes_ahead_of_the_material_worded_for_the_style(client, b2v, owner, house, db_session,
                                                               style, length, words):
    headers, ws = owner
    doc = add_doc(db_session, ws, "https://ada.example.com/p/a", "Raise prices once a year, and say why. " * 3)
    make_video(client, headers, url=None, document_id=str(doc.id), video_style=style, focus="Annual raises",
               focus_detail="One raise a year, announced early.  Why readers accept it.")
    sent = creates(b2v)[-1]["json"]
    assert "url" not in sent and sent["video_length"] == length  # a focus needs the text, not the link
    head, material = sent["content"].split("\n\n---\n\n", 1)
    assert head.index('"Annual raises"') < head.index("What to cover: One raise a year, announced early. Why "
                                                      "readers accept it.") < head.index(words)
    assert material.startswith("Raise prices")
    # The topic alone (no description) still works, without the "What to cover" part.
    make_video(client, headers, url=None, document_id=str(doc.id), video_style=style, focus="Annual raises")
    head = creates(b2v)[-1]["json"]["content"].split("\n\n---\n\n", 1)[0]
    assert '"Annual raises"' in head and "What to cover" not in head


@pytest.mark.parametrize("style,depth", [("custom:20", "Make it a brief overview."),
                                         ("custom:21", "Make it a deep dive.")])
def test_a_custom_topic_goes_ahead_of_the_material(client, b2v, owner, house, db_session, style, depth):
    headers, ws = owner
    doc = add_doc(db_session, ws, "https://ada.example.com/p/a", "Raise prices once a year, and say why. " * 3)
    make_video(client, headers, url=None, document_id=str(doc.id), video_style=style,
               focus_prompt='  Why the  "yearly" raise\nbeats small ones ')
    sent = creates(b2v)[-1]["json"]
    assert "url" not in sent  # the instruction needs the text, not the link
    head, material = sent["content"].split("\n\n---\n\n", 1)
    assert head.startswith("The user wants this video to focus on: \"Why the 'yearly' raise beats small ones\".")
    assert "only as far as the material below supports it" in head and "make a general video" in head
    assert head.endswith(depth) and material.startswith("Raise prices")


def test_a_blank_custom_topic_is_no_focus(client, b2v, owner, db_session):
    headers, ws = owner
    doc = add_doc(db_session, ws, "https://ada.example.com/p/a", "Raise prices once a year, and say why. " * 3)
    make_video(client, headers, url=None, document_id=str(doc.id), focus_prompt="   ")
    assert creates(b2v)[-1]["json"]["url"] == "https://ada.example.com/p/a"  # the link, as with no focus


def test_a_suggested_and_a_custom_topic_together_are_refused(client, b2v, owner, db_session):
    headers, ws = owner
    doc = add_doc(db_session, ws, "https://ada.example.com/p/a", "Raise prices once a year, and say why. " * 3)
    r = client.post("/api/videos", json={"document_id": str(doc.id), "focus": "Annual raises",
                                         "focus_prompt": "My own angle"}, headers=headers)
    assert r.status_code == 422 and "not both" in r.text and not creates(b2v)


def test_chat_with_a_focus_keeps_the_chat_context_first(client, b2v, owner, house, db_session):
    from app.routers.videos import CHAT_CONTEXT
    headers, ws = owner
    chat = add_chat(db_session, ws, [("user", "How often should I raise prices?"),
                                     ("assistant", "Once a year, and tell readers why it is happening.")])
    make_video(client, headers, url=None, chat_ids=[str(chat.id)], video_style="custom:20", focus="Annual raises")
    content = creates(b2v)[-1]["json"]["content"]
    assert content.startswith(CHAT_CONTEXT) and content.index('"Annual raises"') < content.index("User:")


# Premium (★) and per-workspace counters


@pytest.mark.parametrize("body", [{"video_length": "detailed"}, {"video_length": "more_detailed"},
                                  {"custom_voice_id": BELLA}, {"voice_emotion": '["0.5","1.0","calm","0","1"]'},
                                  {"template": "crafted_neon"}])
def test_premium_options_refused_on_free(client, b2v, owner, free_plan, db_session, body):
    headers, ws = owner
    r = client.post("/api/videos", json={"url": "https://a.test/x", **body}, headers=headers)
    assert r.status_code == 402 and r.json()["detail"]["kind"] == "video_premium" and not creates(b2v)
    assert r.json()["detail"]["upgrade_to"] == "writer"


def test_free_plan_can_make_a_plain_video(client, b2v, owner, free_plan):
    make_video(client, owner[0], custom_voice_id=SARAH)


def test_ai_edits_counted_and_given_back_on_failure(client, b2v, owner, db_session):
    headers, ws = owner
    art = make_video(client, headers)
    r = client.post(f"/api/videos/{art['id']}/p/scenes/1/regenerate", json={"description": "x"}, headers=headers)
    assert r.status_code == 200 and video_limits.used(db_session, ws.id, "ai_edits") == 1
    b2v.queue("POST", "/api/projects/812/scenes/1/regenerate", (409, {"detail": "busy"}))
    r = client.post(f"/api/videos/{art['id']}/p/scenes/1/regenerate", json={}, headers=headers)
    assert r.status_code == 409 and video_limits.used(db_session, ws.id, "ai_edits") == 1


def test_ai_edits_stop_at_the_workspace_limit(client, b2v, owner, db_session):
    headers, ws = owner
    art = make_video(client, headers)
    db_session.add(UsageCounter(workspace_id=ws.id, period=video_limits.period_key("ai_edits"), metric="ai_edits",
                                used=1000))
    db_session.commit()
    b2v.calls.clear()
    r = client.post(f"/api/videos/{art['id']}/p/chat", json={"message": "shorter"}, headers=headers)
    assert r.status_code == 402 and r.json()["detail"]["kind"] == "video_limits.ai_edits" and b2v.calls == []


def test_avatar_batch_charges_ten_per_scene(client, b2v, owner, db_session):
    headers, ws = owner
    art = make_video(client, headers)
    r = client.post(f"/api/videos/{art['id']}/p/avatar-batch/authorize", json={"scene_ids": [1, 2, 3]},
                    headers=headers)
    assert r.status_code == 200 and video_limits.used(db_session, ws.id, "ai_edits") == 30


def test_template_switch_uses_a_video_and_checks_the_template(client, b2v, owner, theirs, db_session):
    headers, ws = owner
    art = make_video(client, headers)
    r = client.post(f"/api/videos/{art['id']}/p/change-template-regenerate-layouts", json={"template": "custom_77"},
                    headers=headers)
    assert r.status_code == 404 and used(db_session, ws) == 1
    r = client.post(f"/api/videos/{art['id']}/p/change-template-regenerate-layouts", json={"template": "geometric"},
                    headers=headers)
    assert r.status_code == 200 and used(db_session, ws) == 2


# Edit jobs keep blog2video's own status on the artifact (not "generating"), so the list and editor can tell them apart


def artifact_status(db, art) -> str:
    db.expire_all()
    return db.get(Artifact, uuid.UUID(art["id"])).status


@pytest.mark.parametrize("raw", ["regenerating", "voice_regenerating", "language_regenerating", "script_regenerating"])
def test_an_edit_job_keeps_blog2videos_status(client, b2v, owner, db_session, raw):
    headers, _ = owner
    art = make_video(client, headers)
    b2v.queue("GET", "/api/v1/videos/812/status", (200, {"status": raw, "ready": False}))
    assert client.get(f"/api/videos/{art['id']}/status", headers=headers).json()["artifact_status"] == raw
    assert artifact_status(db_session, art) == raw


def test_starting_a_template_switch_marks_the_video(client, b2v, owner, db_session):
    headers, _ = owner
    art = make_video(client, headers)
    r = client.post(f"/api/videos/{art['id']}/p/change-template-regenerate-layouts", json={"template": "geometric"},
                    headers=headers)
    assert r.status_code == 200 and artifact_status(db_session, art) == "regenerating"


def test_the_list_rechecks_a_video_whose_job_ended_unwatched(client, b2v, owner, db_session):
    headers, _ = owner
    art = make_video(client, headers)
    b2v.queue("GET", "/api/v1/videos/812/status", (200, {"status": "regenerating", "ready": False}),
              (200, {"status": "generated", "ready": True}))
    client.get(f"/api/videos/{art['id']}/status", headers=headers)
    assert artifact_status(db_session, art) == "regenerating"
    listed = client.get("/api/videos", headers=headers).json()
    assert listed[0]["status"] == "ready" and listed[0]["b2v_status"] == "generated"


def test_editor_proxy_only_allows_listed_paths(client, b2v, owner):
    headers, _ = owner
    art = make_video(client, headers)
    b2v.calls.clear()
    for method, path in [("GET", "members"), ("POST", "review"), ("POST", "launch-studio"), ("GET", "../../auth/me")]:
        assert client.request(method, f"/api/videos/{art['id']}/p/{path}", headers=headers).status_code == 404
    assert b2v.calls == []


def test_editor_passes_downloads_through(client, b2v, owner):
    headers, _ = owner
    art = make_video(client, headers)
    r = client.get(f"/api/videos/{art['id']}/p/download", headers=headers)
    assert r.status_code == 200 and r.content == b"ID3audio" and r.headers["content-type"] == "audio/mpeg"


def test_editor_premium_features_refused_on_free(client, b2v, owner, free_plan):
    headers, _ = owner
    art = make_video(client, headers)
    for method, path in [("POST", "chat"), ("GET", "download-studio"), ("POST", "avatar-portrait")]:
        r = client.request(method, f"/api/videos/{art['id']}/p/{path}", json={}, headers=headers)
        assert r.status_code == 402, path


# Script review


def test_script_review_flow(client, b2v, owner, db_session):
    headers, ws = owner
    art = make_video(client, headers)
    scenes = client.get(f"/api/videos/{art['id']}/script", headers=headers).json()["scenes"]
    assert [s["id"] for s in scenes] == [1, 2]
    draft = {"title": "A", "display_text": "Text", "narration_text": "", "draft_scenes": [], "revision": 1}
    client.post(f"/api/videos/{art['id']}/script/scenes/1/ai-preview", json={**draft, "instruction": "punchier"},
                headers=headers)
    assert video_limits.used(db_session, ws.id, "ai_edits") == 1
    r = client.post(f"/api/videos/{art['id']}/script/approve",
                    json={"scenes": [{"id": 1, "title": "A", "narration_text": "Hi"}]}, headers=headers)
    assert r.status_code == 200 and "/api/projects/812/script-review/approve" in b2v.paths("POST")


# Status, refunds, sweep


def test_failure_refunds_once_from_poller_and_sweep(client, b2v, owner, db_session, session_factory):
    headers, ws = owner
    art = make_video(client, headers)
    failed = (200, {"status": "failed", "step": 1, "running": False, "error": "unreachable url"})
    b2v.queue("GET", "/api/v1/videos/812/status", failed, failed)
    assert client.get(f"/api/videos/{art['id']}/status", headers=headers).json()["artifact_status"] == "failed"
    assert used(db_session, ws) == 0
    client.get(f"/api/videos/{art['id']}/status", headers=headers)
    age(db_session, db_session.scalar(select(B2VVideo)))
    video_quota.sweep_failed_videos(session_factory)
    assert used(db_session, ws) == 0


def test_sweep_refunds_videos_nobody_polled(client, b2v, owner, db_session, session_factory):
    headers, ws = owner
    art = make_video(client, headers)
    age(db_session, db_session.scalar(select(B2VVideo)))
    b2v.queue("GET", "/api/v1/videos/812/status", (404, {"detail": "Not found"}))
    assert video_quota.sweep_failed_videos(session_factory) == 1
    db_session.expire_all()
    assert used(db_session, ws) == 0 and db_session.get(Artifact, uuid.UUID(art["id"])).status == "failed"


def test_a_finished_video_is_not_refunded_by_a_later_error(client, b2v, owner, db_session):
    headers, ws = owner
    art = make_video(client, headers)
    b2v.queue("GET", "/api/v1/videos/812/status", (200, {"status": "generated", "ready": True}),
              (200, {"status": "error", "error": "a later edit failed"}))
    client.get(f"/api/videos/{art['id']}/status", headers=headers)
    client.get(f"/api/videos/{art['id']}/status", headers=headers)
    assert used(db_session, ws) == 1 and db_session.scalar(select(B2VVideo)).quota_state == "kept"


def test_legacy_video_shows_stored_links_and_refuses_edits(client, b2v, owner, db_session):
    headers, ws = owner
    a = Artifact(workspace_id=ws.id, type="video", status="ready",
                 content_json={"provider": "blog2video", "b2v_video_id": 99, "video_url": "https://cdn.test/old.mp4"})
    db_session.add(a)
    db_session.commit()
    got = client.get(f"/api/videos/{a.id}", headers=headers).json()
    assert got["legacy"] is True and got["video_url"] == "https://cdn.test/old.mp4"
    assert client.patch(f"/api/videos/{a.id}/p/update-project", json={}, headers=headers).status_code == 410
    assert b2v.calls == []


def test_get_video_mints_the_preview_link_once(client, b2v, owner):
    headers, _ = owner
    art = make_video(client, headers)
    first = client.get(f"/api/videos/{art['id']}", headers=headers).json()
    client.get(f"/api/videos/{art['id']}", headers=headers)
    assert first["preview_url"] == f"{API}/embed/t" and first["project"]["id"] == 812
    assert len([p for p in b2v.paths("POST") if p.startswith("/api/embed/token/")]) == 1


def test_scene_stock_clips_are_read_from_assigned_video(client, b2v, owner):
    headers, _ = owner
    art = make_video(client, headers)
    clip = {"id": 7, "asset_type": "video", "filename": "scene_1_99.mp4", "r2_url": "https://r2.example/clip.mp4",
            "excluded": False}
    still = {"id": 8, "asset_type": "image", "filename": "img_a.webp", "r2_url": "https://r2.example/a.webp",
             "excluded": False}
    code = '{"layout": "news_headline", "layoutProps": {"assignedVideo": "scene_1_99.mp4"}}'
    b2v.queue("GET", "/api/projects/812", (200, {"id": 812, "status": "generated", "assets": [clip, still],
                                                  "scenes": [{"id": 1, "order": 1, "title": "A", "remotion_code": code}]}))
    project = client.get(f"/api/videos/{art['id']}", headers=headers).json()["project"]
    assert project["scenes"][0]["images"] == [{"filename": "scene_1_99.mp4", "asset_id": 7, "kind": "video",
                                               "url": "https://r2.example/clip.mp4"}]
    assert project["summary"]["images"] == 1 and project["summary"]["clips"] == 1


def test_delete_removes_it_from_blog2video(client, b2v, owner):
    headers, _ = owner
    art = make_video(client, headers)
    assert client.delete(f"/api/videos/{art['id']}", headers=headers).status_code == 200
    assert "/api/projects/812" in b2v.paths("DELETE")


def test_capacity_alert(b2v, caplog):
    with caplog.at_level(logging.ERROR):
        video_quota.check_capacity()
    assert "ALERT" in caplog.text and "videos 145/150" in caplog.text


# Voices


def test_new_workspace_gets_starter_voices_and_library(client, b2v, owner):
    got = client.get("/api/video-voices", headers=owner[0]).json()
    assert [v["voice_id"] for v in got["saved"]] == [SARAH]  # free voices only
    assert {v["voice_id"]: v["premium"] for v in got["library"]} == {SARAH: False, BELLA: True}


def test_saving_a_paid_voice_needs_premium(client, b2v, owner, free_plan):
    r = client.post("/api/video-voices/saved", json={"voice_id": BELLA}, headers=owner[0])
    assert r.status_code == 402


def test_saved_voices_never_touch_blog2video_saved_list(client, b2v, owner, db_session):
    headers, _ = owner
    client.post("/api/video-voices/saved", json={"voice_id": BELLA}, headers=headers)
    client.delete(f"/api/video-voices/saved/{BELLA}", headers=headers)
    assert not [p for p in b2v.paths() if "/voices/saved" in p]


def notestack_voice(db, ws, voice_id="nv_narrator", name="Narrator") -> None:
    """A voice the workspace designed on the Voice page (same ElevenLabs account as blog2video)."""
    db.add(VoiceProfile(workspace_id=ws.id, host_voices={"custom": [{"voice_id": voice_id, "name": name}]}))
    db.commit()


def test_any_number_of_voices_can_be_saved(client, b2v, owner, db_session):
    headers, ws = owner
    client.get("/api/video-voices", headers=headers)  # the starter voice
    for i in range(7):
        db_session.add(UserSavedVoice(workspace_id=ws.id, voice_id=f"v{i}", name=f"V{i}"))
    db_session.commit()
    assert client.post("/api/video-voices/saved", json={"voice_id": BELLA}, headers=headers).status_code == 201
    got = client.get("/api/video-voices", headers=headers).json()
    assert len(got["saved"]) == 9 and "max_saved" not in got


def test_notestack_voices_can_be_saved_and_used_in_a_video(client, b2v, owner, other, db_session):
    headers, ws = owner
    notestack_voice(db_session, ws)
    got = client.get("/api/video-voices", headers=headers).json()
    assert got["notestack"] == [{"voice_id": "nv_narrator", "name": "Narrator", "kind": "designed", "saved": False}]
    r = client.post("/api/video-voices/saved", json={"voice_id": "nv_narrator"}, headers=headers)
    assert r.status_code == 201 and r.json()["source"] == "notestack" and r.json()["premium"]
    saved = client.get("/api/video-voices", headers=headers).json()["saved"]
    assert [v["source"] for v in saved if v["voice_id"] == "nv_narrator"] == ["notestack"]
    make_video(client, headers, custom_voice_id="nv_narrator")
    assert creates(b2v)[-1]["json"]["custom_voice_id"] == "nv_narrator"
    # Another workspace cannot use it.
    r = client.post("/api/videos", json={"url": "https://a.test/x", "custom_voice_id": "nv_narrator"},
                    headers=other[0])
    assert r.status_code == 404


def test_notestack_voices_are_saved_on_any_plan_but_need_premium_in_videos(client, b2v, owner, db_session,
                                                                          free_plan):
    headers, ws = owner
    notestack_voice(db_session, ws)
    assert client.post("/api/video-voices/saved", json={"voice_id": "nv_narrator"},
                       headers=headers).status_code == 201  # in the list, for audio overviews
    r = client.post("/api/videos", json={"url": "https://a.test/x", "custom_voice_id": "nv_narrator"}, headers=headers)
    assert r.status_code == 402 and not creates(b2v)


def test_revoking_the_clone_drops_it_from_video_voices(client, b2v, owner, db_session, monkeypatch):
    headers, ws = owner
    monkeypatch.setattr(settings, "elevenlabs_api_key", "")  # no call out to delete the voice
    user_id = db_session.scalar(select(User.id))
    db_session.add(VoiceConsent(workspace_id=ws.id, user_id=user_id, sample_key="ws/x/sample.mp3",
                                consent_text="ok", elevenlabs_voice_id="nv_clone"))
    db_session.commit()
    assert client.post("/api/video-voices/saved", json={"voice_id": "nv_clone"}, headers=headers).status_code == 201
    client.delete("/api/voice/consent", headers=headers)
    assert "nv_clone" not in [v["voice_id"] for v in client.get("/api/video-voices", headers=headers).json()["saved"]]


def test_design_keep_and_delete_a_custom_voice(client, b2v, owner, other, db_session):
    headers, ws = owner
    previews = client.post("/api/video-voices/design/prompt", json={"prompt": "A calm, warm narrator voice please"},
                           headers=headers).json()["previews"]
    kept = client.post("/api/video-voices/custom", json={"generated_voice_id": previews[0]["generated_voice_id"],
                                                         "source": "prompt", "name": "Narrator"}, headers=headers)
    assert kept.status_code == 201
    assert db_session.get(UserSavedVoice, {"workspace_id": ws.id, "voice_id": "vc_designed"}).is_custom
    assert video_limits.used(db_session, ws.id, "voice_designs_daily") == 1
    assert video_limits.used(db_session, ws.id, "custom_voices") == 1
    # Another workspace can not play or delete it, nor use it on a video.
    assert client.get("/api/video-voices/custom/31/preview", headers=other[0]).status_code == 404
    assert client.delete("/api/video-voices/custom/31", headers=other[0]).status_code == 404
    r = client.post("/api/videos", json={"url": "https://a.test/x", "custom_voice_id": "vc_designed"},
                    headers=other[0])
    assert r.status_code == 404
    assert client.delete("/api/video-voices/custom/31", headers=headers).status_code == 200
    assert video_limits.used(db_session, ws.id, "custom_voices") == 0


def test_clone_voice(client, b2v, owner):
    r = client.post("/api/video-voices/clone", data={"name": "Me"}, files={"file": ("me.mp3", b"ID3", "audio/mpeg")},
                    headers=owner[0])
    assert r.status_code == 201 and r.json()["voice_id"] == "vc_clone"


def test_voice_sample_returns_audio_and_counts(client, b2v, owner, db_session):
    headers, ws = owner
    r = client.post("/api/video-voices/sample", json={"custom_voice_id": SARAH}, headers=headers)
    assert r.status_code == 200 and r.content == b"ID3audio"
    assert video_limits.used(db_session, ws.id, "voice_samples_daily") == 1


# Styles


def test_styles_are_per_workspace(client, b2v, owner, other, db_session):
    headers, ws = owner
    made = client.post("/api/video-styles", json={"name": "Punchy", "guidance": "Punchy."}, headers=headers).json()
    assert made["id"] == "custom:41" and db_session.get(B2VStyle, 41).workspace_id == ws.id
    assert client.patch("/api/video-styles/41", json={"name": "x", "guidance": "y", "version": 0},
                        headers=other[0]).status_code == 404
    assert client.delete("/api/video-styles/41", headers=other[0]).status_code == 404


# Templates


def test_custom_templates_are_switched_off(client, b2v, owner):
    headers, _ = owner
    assert client.post("/api/video-templates/extract/prompt", json={"prompt": "x"}, headers=headers).status_code == 404
    assert client.post("/api/video-templates", json={"name": "x", "theme": {}}, headers=headers).status_code == 404
    assert client.get("/api/video-templates", headers=headers).status_code == 404
    assert b2v.calls == []


@pytest.mark.skip(reason="custom templates are switched off (video_templates is not mounted)")
def test_template_create_generate_and_ready(client, b2v, owner, db_session):
    headers, ws = owner
    theme = client.post("/api/video-templates/extract/prompt", json={"prompt": "A bold dark brand with neon"},
                        headers=headers).json()
    made = client.post("/api/video-templates", json={"name": "Brand", "theme": theme["theme"]}, headers=headers)
    assert made.status_code == 201 and made.json()["ref"] == "custom_58"
    client.post("/api/video-templates/58/generate", headers=headers)
    b2v.queue("GET", "/api/custom-templates/58/generation-status", (200, {"status": "complete"}))
    assert client.get("/api/video-templates/58/generation-status", headers=headers).json()["ready"] is True
    assert video_limits.used(db_session, ws.id, "templates") == 1
    assert video_limits.used(db_session, ws.id, "template_ai_daily") == 2


@pytest.mark.skip(reason="custom templates are switched off (video_templates is not mounted)")
def test_free_plan_can_not_start_a_template(client, b2v, owner, free_plan):
    r = client.post("/api/video-templates/extract/url", json={"url": "https://brand.test"}, headers=owner[0])
    assert r.status_code == 402 and b2v.calls == []


@pytest.mark.skip(reason="custom templates are switched off (video_templates is not mounted)")
def test_template_delete_forces_only_over_own_videos(client, b2v, owner, other, db_session):
    headers, ws = owner
    db_session.add(B2VTemplate(b2v_template_id=58, workspace_id=ws.id, name="Mine", ready=True))
    db_session.add(B2VVideo(workspace_id=other[1].id, b2v_video_id=5, template_ref="custom_58"))
    db_session.commit()
    b2v.queue("DELETE", "/api/custom-templates/58", (409, {"detail": {"error": "template_in_use"}}))
    assert client.delete("/api/video-templates/58", headers=headers).status_code == 409
    db_session.query(B2VVideo).delete()
    db_session.commit()
    b2v.queue("DELETE", "/api/custom-templates/58", (409, {"detail": {"error": "template_in_use"}}))
    assert client.delete("/api/video-templates/58", headers=headers).status_code == 200
    assert b2v.calls[-1]["params"] == {"force": "true"}


@pytest.mark.skip(reason="custom templates are switched off (video_templates is not mounted)")
def test_template_editor_is_per_workspace_and_allowlisted(client, b2v, owner, other, db_session):
    headers, ws = owner
    db_session.add(B2VTemplate(b2v_template_id=58, workspace_id=ws.id, name="Mine", ready=True))
    db_session.commit()
    assert client.get("/api/video-templates/58/p/versions", headers=headers).status_code == 200
    assert client.get("/api/video-templates/58/p/versions", headers=other[0]).status_code == 404
    assert client.get("/api/video-templates/58/p/internal/ids", headers=headers).status_code == 404
    r = client.post("/api/video-templates/58/p/scenes/intro/ai-edit", json={"prompt": "bigger"}, headers=headers)
    assert r.status_code == 200 and video_limits.used(db_session, ws.id, "ai_edits") == 1


# Quota bookkeeping


def test_sync_follows_effective_plan(client, owner, db_session, monkeypatch):
    _, ws = owner
    sub = video_quota.sync_video_quota(db_session, ws)
    assert (sub.video_plan, sub.video_limit) == ("studio", 20)  # billing disabled
    monkeypatch.setattr(settings, "billing_enabled", True)
    sub.plan, sub.status = "writer", "active"
    db_session.commit()
    assert video_quota.sync_video_quota(db_session, ws).video_limit == 10
    sub.status = "canceled"
    db_session.commit()
    sub = video_quota.sync_video_quota(db_session, ws)
    assert (sub.video_plan, sub.video_limit) == ("free", 1)


def test_monthly_fallback_reset(client, owner, db_session, session_factory):
    _, ws = owner
    sub = video_quota.sync_video_quota(db_session, ws)  # studio (billing disabled): monthly
    now = datetime.now(UTC)
    # No Stripe renewal, period started 40 days ago: resets.
    sub.videos_used, sub.videos_period_start = 1, now - timedelta(days=40)
    db_session.commit()
    assert video_quota.reset_due_video_periods(session_factory) == 1
    db_session.expire_all()
    assert sub.videos_used == 0

    # Monthly Stripe subscription renewing soon: left to invoice.paid.
    sub.videos_used, sub.videos_period_start = 3, now - timedelta(days=40)
    sub.provider_subscription_id, sub.status = "sub_1", "active"
    sub.current_period_end = now - timedelta(days=10)
    db_session.commit()
    assert video_quota.reset_due_video_periods(session_factory) == 0

    # Annual subscription (renews in 11 months): still resets monthly.
    sub.current_period_end = now + timedelta(days=330)
    db_session.commit()
    assert video_quota.reset_due_video_periods(session_factory) == 1


# The video's reference lives on its row


def test_row_holds_the_full_reference(client, b2v, owner, db_session):
    headers, ws = owner
    art = make_video(client, headers)
    row = db_session.scalar(select(B2VVideo))
    assert row.user_id == ws.owner_id and row.artifact_id == uuid.UUID(art["id"])
    assert (row.title, row.source_url, row.aspect_ratio) == ("https://ada.example.com/p/a", "https://ada.example.com/p/a",
                                                              "landscape")
    sent = creates(b2v)[0]["json"]["metadata"]
    assert sent["user_id"] == str(ws.owner_id) and sent["workspace_id"] == str(ws.id)
    assert sent["video_ref"] == str(row.id)
    b2v.queue("GET", "/api/v1/videos/812/status", (200, {"status": "done", "ready": True,
                                                          "video_url": "https://cdn.test/v.mp4"}))
    client.get(f"/api/videos/{art['id']}/status", headers=headers)
    client.get(f"/api/videos/{art['id']}", headers=headers)
    db_session.expire_all()
    assert row.video_url == "https://cdn.test/v.mp4" and row.preview_url == f"{API}/embed/t"


def test_calls_use_the_row_not_the_artifact_copy(client, b2v, owner, db_session):
    headers, _ = owner
    art = make_video(client, headers)
    a = db_session.get(Artifact, uuid.UUID(art["id"]))
    a.content_json = {**a.content_json, "b2v_video_id": 999}  # a stale or tampered copy
    db_session.commit()
    client.patch(f"/api/videos/{art['id']}/p/update-project", json={"accent_color": "#000000"}, headers=headers)
    assert "/api/projects/812/update-project" in b2v.paths("PATCH")


def test_library_delete_removes_it_from_blog2video_and_keeps_the_record(client, b2v, owner, db_session):
    headers, _ = owner
    art = make_video(client, headers)
    assert client.delete(f"/api/artifacts/{art['id']}", headers=headers).status_code == 200
    assert "/api/projects/812" in b2v.paths("DELETE")
    db_session.expire_all()
    row = db_session.scalar(select(B2VVideo))
    assert row.status == "deleted" and row.artifact_id is None


# Video limits: Free 1 in total, Writer 10 a month, Studio 20 a month


def _on_plan(db, ws, plan: str) -> None:
    sub = db.scalar(select(Subscription).where(Subscription.workspace_id == ws.id))
    sub.plan, sub.status = plan, "active"
    db.commit()


def test_plan_video_limits(client, owner, db_session, monkeypatch):
    _, ws = owner
    monkeypatch.setattr(settings, "billing_enabled", True)
    video_quota.sync_video_quota(db_session, ws)
    for plan, limit in (("free", 1), ("writer", 10), ("studio", 20)):
        _on_plan(db_session, ws, plan)
        assert video_quota.sync_video_quota(db_session, ws).video_limit == limit


def test_free_is_one_video_in_total(client, b2v, owner, free_plan, db_session, session_factory):
    headers, ws = owner
    make_video(client, headers)
    r = client.post("/api/videos", json={"url": "https://a.test/2"}, headers=headers)
    assert r.status_code == 402
    usage = client.get("/api/videos/quota", headers=headers).json()
    assert usage["resets_at"] is None
    sub = db_session.scalar(select(Subscription).where(Subscription.workspace_id == ws.id))
    sub.videos_period_start = datetime.now(UTC) - timedelta(days=90)
    db_session.commit()
    assert video_quota.reset_due_video_periods(session_factory) == 0  # never refills
    # Deleting the video does not give it back.
    art_id = db_session.scalar(select(B2VVideo)).artifact_id
    client.delete(f"/api/videos/{art_id}", headers=headers)
    assert client.post("/api/videos", json={"url": "https://a.test/3"}, headers=headers).status_code == 402


def test_free_video_that_failed_is_given_back(client, b2v, owner, free_plan, db_session):
    headers, ws = owner
    b2v.queue("POST", "/api/v1/videos", (422, {"detail": "bad url"}))
    assert client.post("/api/videos", json={"url": "https://a.test/1"}, headers=headers).status_code == 400
    make_video(client, headers)


def test_dropping_to_free_counts_what_was_made(client, b2v, owner, db_session, monkeypatch):
    headers, ws = owner
    monkeypatch.setattr(settings, "billing_enabled", True)
    video_quota.sync_video_quota(db_session, ws)
    _on_plan(db_session, ws, "writer")
    for i in range(3):
        make_video(client, headers, url=f"https://a.test/{i}")
    _on_plan(db_session, ws, "free")
    usage = client.get("/api/videos/quota", headers=headers).json()
    assert (usage["used"], usage["limit"]) == (3, 1)
    assert client.post("/api/videos", json={"url": "https://a.test/x"}, headers=headers).status_code == 402


def test_list_restores_a_video_whose_library_item_went_missing(client, b2v, owner, db_session):
    headers, _ = owner
    art = make_video(client, headers)
    row = db_session.scalar(select(B2VVideo))
    row.artifact_id, row.status = None, "generated"
    db_session.delete(db_session.get(Artifact, uuid.UUID(art["id"])))
    db_session.commit()
    listed = client.get("/api/videos", headers=headers).json()
    assert len(listed) == 1 and listed[0]["status"] == "ready"
    b2v.calls.clear()
    client.get(f"/api/videos/{listed[0]['id']}/status", headers=headers)
    assert "/api/v1/videos/812/status" in b2v.paths("GET")  # the same blog2video video
    assert len(client.get("/api/videos", headers=headers).json()) == 1  # restored once

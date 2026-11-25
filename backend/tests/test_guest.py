"""Guests: the iOS app without an account. The free allowance is the device's, once, and never resets."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.config import settings
from app.models import (
    Artifact,
    AuthProvider,
    B2VVideo,
    Document,
    GuestDevice,
    Job,
    Notebook,
    Source,
    Subscription,
    User,
    Workspace,
)
from app.routers import auth as auth_router
from app.services import account_purge, device_check, guests, video_limits, video_quota
from app.services.billing import apply_subscription
from app.services.email import ConsoleEmailProvider
from app.services.plans import GUEST_PLAN, PLANS, effective_plan
from app.worker import mark_artifact_failed
from tests.conftest import last_code
from tests.test_auth import _signup
from tests.test_auth_apple import apple, apple_token  # noqa: F401  (fixture)
from tests.test_videos import b2v, creates  # noqa: F401  (fixture)

IOS = {"X-Client-Platform": "ios"}


@pytest.fixture(autouse=True)
def apple_bits(monkeypatch):
    """Apple's two bits per device token, as DeviceCheck keeps them."""
    bits: dict[str, int] = {}

    def read(token):
        if token == "bad":
            raise device_check.DeviceCheckInvalid("Bad Device Token")
        if token == "down":
            raise device_check.DeviceCheckUnavailable("timeout")
        return bits.get(token, 0)

    monkeypatch.setattr(device_check, "read", read)
    monkeypatch.setattr(device_check, "write", lambda token, epoch: bits.__setitem__(token, epoch))
    monkeypatch.setattr(settings, "billing_enabled", True)
    monkeypatch.setattr(settings, "env", "test")  # development has no caps
    guests._made.clear()
    return bits


def open_guest(client, device=None, token="phone", **headers):
    return client.post("/api/auth/guest", json={"device_id": str(device or uuid.uuid4()), "device_token": token},
                       headers={**IOS, **headers})


def guest(client, device=None, token="phone"):
    r = open_guest(client, device, token)
    assert r.status_code == 200, r.text
    data = r.json()
    return data, {"Authorization": f"Bearer {data['access_token']}", **IOS}


def workspace_of(db, data) -> Workspace:
    return db.scalar(select(Workspace).where(Workspace.owner_id == uuid.UUID(data["user"]["id"])))


def add_posts(db, workspace, n=1):
    source = db.scalar(select(Source).where(Source.workspace_id == workspace.id))
    if not source:
        source = Source(workspace_id=workspace.id, feed_url="https://a.example.com/feed", title="A")
        db.add(source)
        db.flush()
    docs = [Document(workspace_id=workspace.id, source_id=source.id, title="Post", url=f"https://a.example.com/{uuid.uuid4()}",
                     path=f"posts/{uuid.uuid4()}.md", content_hash="h") for _ in range(n)]
    db.add_all(docs)
    db.commit()
    return docs


def notebook(db, workspace) -> Notebook:
    nb = Notebook(workspace_id=workspace.id, title="Mine")
    db.add(nb)
    db.commit()
    return nb


def make(client, headers, db, data, type_, **extra):
    ws = workspace_of(db, data)
    nb = db.scalar(select(Notebook).where(Notebook.workspace_id == ws.id)) or notebook(db, ws)
    doc = db.scalar(select(Document).where(Document.workspace_id == ws.id)) or add_posts(db, ws)[0]
    target = {"document_id": str(doc.id)} if type_ == "launch_kit" else {"notebook_id": str(nb.id)}
    return client.post("/api/artifacts/generate", json={"type": type_, **target, **extra}, headers=headers)


# Opening


def test_a_guest_has_no_personal_details_and_gets_no_email(client, db_session):
    data, headers = guest(client)
    assert data["created"] and data["allowance"] and data["verified"]
    assert data["user"]["is_guest"] and data["user"]["email"] == "" and data["user"]["name"] is None
    assert client.get("/api/settings", headers=headers).json()["user"]["email"] == ""
    assert client.get("/api/billing/status", headers=headers).json()["plan"]["id"] == "guest"
    user = db_session.get(User, uuid.UUID(data["user"]["id"]))
    assert user.email_unsubscribed and user.email.endswith("@guest.invalid")
    assert not ConsoleEmailProvider.sent
    assert db_session.scalar(select(GuestDevice)).device_hash != data["user"]["id"]


def test_guest_mode_is_ios_only(client, monkeypatch):
    body = {"device_id": str(uuid.uuid4()), "device_token": "phone"}
    assert client.post("/api/auth/guest", json=body).status_code == 403
    assert client.post("/api/auth/guest", json=body, headers={"X-Client-Platform": "android"}).status_code == 403
    monkeypatch.setattr(settings, "guest_mode_enabled", False)
    assert open_guest(client).status_code == 403


def test_the_same_phone_gets_its_guest_back(client):
    device = uuid.uuid4()
    first, _ = guest(client, device)
    again, _ = guest(client, device)
    assert again["user"]["id"] == first["user"]["id"] and not again["created"] and again["allowance"]


def test_leaving_guest_mode_and_coming_back_finds_the_work(client, db_session):
    device = uuid.uuid4()
    data, headers = guest(client, device)
    nb = notebook(db_session, workspace_of(db_session, data))
    assert make(client, headers, db_session, data, "report").status_code == 200
    assert client.post("/api/auth/logout", headers=headers).status_code == 200
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    again, fresh = guest(client, device)
    assert again["user"]["id"] == data["user"]["id"] and not again["created"]
    assert client.get(f"/api/notebooks/{nb.id}", headers=fresh).status_code == 200
    assert make(client, fresh, db_session, again, "report").status_code == 402  # and what was used stays used


def test_a_reinstall_that_lost_the_keychain_gets_no_second_allowance(client, db_session):
    guest(client, token="phone")
    data, headers = guest(client, token="phone")  # a new device id, the same iPhone to Apple
    assert data["created"] and data["allowance"] is False
    r = make(client, headers, db_session, data, "report")
    assert r.status_code == 402 and r.json()["detail"]["plan"] == "guest"
    assert client.get("/api/notebooks", headers=headers).status_code == 200  # still usable: look around, subscribe, sign up


def test_a_token_apple_rejects_is_refused(client, db_session):
    assert open_guest(client, token="bad").status_code == 403
    assert db_session.scalar(select(GuestDevice)) is None


def test_apple_unreachable_falls_back_to_the_device_with_tighter_caps(client, apple_bits, monkeypatch):
    monkeypatch.setattr(guests, "UNVERIFIED_PER_IP_HOUR", 2)
    device = uuid.uuid4()
    data, _ = guest(client, device, token="down")
    assert data["allowance"] and data["verified"] is False
    assert guest(client, device, token="down")[0]["user"]["id"] == data["user"]["id"]
    assert open_guest(client, token="down").status_code == 200
    assert open_guest(client, token="down").status_code == 429
    # Back up: the flag is written the next time this device asks.
    assert guest(client, device, token="phone")[0]["verified"] and apple_bits["phone"] == 1


def test_a_faked_forwarded_address_does_not_dodge_the_cap(client, monkeypatch):
    monkeypatch.setattr(guests, "UNVERIFIED_PER_IP_HOUR", 2)
    got = [open_guest(client, token="down", **{"X-Forwarded-For": f"10.0.0.{i}, 203.0.113.9"}).status_code for i in range(4)]
    assert got == [200, 200, 429, 429]


def test_daily_cap(client, monkeypatch):
    monkeypatch.setattr(settings, "guest_daily_cap", 1)
    assert open_guest(client, token="a").status_code == 200
    assert open_guest(client, token="b").status_code == 429


# The allowance


@pytest.mark.parametrize("type_", ["audio_overview", "report", "infographic", "launch_kit"])
@pytest.mark.parametrize("billing", [True, False])
def test_one_of_each(client, db_session, monkeypatch, type_, billing):
    monkeypatch.setattr(settings, "billing_enabled", billing)
    data, headers = guest(client)
    assert make(client, headers, db_session, data, type_).status_code == 200
    r = make(client, headers, db_session, data, type_)
    assert r.status_code == 402 and r.json()["detail"]["plan"] == "guest"


def test_study_items(client, db_session):
    data, headers = guest(client)
    for type_ in ("quiz", "flashcards", "mind_map"):
        assert make(client, headers, db_session, data, type_).status_code == 200
    assert make(client, headers, db_session, data, "slide_deck").status_code == 402
    meters = client.get("/api/billing/status", headers=headers).json()["more_meters"]
    assert next(m for m in meters if m["key"] == "study_items")["used"] == 3


def test_voice_cloning_is_paid_only(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "elevenlabs_api_key", "k")
    data, headers = guest(client)
    ws = workspace_of(db_session, data)
    assert effective_plan(db_session, ws) is GUEST_PLAN and "guest" not in PLANS
    body = {"agreed": True, "consent_text": "x", "upload_ids": []}
    assert client.post("/api/voice/consent", json=body, headers=headers).status_code == 402
    assert PLANS["free"].voice_cloning is False
    apply_subscription(db_session, ws.id, plan="starter", status="active", provider="app_store")
    assert client.post("/api/voice/consent", json=body, headers=headers).status_code != 402


def _quota(client, headers):
    q = client.get("/api/videos/quota", headers=headers).json()
    return q["used"], q["limit"], q["resets_at"]


def _video(client, headers):
    return client.post("/api/videos", json={"url": "https://ada.example.com/p"}, headers=headers)


def test_one_video_per_device_for_good(client, db_session, b2v):  # noqa: F811
    device = uuid.uuid4()
    data, headers = guest(client, device)
    assert _quota(client, headers) == (0, 1, None)
    r = _video(client, headers)
    assert r.status_code == 201, r.text
    assert _quota(client, headers) == (1, 1, None)
    for _ in range(2):
        r = _video(client, headers)
        assert r.status_code == 402 and r.json()["detail"]["plan"] == "guest"
    # Not with the month, not by deleting everything, not with a new guest on the same phone.
    sub = db_session.scalar(select(Subscription).where(Subscription.workspace_id == workspace_of(db_session, data).id))
    sub.videos_period_start = datetime.now(UTC) - timedelta(days=400)
    db_session.commit()
    from contextlib import nullcontext

    assert video_quota.reset_due_video_periods(lambda: nullcontext(db_session)) == 0
    assert _video(client, headers).status_code == 402
    client.post("/api/auth/delete-account", headers=headers)
    _, headers = guest(client, device)
    assert _quota(client, headers)[:2] == (1, 1) and _video(client, headers).status_code == 402
    assert len(creates(b2v)) == 1


def test_a_video_that_fails_is_given_back_once(client, db_session, b2v):  # noqa: F811
    data, headers = guest(client)
    made = _video(client, headers).json()
    row = db_session.scalar(select(B2VVideo).where(B2VVideo.artifact_id == uuid.UUID(made["id"])))
    assert video_quota.refund(db_session, row, "failed") and not video_quota.refund(db_session, row, "failed")
    assert _quota(client, headers)[0] == 0
    assert _video(client, headers).status_code == 201
    assert video_quota.recharge(db_session, row)  # it finished after all: counted, never past the one
    assert _quota(client, headers)[0] == 1


def test_a_subscribed_guest_has_the_plans_videos_then_the_used_one(client, db_session, b2v):  # noqa: F811
    data, headers = guest(client)
    ws = workspace_of(db_session, data)
    assert _video(client, headers).status_code == 201
    apply_subscription(db_session, ws.id, plan="starter", status="active", provider="app_store")
    assert _quota(client, headers)[1] == PLANS["starter"].videos and _video(client, headers).status_code == 201
    apply_subscription(db_session, ws.id, plan="free", status="canceled", provider="app_store")
    assert _quota(client, headers)[:2] == (1, 1) and _video(client, headers).status_code == 402


def test_signing_up_counts_the_video_made_as_a_guest(client, db_session, monkeypatch, b2v):  # noqa: F811
    _, headers = guest(client)
    assert _video(client, headers).status_code == 201
    fresh = {"Authorization": f"Bearer {_sign_up(client, headers, 'email', monkeypatch).json()['access_token']}"}
    assert _quota(client, fresh)[:2] == (1, 1)


def test_ai_video_edits_are_the_devices_too(client, db_session):
    data, _ = guest(client)
    ws = workspace_of(db_session, data)
    for _ in range(5):
        video_limits.take(db_session, ws, "ai_edits")
    with pytest.raises(HTTPException) as e:
        video_limits.take(db_session, ws, "ai_edits")
    assert e.value.status_code == 402
    video_limits.give_back(db_session, ws.id, "ai_edits")
    video_limits.take(db_session, ws, "ai_edits")
    assert video_limits.report(db_session, ws)["limits"]["ai_edits"] == {"used": 5, "limit": 5}


def test_five_chats_then_402(client, db_session):
    data, headers = guest(client)
    ws = workspace_of(db_session, data)
    nb = notebook(db_session, ws)
    url = f"/api/notebooks/{nb.id}/chat"
    assert [client.post(url, json={"question": "hi"}, headers=headers).status_code for _ in range(6)] == [200] * 5 + [402]
    db_session.expire_all()
    assert db_session.scalar(select(GuestDevice)).chat_messages == 5


def test_deleting_things_or_waiting_gives_nothing_back(client, db_session):
    device = uuid.uuid4()
    data, headers = guest(client, device)
    made = make(client, headers, db_session, data, "report").json()
    artifact = db_session.get(Artifact, uuid.UUID(made["id"]))
    for row in db_session.scalars(select(Job).where(Job.artifact_id == artifact.id)):
        row.status = "done"
    artifact.status = "ready"
    db_session.commit()
    assert client.delete(f"/api/artifacts/{made['id']}", headers=headers).status_code == 200
    row = db_session.scalar(select(GuestDevice))
    row.created_at = row.updated_at = datetime.now(UTC) - timedelta(days=40)
    db_session.commit()
    assert make(client, headers, db_session, data, "report").status_code == 402


def test_removing_a_post_does_not_make_room(client, db_session):
    data, headers = guest(client)
    ws = workspace_of(db_session, data)
    docs = add_posts(db_session, ws, 5)
    r = client.post("/api/sources/url", json={"url": "https://b.example.com/post"}, headers=headers)
    assert r.status_code == 402
    assert client.delete(f"/api/documents/{docs[0].id}", headers=headers).status_code == 200
    assert client.post("/api/sources/url", json={"url": "https://b.example.com/post"}, headers=headers).status_code == 402


def test_every_try_past_the_limit_is_refused_so_the_app_asks_each_time(client, db_session, monkeypatch):
    from types import SimpleNamespace

    from app.routers import sources

    data, headers = guest(client)
    assert make(client, headers, db_session, data, "report").status_code == 200
    for _ in range(3):
        r = make(client, headers, db_session, data, "report")
        assert r.status_code == 402 and r.json()["detail"]["code"] == "plan_limit"
    # A feed with no room left is refused up front too, not imported with every post locked.
    docs = add_posts(db_session, workspace_of(db_session, data), 4)
    monkeypatch.setattr(sources, "discover_feed", lambda url: SimpleNamespace(
        feed_url="https://c.example.com/feed", platform="rss", site_url="https://c.example.com", title="C"))
    for _ in range(2):
        r = client.post("/api/sources", json={"url": "https://c.example.com"}, headers=headers)
        assert r.status_code == 402 and r.json()["detail"]["kind"] == "indexed_posts"
    # The room the app shows is the server's: a removed post still counts.
    client.delete(f"/api/documents/{docs[0].id}", headers=headers)
    assert client.get("/api/settings/usage", headers=headers).json()["used"]["indexed_posts"] == 5


def test_deleting_the_guest_does_not_give_the_allowance_back(client, db_session):
    device = uuid.uuid4()
    first, headers = guest(client, device)
    assert client.post("/api/auth/delete-account", headers=headers).json() == {"ok": True, "erased": True}
    db_session.expire_all()
    assert db_session.get(User, uuid.UUID(first["user"]["id"])) is None
    again, _ = guest(client, device)
    assert again["created"] and again["allowance"] is False and again["user"]["id"] != first["user"]["id"]


def test_a_failed_generation_gives_its_use_back_once(client, db_session):
    data, headers = guest(client)
    made = make(client, headers, db_session, data, "report").json()
    job = db_session.scalar(select(Job).where(Job.artifact_id == uuid.UUID(made["id"])))
    job.status = "failed"
    mark_artifact_failed(db_session, job, "model down")
    db_session.expire_all()
    assert db_session.scalar(select(GuestDevice)).reports == 0
    # Retrying takes it again; a second retry after it is done has nothing left to take.
    assert client.post(f"/api/artifacts/{made['id']}/retry", headers=headers).status_code == 200
    assert make(client, headers, db_session, data, "report").status_code == 402
    for row in db_session.scalars(select(Job).where(Job.artifact_id == uuid.UUID(made["id"]))):
        row.status = "done"
    db_session.commit()
    assert client.post(f"/api/artifacts/{made['id']}/retry", headers=headers).status_code == 402


def test_two_at_once_cannot_both_take_the_last(client, db_session, session_factory):
    data, _ = guest(client)
    ws = workspace_of(db_session, data)
    with session_factory() as a, session_factory() as b:
        took = [guests.reserve(s, s.get(Workspace, ws.id), "reports") for s in (a, b)]
        a.commit()
    assert took == [True, False]


def test_raising_the_epoch_gives_each_device_one_more_round(client, db_session, monkeypatch, apple_bits):
    device = uuid.uuid4()
    data, headers = guest(client, device)
    add_posts(db_session, workspace_of(db_session, data), 5)
    assert make(client, headers, db_session, data, "report").status_code == 200
    monkeypatch.setattr(settings, "guest_epoch", 2)
    again, headers = guest(client, device)
    assert again["allowance"] and apple_bits["phone"] == 2
    assert make(client, headers, db_session, again, "report").status_code == 200
    assert make(client, headers, db_session, again, "report").status_code == 402
    assert guests.post_limit(db_session, workspace_of(db_session, data).id) == 10  # the five stored, and five new
    assert guest(client, uuid.uuid4())[0]["allowance"] is False


# Subscribing, and what needs an account


def test_a_guest_who_subscribes_has_the_plan_until_it_lapses(client, db_session):
    data, headers = guest(client)
    assert make(client, headers, db_session, data, "report").status_code == 200
    ws = workspace_of(db_session, data)
    apply_subscription(db_session, ws.id, plan="writer", status="active", provider="app_store")
    assert effective_plan(db_session, ws).id == "writer"
    assert make(client, headers, db_session, data, "report").status_code == 200
    apply_subscription(db_session, ws.id, plan="free", status="canceled", provider="app_store")
    assert effective_plan(db_session, ws) is GUEST_PLAN
    assert make(client, headers, db_session, data, "report").status_code == 402


def test_a_used_device_can_still_subscribe(client, db_session):
    guest(client)
    data, headers = guest(client)
    status = client.get("/api/billing/status", headers=headers).json()
    assert status["can_upgrade"] and status["next_plan"] == "starter" and status["store_customer_id"]
    apply_subscription(db_session, workspace_of(db_session, data).id, plan="starter", status="active", provider="app_store")
    assert make(client, headers, db_session, data, "report").status_code == 200


def test_connecting_other_services_needs_an_account(client):
    _, headers = guest(client)
    now = datetime.now(UTC).isoformat()
    calls = [
        ("/api/social/bluesky", {"handle": "a.bsky.social", "app_password": "x"}),
        ("/api/social/x/start", None),
        ("/api/support/escalate", {"email": "a@b.co", "concern": "help"}),
        ("/api/calendar", {"platform": "x", "content": "hi", "scheduled_at": now, "publish_now": True}),
    ]
    for path, body in calls:
        r = client.post(path, json=body, headers=headers)
        assert r.status_code == 403 and r.json()["detail"]["code"] == "account_required", (path, r.text)


@pytest.fixture
def voices(monkeypatch):
    """ElevenLabs, with what it was asked for."""
    from app.services import tts

    calls: dict[str, list] = {"design": [], "save": [], "delete": []}
    state = {"fail": False}

    def call(kind, value):
        def run(*args):
            calls[kind].append(args)
            if state["fail"]:
                raise tts.TTSError("down")
            return value

        return run

    monkeypatch.setattr(settings, "elevenlabs_api_key", "k")
    monkeypatch.setattr(tts, "design_voice", call("design", [{"generated_voice_id": "generated-1", "audio": b"a", "seconds": 1.0}]))
    monkeypatch.setattr(tts, "create_designed_voice", call("save", "voice-1"))
    monkeypatch.setattr(tts, "delete_voice", call("delete", None))
    calls["state"] = state
    return calls


DESIGN = {"prompt": "A warm, low and steady narrator with an unhurried pace and a slight smile in the voice"}
SAVE = {"generated_voice_id": "generated-1", "name": "Narrator", "description": "A warm, low and steady narrator voice"}


def test_one_voice_design_per_device(client, db_session, voices):
    device = uuid.uuid4()
    data, headers = guest(client, device)
    assert client.post("/api/voice/design", json=DESIGN, headers=headers).status_code == 200
    r = client.post("/api/voice/design/save", json=SAVE, headers=headers)
    assert r.status_code == 200, r.text
    for path, body in (("/api/voice/design", DESIGN), ("/api/voice/design/save", SAVE)) * 2:
        r = client.post(path, json=body, headers=headers)
        assert r.status_code == 402 and r.json()["detail"]["plan"] == "guest"
    # Erased with the guest, at ElevenLabs too; the use is not given back.
    client.post("/api/auth/delete-account", headers=headers)
    assert voices["delete"] == [("voice-1",)]
    _, headers = guest(client, device)
    assert client.post("/api/voice/design", json=DESIGN, headers=headers).status_code == 402


def test_three_tries_at_the_voice_and_the_last_can_still_be_saved(client, voices):
    _, headers = guest(client)
    assert [client.post("/api/voice/design", json=DESIGN, headers=headers).status_code for _ in range(4)] == [200] * 3 + [402]
    assert client.post("/api/voice/design/save", json=SAVE, headers=headers).status_code == 200


def test_a_voice_design_that_fails_is_given_back(client, db_session, voices):
    _, headers = guest(client)
    voices["state"]["fail"] = True
    for path, body in (("/api/voice/design", DESIGN), ("/api/voice/design/save", SAVE)) * 4:
        assert client.post(path, json=body, headers=headers).status_code == 502
    db_session.expire_all()
    device = db_session.scalar(select(GuestDevice))
    assert (device.voice_tries, device.voice_designs) == (0, 0)


def test_library_voices_come_with_a_plan(client, db_session, voices):
    data, headers = guest(client)
    body = {"public_owner_id": "owner-12345", "voice_id": "voice-12345", "name": "Nova"}
    assert client.post("/api/voice/library/add", json=body, headers=headers).status_code == 402
    apply_subscription(db_session, workspace_of(db_session, data).id, plan="starter", status="active", provider="app_store")
    assert [client.post("/api/voice/design", json=DESIGN, headers=headers).status_code for _ in range(5)] == [200] * 5


# Signing up


def _sign_up(client, headers, how, monkeypatch):
    if how == "email":
        client.post("/api/auth/email/register/start", json={"email": "new@example.com", "password": "stardust-42", "name": "Ada L"},
                    headers=headers)
        return client.post("/api/auth/email/register/verify", json={"email": "new@example.com", "code": last_code()}, headers=headers)
    if how == "google":
        monkeypatch.setattr(settings, "google_client_id", "g")
        monkeypatch.setattr(auth_router.google_id_token, "verify_oauth2_token", lambda *a, **k: {
            "aud": "g", "email": "new@example.com", "sub": "g-1", "email_verified": True, "name": "Ada L"})
        return client.post("/api/auth/google", json={"credential": "c"}, headers=headers)
    body = {"identity_token": apple_token(email="new@example.com"), "name": "Ada L"}
    if how == "apple":
        return client.post("/api/auth/apple", json=body, headers=headers)
    body = {"identity_token": apple_token(), "name": "Ada L", "warn_hidden_email": True}
    r = client.post("/api/auth/apple", json=body, headers=headers)
    return client.post("/api/auth/apple/confirm", json={"signup_token": r.json()["detail"]["signup_token"]}, headers=headers)


@pytest.mark.parametrize("how", ["email", "google", "apple", "apple_confirm"])
def test_signing_up_keeps_the_work(client, db_session, monkeypatch, apple, how):  # noqa: F811
    device = uuid.uuid4()
    data, headers = guest(client, device)
    ws = workspace_of(db_session, data)
    nb = notebook(db_session, ws)
    assert make(client, headers, db_session, data, "report").status_code == 200
    r = _sign_up(client, headers, how, monkeypatch)
    assert r.status_code == 200, r.text
    new = r.json()
    assert new["created"] and new["user"]["id"] == data["user"]["id"] and not new["user"]["is_guest"]
    fresh = {"Authorization": f"Bearer {new['access_token']}"}
    assert client.get("/api/auth/me", headers=headers).status_code == 401  # the guest's own tokens ended
    assert client.get(f"/api/notebooks/{nb.id}", headers=fresh).status_code == 200
    db_session.expire_all()
    user = db_session.get(User, uuid.UUID(new["user"]["id"]))
    assert user.auth_provider != AuthProvider.GUEST and not user.email_unsubscribed
    assert db_session.get(Workspace, ws.id).name == "Ada's workspace"
    assert effective_plan(db_session, db_session.get(Workspace, ws.id)).id == "free"
    again, _ = guest(client, device)
    assert again["allowance"] is False and again["user"]["id"] != new["user"]["id"]


def test_a_subscribed_guest_keeps_the_plan_when_signing_up(client, db_session, monkeypatch):
    data, headers = guest(client)
    ws = workspace_of(db_session, data)
    apply_subscription(db_session, ws.id, plan="studio", status="active", provider="app_store")
    assert _sign_up(client, headers, "email", monkeypatch).status_code == 200
    db_session.expire_all()
    assert effective_plan(db_session, db_session.get(Workspace, ws.id)).id == "studio"


def test_signing_in_to_an_existing_account_leaves_the_guest_alone(client, db_session):
    account = _signup(client)
    data, headers = guest(client)
    r = client.post("/api/auth/email/login", json={"email": "writer@example.com", "password": "stardust-42"}, headers=headers)
    assert r.json()["user"]["id"] == account["user"]["id"]
    assert db_session.get(User, uuid.UUID(data["user"]["id"])).auth_provider == AuthProvider.GUEST


def test_a_subscribed_guest_who_signs_in_elsewhere_keeps_the_plan_there(client, db_session):
    account = _signup(client)
    data, headers = guest(client)
    ws = workspace_of(db_session, data)
    apply_subscription(db_session, ws.id, plan="writer", status="active", provider="app_store")
    client.post("/api/auth/email/login", json={"email": "writer@example.com", "password": "stardust-42"}, headers=headers)
    mine = {"Authorization": f"Bearer {account['access_token']}"}
    assert client.get("/api/billing/status", headers=mine).json()["plan"]["id"] == "free"  # until Restore moves it
    assert effective_plan(db_session, ws).id == "writer"


def test_a_normal_account_signed_in_is_never_taken_over(client, db_session):
    account = _signup(client)
    headers = {"Authorization": f"Bearer {account['access_token']}"}
    client.post("/api/auth/email/register/start", json={"email": "other@example.com", "password": "stardust-42"}, headers=headers)
    r = client.post("/api/auth/email/register/verify", json={"email": "other@example.com", "code": last_code()}, headers=headers)
    assert r.json()["user"]["id"] != account["user"]["id"]
    assert db_session.get(User, uuid.UUID(account["user"]["id"])).email == "writer@example.com"


# Leaving


def test_inactive_guests_are_erased_unless_they_pay(client, db_session):
    old, _ = guest(client, token="a")
    paying, _ = guest(client, token="b")
    recent, _ = guest(client, token="c")
    apply_subscription(db_session, workspace_of(db_session, paying).id, plan="starter", status="active", provider="app_store")
    for data in (old, paying):
        db_session.get(User, uuid.UUID(data["user"]["id"])).last_login_at = datetime.now(UTC) - timedelta(days=91)
    db_session.commit()
    assert guests.retire_inactive(db_session) == 1
    assert account_purge.erase_requested_accounts(db_session) == 1
    db_session.expire_all()
    assert db_session.get(User, uuid.UUID(old["user"]["id"])) is None
    assert db_session.get(User, uuid.UUID(paying["user"]["id"])) and db_session.get(User, uuid.UUID(recent["user"]["id"]))
    assert len(db_session.scalars(select(GuestDevice)).all()) == 3


def test_device_check_talks_to_apple(monkeypatch):
    monkeypatch.undo()
    from tests.test_auth_apple import P8

    sent = []

    class Res:
        status_code, text = 200, "Failed to find bit state"

        def json(self):
            raise ValueError

    monkeypatch.setattr(device_check.httpx, "post", lambda url, **k: sent.append((url, k)) or Res())
    with pytest.raises(device_check.DeviceCheckUnavailable):
        device_check.read("t")  # not set up
    for name, value in (("apple_team_id", "TEAM"), ("devicecheck_key_id", "KEY"), ("devicecheck_private_key", P8)):
        monkeypatch.setattr(settings, name, value)
    assert device_check.read("t") == 0
    device_check.write("t", 2)
    assert sent[0][0] == "https://api.devicecheck.apple.com/v1/query_two_bits"
    assert sent[1][1]["json"]["bit0"] is False and sent[1][1]["json"]["bit1"] is True
    Res.status_code = 400
    with pytest.raises(device_check.DeviceCheckInvalid):
        device_check.read("t")
    Res.status_code = 401
    with pytest.raises(device_check.DeviceCheckUnavailable):
        device_check.read("t")

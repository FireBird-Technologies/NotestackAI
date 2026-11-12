"""Posting to X and LinkedIn: scheduling needs a live connection, a connection that goes down pauses its posts (never
attempted) and reconnecting resumes them, connections are kept fresh, posts go out at their time, and uploads stream
from temporary files with size limits and retries. The platforms are faked at their _call seam."""

import os
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.models import Artifact, CalendarItem, SocialAccount, Workspace
from app.services.crypto import encrypt
from tests.conftest import last_code

X_SCOPES = "tweet.read tweet.write users.read offline.access media.write"
LI_SCOPES = "openid,profile,w_member_social"  # LinkedIn lists scopes with commas


@pytest.fixture()
def auth(client):
    client.post("/api/auth/email/register/start", json={"email": "ada@example.com", "password": "stardust-42",
                                                        "name": "Ada Lovelace"})
    r = client.post("/api/auth/email/register/verify", json={"email": "ada@example.com", "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture()
def ws(auth, db_session):
    return db_session.query(Workspace).first()


@pytest.fixture(autouse=True)
def _fresh_health(monkeypatch):
    from app.services.social import health

    monkeypatch.setattr(health, "_last_checked", {})


def account(db, ws, platform="x", scopes=None, expires_in=None, refresh=None, external_id="p42"):
    acct = SocialAccount(workspace_id=ws.id, platform=platform, handle="ada", external_id=external_id,
                         access_token=encrypt("tok"), refresh_token=encrypt(refresh) if refresh else None,
                         scopes=scopes or (X_SCOPES if platform == "x" else LI_SCOPES), status="active",
                         expires_at=datetime.now(UTC) + expires_in if expires_in is not None else None)
    db.add(acct)
    db.commit()
    return acct


def item(db, ws, acct, minutes=60, status="scheduled", content="Hello", **kw):
    it = CalendarItem(workspace_id=ws.id, platform=acct.platform, content=content, social_account_id=acct.id,
                      scheduled_at=datetime.now(UTC) + timedelta(minutes=minutes), status=status, **kw)
    db.add(it)
    db.commit()
    return it


def made(db, ws, type_, key=None, data=b"PNG", **content):
    from app.services.storage import storage

    if key:
        storage.put_bytes(key, data)
    a = Artifact(workspace_id=ws.id, type=type_, status="ready", storage_key=key,
                 content_json={"title": type_, **content})
    db.add(a)
    db.commit()
    return a


def reply(code, method, url, data=None, headers=None):
    return httpx.Response(code, json=data, headers=headers, request=httpx.Request(method, url))


def statuses(db, *items):
    db.expire_all()
    return [db.get(CalendarItem, i.id).status for i in items]


# Scheduling needs a live connection


def schedule(client, auth, platform, acct=None, **extra):
    return client.post("/api/calendar", json={
        "platform": platform, "content": "Hello", "scheduled_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        **({"social_account_id": str(acct.id)} if acct else {}), **extra}, headers=auth)


def test_x_and_linkedin_need_a_connected_account(client, auth, ws, db_session):
    r = schedule(client, auth, "x")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_connected"
    assert schedule(client, auth, "linkedin").status_code == 409
    down = account(db_session, ws, "linkedin")
    down.status = "expired"
    db_session.commit()
    r = schedule(client, auth, "linkedin", down)
    assert r.status_code == 409 and "Reconnect LinkedIn" in r.json()["detail"]["message"]
    assert schedule(client, auth, "x", account(db_session, ws, "x")).status_code == 200
    assert schedule(client, auth, "bluesky").status_code == 200  # no API connection needed: an email reminder


def test_post_assistant_generates_and_reworks_with_platform_limit(client, auth, monkeypatch):
    from app.llm import run
    from app.llm.signatures import SocialPostAssistant

    calls = []

    def predict(signature, **kwargs):
        calls.append((signature, kwargs))
        return {"text": "x" * 400 if kwargs["action"] == "generate" else "A clearer draft."}

    monkeypatch.setattr(run, "predict", predict)
    generated = client.post("/api/launchpad/assist", headers=auth, json={
        "platform": "x", "action": "generate", "prompt": "Announce our new course",
    })
    assert generated.status_code == 200 and len(generated.json()["text"]) == 280
    assert calls[0][0] is SocialPostAssistant
    assert calls[0][1]["platform"] == "X" and calls[0][1]["character_limit"] == 280

    reworked = client.post("/api/launchpad/assist", headers=auth, json={
        "platform": "linkedin", "action": "formal", "text": "hey, we launched it",
    })
    assert reworked.status_code == 200 and reworked.json()["text"] == "A clearer draft."
    assert calls[1][1]["current_text"] == "hey, we launched it"
    assert client.post("/api/launchpad/assist", headers=auth, json={
        "platform": "linkedin", "action": "shorten", "text": "",
    }).status_code == 422


def test_linkedin_scopes_are_read_with_commas_or_spaces(client, auth, ws, db_session):
    acct = account(db_session, ws, "linkedin", scopes="openid profile w_member_social")
    quote = made(db_session, ws, "quote_card", key="ws/q/q.png")
    assert schedule(client, auth, "linkedin", acct, artifact_id=str(quote.id)).status_code == 200
    got = client.get("/api/social/accounts", headers=auth).json()["accounts"][0]
    assert got["can_post_media"] is True and got["needs_reconnect"] is False


# A connection that goes down pauses its posts; reconnecting resumes them


def test_disconnecting_pauses_its_posts_and_nothing_is_sent(client, auth, ws, db_session, session_factory,
                                                            monkeypatch):
    from app.services import launchpad
    from app.services.social import x

    monkeypatch.setattr(x, "publish", lambda *a, **k: pytest.fail("a paused post was sent"))
    acct = account(db_session, ws, "x")
    later, due = item(db_session, ws, acct), item(db_session, ws, acct, minutes=-1)
    assert client.delete(f"/api/social/accounts/{acct.id}", headers=auth).status_code == 200
    db_session.expire_all()
    assert db_session.get(SocialAccount, acct.id).status == "disconnected"
    assert statuses(db_session, later, due) == ["paused", "paused"]
    assert launchpad.publish_due(session_factory) == 0  # paused posts are never claimed
    # Gone from the list: the platform offers a plain Connect, not a Reconnect to the old account.
    assert client.get("/api/social/accounts", headers=auth).json()["accounts"] == []


def test_a_refused_connection_at_publish_pauses_all_its_posts(client, auth, ws, db_session, session_factory,
                                                             run_jobs, monkeypatch):
    from app.services import launchpad
    from app.services.social import x

    acct = account(db_session, ws, "x")
    monkeypatch.setattr(x, "_call", lambda m, url, **k: reply(401, m, url, {"title": "Unauthorized"}))
    due, later = item(db_session, ws, acct, minutes=-1), item(db_session, ws, acct, minutes=90)
    launchpad.publish_due(session_factory)
    run_jobs()
    db_session.expire_all()
    assert db_session.get(SocialAccount, acct.id).status == "expired"
    assert statuses(db_session, due, later) == ["paused", "paused"]
    assert "Reconnect X" in db_session.get(CalendarItem, due.id).error


def test_reconnecting_resumes_future_posts_and_flags_missed_ones(client, auth, ws, db_session):
    import json

    from app.auth import encode_signed

    acct = account(db_session, ws, "x")
    ahead, missed = item(db_session, ws, acct, minutes=60), item(db_session, ws, acct, minutes=-30)
    client.delete(f"/api/social/accounts/{acct.id}", headers=auth)
    info = {"access_token": "new", "refresh_token": "r", "expires_in": 7200, "external_id": "p42", "handle": "ada",
            "scope": X_SCOPES}
    ticket = encode_signed({"typ": "social_link", "ws": str(ws.id), "platform": "x",
                            "data": encrypt(json.dumps(info))}, timedelta(minutes=5))
    assert client.post("/api/social/complete", json={"ticket": ticket}, headers=auth).status_code == 200
    db_session.expire_all()
    assert db_session.get(SocialAccount, acct.id).status == "active"  # the same account, back
    assert statuses(db_session, ahead, missed) == ["scheduled", "paused"]
    assert "pick a new time" in db_session.get(CalendarItem, missed.id).error
    # The missed one goes back out once given a time still ahead.
    r = client.patch(f"/api/calendar/{missed.id}", headers=auth,
                     json={"scheduled_at": (datetime.now(UTC) + timedelta(hours=2)).isoformat()})
    assert r.status_code == 200 and r.json()["status"] == "scheduled"
    r = client.patch(f"/api/calendar/{ahead.id}", json={"status": "paused"}, headers=auth)  # held by hand
    assert r.json()["status"] == "paused"


def test_connecting_another_account_after_a_disconnect_takes_over_its_posts(client, auth, ws, db_session):
    import json

    from app.auth import encode_signed

    old = account(db_session, ws, "x")
    ahead = item(db_session, ws, old, minutes=60)
    client.delete(f"/api/social/accounts/{old.id}", headers=auth)
    info = {"access_token": "new", "refresh_token": "r", "expires_in": 7200, "external_id": "someone-else",
            "handle": "grace", "scope": X_SCOPES}
    ticket = encode_signed({"typ": "social_link", "ws": str(ws.id), "platform": "x",
                            "data": encrypt(json.dumps(info))}, timedelta(minutes=5))
    assert client.post("/api/social/complete", json={"ticket": ticket}, headers=auth).status_code == 200
    db_session.expire_all()
    listed = client.get("/api/social/accounts", headers=auth).json()["accounts"]
    assert [a["handle"] for a in listed] == ["grace"]  # only the new account
    moved = db_session.get(CalendarItem, ahead.id)
    assert str(moved.social_account_id) == listed[0]["id"] and moved.status == "scheduled"


# Keeping connections fresh


def test_x_tokens_are_refreshed_before_they_expire(ws, db_session, session_factory, monkeypatch):
    from app.services.crypto import decrypt
    from app.services.social import health, x

    acct = account(db_session, ws, "x", expires_in=timedelta(minutes=5), refresh="old-refresh")
    sent = []
    monkeypatch.setattr(x, "_token_request", lambda data: sent.append(data) or {
        "access_token": "fresh", "refresh_token": "rotated", "expires_in": 7200})
    monkeypatch.setattr(x, "_call", lambda m, url, **k: reply(200, m, url, {"data": {"id": "p42"}}))
    assert health.social_health(session_factory) == 1
    db_session.expire_all()
    acct = db_session.get(SocialAccount, acct.id)
    assert sent[0]["grant_type"] == "refresh_token" and decrypt(acct.access_token) == "fresh"
    assert decrypt(acct.refresh_token) == "rotated" and acct.status == "active"


def test_a_refused_refresh_or_expiry_takes_the_connection_down(ws, db_session, session_factory, monkeypatch):
    from app.services.social import SocialError, health, x

    def refused(data):
        raise SocialError("invalid_grant", permanent=True)

    monkeypatch.setattr(x, "_token_request", refused)
    xa = account(db_session, ws, "x", expires_in=timedelta(minutes=5), refresh="old")
    li = account(db_session, ws, "linkedin", expires_in=timedelta(minutes=-1), external_id="li1")  # no refresh token
    posts = [item(db_session, ws, xa), item(db_session, ws, li)]
    health.social_health(session_factory)
    db_session.expire_all()
    assert [db_session.get(SocialAccount, a.id).status for a in (xa, li)] == ["expired", "expired"]
    assert statuses(db_session, *posts) == ["paused", "paused"]


def test_access_revoked_on_the_platform_is_noticed(ws, db_session, session_factory, monkeypatch):
    from app.services.social import health, linkedin

    acct = account(db_session, ws, "linkedin")
    post = item(db_session, ws, acct)
    monkeypatch.setattr(linkedin, "_call", lambda m, url, **k: reply(401, m, url, {}))
    health.social_health(session_factory)
    db_session.expire_all()
    assert db_session.get(SocialAccount, acct.id).status == "revoked"
    assert statuses(db_session, post) == ["paused"]


def test_liveness_is_asked_at_most_every_six_hours(ws, db_session, session_factory, monkeypatch):
    from app.services.social import health, x

    account(db_session, ws, "x")
    calls = []
    monkeypatch.setattr(x, "_call", lambda m, url, **k: calls.append(url) or reply(200, m, url, {"data": {}}))
    health.social_health(session_factory)
    health.social_health(session_factory)
    assert len(calls) == 1


# On time


def test_a_due_post_goes_out_through_its_job(client, auth, ws, db_session, session_factory, run_jobs, monkeypatch):
    from app.services import launchpad
    from app.services.social import x

    acct = account(db_session, ws, "x")
    started = []
    monkeypatch.setattr(x, "publish", lambda db, a, posts, media=None: started.append(
        db.get(CalendarItem, due.id).updated_at) or ("t1", "https://x.com/ada/status/t1"))
    due = item(db_session, ws, acct, minutes=0)
    claimed_at = datetime.now(UTC)
    assert launchpad.publish_due(session_factory) == 1
    run_jobs()
    assert statuses(db_session, due) == ["posted"]
    stamp = started[0] if started[0].tzinfo else started[0].replace(tzinfo=UTC)
    assert stamp >= claimed_at - timedelta(seconds=1)  # the job touched it as it started


# Uploads


def test_a_video_is_streamed_to_a_temp_file_that_is_removed(ws, db_session, monkeypatch):
    from app.services.social import media

    video = made(db_session, ws, "video", key="ws/v/a.mp4", data=os.urandom(100_000), duration_s=30)
    with media.media_for(video, "linkedin") as files:
        path = files[0].path
        assert os.path.exists(path) and files[0].size == 100_000 and files[0].data is None
        assert files[0].read(10, 20) == files[0].read()[10:20]
    assert not os.path.exists(path)
    with pytest.raises(RuntimeError), media.media_for(video, "x") as files:
        path = files[0].path
        raise RuntimeError("upload broke")
    assert not os.path.exists(path)  # also on errors


def test_size_limits_fail_before_any_call(ws, db_session, monkeypatch):
    from app.services.social import SocialError, media

    tiny = made(db_session, ws, "video", key="ws/v/tiny.mp4", data=b"x" * 1000, duration_s=5)
    with pytest.raises(SocialError, match="too small for LinkedIn"), media.media_for(tiny, "linkedin"):
        pass
    monkeypatch.setitem(media.SIZE_LIMITS, ("x", "video"), (1, 500))
    with pytest.raises(SocialError, match="X takes up to"), media.media_for(tiny, "x"):
        pass


def _linkedin(monkeypatch, part_codes: list[int]):
    """A fake LinkedIn: initializeUpload with 2 parts, part PUTs answering from part_codes, then AVAILABLE."""
    from app.services.social import linkedin

    calls, received = [], {}
    codes = iter(part_codes)

    def call(method, url, **kw):
        calls.append((method, url, kw))
        if url.endswith("/rest/videos") and kw.get("params", {}).get("action") == "initializeUpload":
            size = kw["json"]["initializeUploadRequest"]["fileSizeBytes"]
            return reply(200, method, url, {"value": {"video": "urn:li:video:1", "uploadToken": "", "uploadInstructions": [
                {"uploadUrl": "https://up/1", "firstByte": 0, "lastByte": 49_999},
                {"uploadUrl": "https://up/2", "firstByte": 50_000, "lastByte": size - 1}]}})
        if url.startswith("https://up/"):
            code = next(codes, 200)
            if code < 400:
                received[url] = kw["content"]
            return reply(code, method, url, {} if code >= 400 else None, headers={"etag": f'"e{url[-1]}"'})
        if "/rest/videos/" in url:
            return reply(200, method, url, {"status": "AVAILABLE"})
        if url.endswith("/rest/posts"):
            return reply(201, method, url, headers={"x-restli-id": "urn:li:share:9"})
        return reply(200, method, url)

    monkeypatch.setattr(linkedin, "_call", call)
    monkeypatch.setattr(linkedin.time, "sleep", lambda s: None)
    return calls, received


def test_linkedin_video_parts_retry_and_arrive_byte_identical(ws, db_session, monkeypatch):
    from app.services.social import linkedin, media

    data = os.urandom(90_000)
    acct = account(db_session, ws, "linkedin")
    video = made(db_session, ws, "video", key="ws/v/b.mp4", data=data, duration_s=30)
    calls, received = _linkedin(monkeypatch, [503, 200, 200])  # the first part fails once
    with media.media_for(video, "linkedin") as files:
        linkedin.publish(db_session, acct, ["Watch"], files)
    assert received["https://up/1"] + received["https://up/2"] == data
    part_puts = [c for c in calls if c[1].startswith("https://up/")]
    assert len(part_puts) == 3 and all("Authorization" not in c[2].get("headers", {}) for c in part_puts)


def test_linkedin_retired_api_version_is_permanent(ws, db_session, monkeypatch):
    from app.services.social import SocialError, linkedin

    acct = account(db_session, ws, "linkedin")
    monkeypatch.setattr(linkedin, "_call", lambda m, url, **k: reply(426, m, url, {"code": "NONEXISTENT_VERSION"}))
    with pytest.raises(SocialError, match="retired API version") as err:
        linkedin.publish(db_session, acct, ["Hi"], [])
    assert err.value.permanent and not err.value.reconnect


def test_x_video_processing_failure_is_permanent(ws, db_session, monkeypatch):
    from app.services.social import SocialError, media, x

    acct = account(db_session, ws, "x")
    video = made(db_session, ws, "video", key="ws/v/c.mp4", data=os.urandom(100_000), duration_s=30)

    def call(method, url, **kw):
        path = url.split("/2/", 1)[1]
        if path == "media/upload/initialize":
            return reply(200, method, url, {"data": {"id": "v1"}})
        if path.endswith("/append"):
            return reply(204, method, url)
        if path.endswith("/finalize"):
            return reply(200, method, url, {"data": {"processing_info": {"state": "pending", "check_after_secs": 1}}})
        return reply(200, method, url, {"data": {"processing_info": {"state": "failed",
                                                                    "error": {"message": "Unsupported video"}}}})

    monkeypatch.setattr(x, "_call", call)
    monkeypatch.setattr(x.time, "sleep", lambda s: None)
    with pytest.raises(SocialError, match="Unsupported video") as err, media.media_for(video, "x") as files:
        x.publish(db_session, acct, ["Watch"], files)
    assert err.value.permanent


def test_unfinished_blog2video_video_is_refused_when_scheduled(client, auth, ws, db_session):
    acct = account(db_session, ws, "x")
    video = Artifact(workspace_id=ws.id, type="video", status="processing",
                     content_json={"title": "Draft", "provider": "blog2video"})
    db_session.add(video)
    db_session.commit()
    r = schedule(client, auth, "x", acct, artifact_id=str(video.id))
    assert r.status_code == 400 and "isn't finished" in r.json()["detail"]
    assert uuid.UUID(str(video.id))


def test_a_video_being_rendered_stays_listed_as_rendering(client, auth, ws, db_session):
    video = Artifact(workspace_id=ws.id, type="video", status="rendering",
                     content_json={"title": "Mid render", "provider": "blog2video"})
    db_session.add(video)
    db_session.commit()
    listed = {a["id"]: a for a in client.get("/api/launchpad/postable", headers=auth).json()}
    item = listed[str(video.id)]
    assert item["needs_render"] and item["rendering"]


def test_a_kit_is_tracked_apart_and_never_attached(client, auth, ws, db_session):
    acct = account(db_session, ws, "x")
    kit = made(db_session, ws, "launch_kit", post_title="The Boring Portfolio", posts={"x_thread": ["One", "Two"]})
    video = made(db_session, ws, "video", key="ws/v/k.mp4", data=os.urandom(100_000), duration_s=30)
    r = schedule(client, auth, "x", acct, artifact_id=str(kit.id))
    assert r.status_code == 400 and "can't be attached" in r.json()["detail"]
    r = schedule(client, auth, "x", acct, kit_id=str(kit.id), artifact_id=str(video.id))
    assert r.status_code == 200
    got = r.json()
    assert got["kit_id"] == str(kit.id) and got["kit_title"] == "The Boring Portfolio"
    assert got["artifact"]["type"] == "video"  # the attachment is the video, not the kit
    assert schedule(client, auth, "x", acct, kit_id=str(video.id)).status_code == 404  # only a Launch Kit is a kit


def test_a_time_picked_in_the_users_zone_is_stored_in_utc(client, auth, ws, db_session):
    acct = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    year = datetime.now(UTC).year + 1
    r = schedule(client, auth, "linkedin", acct, local_time=f"{year}-10-07T11:00", timezone="Asia/Karachi")
    assert r.status_code == 200, r.text
    assert datetime.fromisoformat(r.json()["scheduled_at"]) == datetime(year, 10, 7, 6, 0, tzinfo=UTC)
    # New York is UTC-4 in summer and UTC-5 in winter: the same wall time lands an hour apart.
    summer = schedule(client, auth, "linkedin", acct, local_time=f"{year}-07-01T09:30", timezone="America/New_York")
    winter = schedule(client, auth, "linkedin", acct, local_time=f"{year}-12-01T09:30", timezone="America/New_York")
    assert datetime.fromisoformat(summer.json()["scheduled_at"]) == datetime(year, 7, 1, 13, 30, tzinfo=UTC)
    assert datetime.fromisoformat(winter.json()["scheduled_at"]) == datetime(year, 12, 1, 14, 30, tzinfo=UTC)
    # Moving it keeps to the user's zone too.
    item_id = r.json()["id"]
    moved = client.patch(f"/api/calendar/{item_id}", json={"local_time": f"{year}-10-08T00:30", "timezone": "Asia/Karachi"},
                         headers=auth)
    assert datetime.fromisoformat(moved.json()["scheduled_at"]) == datetime(year, 10, 7, 19, 30, tzinfo=UTC)


def test_only_half_hours_in_a_known_zone_are_taken(client, auth, ws, db_session):
    acct = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    year = datetime.now(UTC).year + 1
    off = schedule(client, auth, "linkedin", acct, local_time=f"{year}-10-07T11:15", timezone="Asia/Karachi")
    assert off.status_code == 400 and off.json()["detail"]["code"] == "half_hour_only"
    bad = schedule(client, auth, "linkedin", acct, local_time=f"{year}-10-07T11:00", timezone="Mars/Olympus")
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "bad_timezone"
    assert schedule(client, auth, "linkedin", acct).status_code == 200  # an exact scheduled_at (Post now) still works


def test_the_publisher_runs_on_the_half_hour():
    from app.worker import ALIGN_GRACE_SECONDS, Periodic

    task = Periodic("publish_due", 1800, lambda: None, align=True)
    wall = datetime(2026, 10, 7, 6, 10, tzinfo=UTC).timestamp()  # 06:10 UTC: the next run is at 06:30
    task.schedule_next(100.0, wall)
    assert task.next_at == 100.0 + 20 * 60 + ALIGN_GRACE_SECONDS


def uploaded(db, ws, filename, content_type, data, status="complete"):
    """A file the user uploaded through /api/storage/uploads, in storage and recorded."""
    from app.models import Upload, User
    from app.services.storage import keys, storage

    upload_id = uuid.uuid4()
    key = keys.upload(ws.id, upload_id, filename)
    storage.put_bytes(key, data)
    up = Upload(id=upload_id, workspace_id=ws.id, user_id=db.query(User).first().id, key=key, filename=filename,
                content_type=content_type, size_bytes=len(data), status=status)
    db.add(up)
    db.commit()
    return up


def test_a_file_from_the_computer_is_attached_and_posted(client, auth, ws, db_session):
    from app.services.social import media

    acct = account(db_session, ws, "linkedin")
    png = uploaded(db_session, ws, "chart.png", "image/png", b"\x89PNG-chart")
    r = client.post("/api/launchpad/uploads", json={"upload_id": str(png.id)}, headers=auth)
    assert r.status_code == 200, r.text
    brief = r.json()
    assert brief["type"] == "upload" and brief["media"] == "image" and brief["title"] == "chart"
    assert brief["thumb_url"] and brief["prefill"]["linkedin"] == ""
    listed = {a["id"] for a in client.get("/api/launchpad/postable", headers=auth).json()}
    assert brief["id"] in listed
    assert schedule(client, auth, "linkedin", acct, artifact_id=brief["id"]).status_code == 200
    art = db_session.get(Artifact, uuid.UUID(brief["id"]))
    with media.media_for(art, "linkedin") as files:
        assert [(f.kind, f.content_type, f.read()) for f in files] == [("image", "image/png", b"\x89PNG-chart")]
    # Not one of the things Notestack made: kept out of the general artifact list.
    assert brief["id"] not in {a["id"] for a in client.get("/api/artifacts", headers=auth).json()["items"]}


def test_multiple_uploaded_images_become_one_carousel(client, auth, ws, db_session):
    from app.models import Upload
    from app.services.social import media
    from app.services.storage import storage

    images = [uploaded(db_session, ws, "one.png", "image/png", b"PNG-one"),
              uploaded(db_session, ws, "two.jpg", "image/jpeg", b"JPEG-two"),
              uploaded(db_session, ws, "three.gif", "image/gif", b"GIF-three")]
    response = client.post("/api/launchpad/uploads", json={"upload_ids": [str(image.id) for image in images]},
                           headers=auth)
    assert response.status_code == 200, response.text
    brief = response.json()
    assert brief["type"] == "carousel" and brief["media"] == "image" and brief["media_count"] == 3
    assert brief["thumb_url"] and brief["title"] == "3 uploaded images"
    acct = account(db_session, ws, "linkedin")
    scheduled = schedule(client, auth, "linkedin", acct, artifact_id=brief["id"])
    assert scheduled.status_code == 200, scheduled.text
    artifact = db_session.get(Artifact, uuid.UUID(brief["id"]))
    with media.media_for(artifact, "linkedin") as files:
        assert [(item.filename, item.content_type, item.read()) for item in files] == [
            ("one.png", "image/png", b"PNG-one"), ("two.jpg", "image/jpeg", b"JPEG-two"),
            ("three.gif", "image/gif", b"GIF-three")]
    keys = [image.key for image in images]
    assert client.delete(f"/api/artifacts/{brief['id']}", headers=auth).status_code == 200
    db_session.expire_all()
    assert all(db_session.get(Upload, image.id) is None for image in images)
    assert all(not storage.exists(key) for key in keys)


def test_multiple_uploads_reject_a_video(client, auth, ws, db_session):
    image = uploaded(db_session, ws, "one.png", "image/png", b"PNG")
    video = uploaded(db_session, ws, "clip.mp4", "video/mp4", b"v" * (80 * 1024))
    response = client.post("/api/launchpad/uploads", json={"upload_ids": [str(image.id), str(video.id)]}, headers=auth)
    assert response.status_code == 415 and "images only" in response.json()["detail"]


def test_instagram_crops_uploaded_images_to_the_selected_square_position(ws, db_session):
    import io

    from PIL import Image

    from app.services.social import media

    source = io.BytesIO()
    portrait = Image.new("RGB", (1290, 2796), "red")
    portrait.paste("blue", (0, 1398, 1290, 2796))
    portrait.save(source, "PNG")
    upload = uploaded(db_session, ws, "portrait.png", "image/png", source.getvalue())
    artifact = Artifact(workspace_id=ws.id, type="carousel", status="ready", content_json={
        "title": "Portrait carousel", "slide_keys": [upload.key],
        "slide_files": [{"key": upload.key, "filename": upload.filename, "content_type": upload.content_type}],
        "instagram_positions": [1.0],
    })
    db_session.add(artifact)
    db_session.commit()

    with media.media_for(artifact, "instagram") as files:
        image = Image.open(io.BytesIO(files[0].read()))
        assert image.size == (1080, 1080)
        assert image.getpixel((540, 540))[2] > image.getpixel((540, 540))[0]  # the selected bottom of the image
        assert files[0].filename == "portrait.jpg" and files[0].content_type == "image/jpeg"
    with media.media_for(artifact, "facebook") as files:
        image = Image.open(io.BytesIO(files[0].read()))
        assert image.size == (1290, 2796) and files[0].content_type == "image/png"


def test_instagram_can_fit_a_portrait_image_with_black_side_bars(ws, db_session):
    import io

    from PIL import Image

    from app.services.social import media

    source = io.BytesIO()
    Image.new("RGB", (600, 1200), "red").save(source, "PNG")
    upload = uploaded(db_session, ws, "portrait.png", "image/png", source.getvalue())
    artifact = Artifact(workspace_id=ws.id, type="carousel", status="ready", content_json={
        "title": "Fitted portrait", "slide_keys": [upload.key],
        "slide_files": [{"key": upload.key, "filename": upload.filename, "content_type": upload.content_type}],
        "instagram_fits": [True],
    })
    db_session.add(artifact)
    db_session.commit()

    with media.media_for(artifact, "instagram") as files:
        image = Image.open(io.BytesIO(files[0].read()))
        assert image.size == (1080, 1080)
        assert max(image.getpixel((20, 540))) < 10  # black padding on the left
        assert max(image.getpixel((1060, 540))) < 10  # and on the right
        assert image.getpixel((540, 540))[0] > 200  # full portrait remains centered


def test_instagram_can_position_a_landscape_crop_horizontally(ws, db_session):
    import io

    from PIL import Image

    from app.services.social import media

    source = io.BytesIO()
    landscape = Image.new("RGB", (1200, 600), "red")
    landscape.paste("blue", (600, 0, 1200, 600))
    landscape.save(source, "PNG")
    upload = uploaded(db_session, ws, "landscape.png", "image/png", source.getvalue())
    artifact = Artifact(workspace_id=ws.id, type="carousel", status="ready", content_json={
        "title": "Positioned landscape", "slide_keys": [upload.key],
        "slide_files": [{"key": upload.key, "filename": upload.filename, "content_type": upload.content_type}],
        "instagram_x_positions": [1.0],
    })
    db_session.add(artifact)
    db_session.commit()

    with media.media_for(artifact, "instagram") as files:
        image = Image.open(io.BytesIO(files[0].read()))
        assert image.size == (1080, 1080)
        assert image.getpixel((540, 540))[2] > image.getpixel((540, 540))[0]  # selected right side


def test_an_uploaded_video_goes_out_from_a_temporary_file(client, auth, ws, db_session):
    from app.services.social import media

    mp4 = uploaded(db_session, ws, "clip.mp4", "video/mp4", b"v" * (80 * 1024))
    r = client.post("/api/launchpad/uploads", json={"upload_id": str(mp4.id), "duration_s": 42}, headers=auth)
    assert r.status_code == 200 and r.json()["media"] == "video" and r.json()["duration_s"] == 42
    art = db_session.get(Artifact, uuid.UUID(r.json()["id"]))
    with media.media_for(art, "linkedin") as files:
        assert files[0].kind == "video" and files[0].path and files[0].size == 80 * 1024


def test_only_files_linkedin_takes_can_be_uploaded(client, auth, ws, db_session):
    def register(up):
        return client.post("/api/launchpad/uploads", json={"upload_id": str(up.id)}, headers=auth)

    assert register(uploaded(db_session, ws, "doc.pdf", "application/pdf", b"%PDF")).status_code == 415
    assert register(uploaded(db_session, ws, "half.png", "image/png", b"x", status="pending")).status_code == 409
    big = uploaded(db_session, ws, "huge.png", "image/png", b"x")
    big.size_bytes = 40 * 1024 * 1024
    db_session.commit()
    assert register(big).status_code == 413
    assert client.post("/api/launchpad/uploads", json={"upload_id": str(uuid.uuid4())}, headers=auth).status_code == 404


def test_deleting_an_upload_record_removes_its_file(db_session, ws):
    from app.services.storage import storage

    up = uploaded(db_session, ws, "gone.png", "image/png", b"PNG")
    kept = uploaded(db_session, ws, "kept.png", "image/png", b"PNG")
    db_session.delete(kept)
    db_session.rollback()  # a delete that never commits leaves the file alone
    assert storage.exists(kept.key)
    db_session.delete(up)
    db_session.commit()
    assert not storage.exists(up.key)


def test_deleting_an_uploaded_file_from_the_library_removes_record_and_file(client, auth, ws, db_session):
    from app.models import Upload
    from app.services.storage import storage

    up = uploaded(db_session, ws, "pic.png", "image/png", b"PNG")
    art = client.post("/api/launchpad/uploads", json={"upload_id": str(up.id)}, headers=auth).json()
    assert client.delete(f"/api/artifacts/{art['id']}", headers=auth).status_code == 200
    db_session.expire_all()
    assert db_session.get(Upload, up.id) is None and not storage.exists(up.key)


def test_the_daily_sweep_removes_files_with_no_record(db_session, ws, session_factory):
    from app.models import Upload
    from app.services.storage import keys, storage
    from app.services.uploads import sweep_orphan_uploads

    old = datetime.now(UTC).timestamp() - 3 * 24 * 3600
    orphan = keys.upload(ws.id, uuid.uuid4(), "orphan.png")
    fresh = keys.upload(ws.id, uuid.uuid4(), "fresh.png")  # may still be on its way: kept
    storage.put_bytes(orphan, b"x")
    storage.put_bytes(fresh, b"x")
    os.utime(storage.path(orphan), (old, old))
    known = uploaded(db_session, ws, "known.png", "image/png", b"x")
    os.utime(storage.path(known.key), (old, old))
    stale = uploaded(db_session, ws, "stale.png", "image/png", b"x", status="pending")
    stale.created_at = datetime.now(UTC) - timedelta(days=2)
    db_session.commit()
    stale_id, stale_key = stale.id, stale.key

    assert sweep_orphan_uploads(session_factory) == 1
    assert not storage.exists(orphan) and storage.exists(fresh) and storage.exists(known.key)
    db_session.expire_all()
    assert db_session.get(Upload, stale_id) is None and not storage.exists(stale_key)


def test_an_uploaded_file_can_be_renamed_but_not_retyped(client, auth, ws, db_session):
    up = uploaded(db_session, ws, "IMG_2041.png", "image/png", b"PNG")
    art = client.post("/api/launchpad/uploads", json={"upload_id": str(up.id)}, headers=auth).json()
    r = client.patch(f"/api/artifacts/{art['id']}", json={"title": "  Q3 chart  ",
                                                            "content": {"content_type": "video/mp4", "media": "video"}},
                     headers=auth)
    assert r.status_code == 200
    listed = {a["id"]: a for a in client.get("/api/launchpad/postable", headers=auth).json()}[art["id"]]
    assert listed["title"] == "Q3 chart" and listed["media"] == "image"
    assert client.patch(f"/api/artifacts/{art['id']}", json={"title": "  "}, headers=auth).status_code == 400


def test_uploaded_files_carry_a_preview_link(client, auth, ws, db_session):
    png = uploaded(db_session, ws, "a.png", "image/png", b"PNG")
    mp4 = uploaded(db_session, ws, "b.mp4", "video/mp4", b"v" * (80 * 1024))
    for up in (png, mp4):
        brief = client.post("/api/launchpad/uploads", json={"upload_id": str(up.id)}, headers=auth).json()
        assert brief["view_url"]
    kit = made(db_session, ws, "launch_kit", post_title="Kit", posts={"linkedin": ["Hi"]})
    listed = {a["id"]: a for a in client.get("/api/launchpad/postable", headers=auth).json()}
    assert listed[str(kit.id)]["view_url"] is None


def test_a_slide_deck_is_listed_and_posts_its_slides_as_images(client, auth, ws, db_session, monkeypatch):
    from app.services.social import media
    from app.slides import export
    from app.slides.build import fit
    from app.slides.content import clamp_deck

    raw = {"title": "Pricing for writers", "subtitle": "What two years taught us.", "slides": [
        {"layout": "title", "heading": "Pricing for writers", "lead": "What two years taught us."},
        *[{"layout": "section", "heading": f"Part {i}"} for i in range(5)],
        {"layout": "closing", "heading": "Key takeaways", "takeaways": ["Charge more.", "Readers take it seriously."]}]}
    deck = fit(clamp_deck(raw, "detailed"), "dark-space", "detailed", 3)
    art = Artifact(workspace_id=ws.id, type="slide_deck", status="ready",
                   content_json={"title": "Slide deck: Pricing for writers", "theme": "dark-space", "format": "detailed",
                                 "seed": "abc", "deck": deck})
    db_session.add(art)
    db_session.commit()
    listed = {a["id"]: a for a in client.get("/api/launchpad/postable", headers=auth).json()}[str(art.id)]
    assert listed["type"] == "slide_deck" and listed["media"] == "image" and listed["media_count"] == 7
    assert listed["title"] == "Pricing for writers"
    assert listed["prefill"]["linkedin"].startswith("Pricing for writers\n\nWhat two years taught us.")
    assert "- Charge more." in listed["prefill"]["linkedin"]

    drawn: list[int] = []

    def chrome(html, args, out):  # a screenshot of the size asked for: a batch of slides stacked
        import io

        from PIL import Image

        w, h = (int(v) for v in next(a for a in args if a.startswith("--window-size=")).split("=")[1].split(","))
        drawn.append(h // 1080)
        buf = io.BytesIO()
        Image.new("RGB", (w, h), "navy").save(buf, "PNG")
        return buf.getvalue(), ""

    monkeypatch.setattr(export, "_run_chrome", chrome)
    with media.media_for(art, "x") as files:  # X takes 4 images: one Chrome run draws them
        assert [f.filename for f in files] == [f"slide-{i}.png" for i in range(1, 5)] and drawn == [4]
        assert all(f.data.startswith(b"\x89PNG") for f in files)
    with media.media_for(art, "linkedin") as files:
        assert len(files) == 7 and all(f.content_type == "image/png" for f in files)
    with media.media_for(art, "instagram") as files:
        import io

        from PIL import Image

        image = Image.open(io.BytesIO(files[0].read()))
        assert image.size == (1080, 1080)
        assert max(image.getpixel((540, 20))) < 10  # slide decks fit by default instead of losing both sides
        assert image.getpixel((540, 540))[2] > 40  # the complete navy slide remains centered
    acct = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    assert schedule(client, auth, "linkedin", acct, artifact_id=str(art.id)).status_code == 200
    r = schedule(client, auth, "bluesky", artifact_id=str(art.id))
    assert r.status_code == 400 and "Instagram, Threads and LinkedIn" in r.json()["detail"]


def test_a_slide_deck_that_cannot_be_drawn_is_retried(ws, db_session, monkeypatch):
    from app.infographics.image import ImageUnavailable
    from app.services.social import SocialError, media
    from app.slides import export

    art = Artifact(workspace_id=ws.id, type="slide_deck", status="ready", content_json={
        "format": "detailed", "deck": {"title": "T", "slides": [{"layout": "section", "heading": "Hello"}]}})
    db_session.add(art)
    db_session.commit()

    def no_chrome(*a, **k):
        raise ImageUnavailable("No Chrome")

    monkeypatch.setattr(export, "_run_chrome", no_chrome)
    with pytest.raises(SocialError, match="could not be drawn") as err, media.media_for(art, "x"):
        pass
    assert not err.value.permanent


def test_an_audio_overview_is_listed_to_download_but_never_posted(client, auth, ws, db_session):
    audio = made(db_session, ws, "audio_overview", key="ws/a/overview.mp3", title="Audio overview: Pricing", duration_s=225)
    listed = {a["id"]: a for a in client.get("/api/launchpad/postable", headers=auth).json()}[str(audio.id)]
    assert listed["media"] == "audio" and listed["media_count"] == 0 and listed["duration_s"] == 225
    assert listed["download_url"]
    acct = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    r = schedule(client, auth, "linkedin", acct, artifact_id=str(audio.id))
    assert r.status_code == 400 and "Audio can't be posted" in r.json()["detail"]


def test_a_mind_constellation_is_never_listed_or_posted(client, auth, ws, db_session):
    """A map is downloaded (image or PDF), not launched: it isn't offered to attach and can't be scheduled."""
    mind = Artifact(workspace_id=ws.id, type="mind_map", status="ready",
                    content_json={"title": "Mind Constellation: All posts", "root": {"id": "r", "label": "Pricing"}})
    db_session.add(mind)
    db_session.commit()
    assert str(mind.id) not in {a["id"] for a in client.get("/api/launchpad/postable", headers=auth).json()}
    acct = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    r = schedule(client, auth, "linkedin", acct, artifact_id=str(mind.id))
    assert r.status_code == 400 and "can't be posted" in r.json()["detail"]


def test_a_video_or_image_can_go_out_without_a_caption(client, auth, ws, db_session, monkeypatch):
    """An upload starts with no words (they are the writer's to add): a post that carries media may stay that way.
    Without media, a post still needs words."""
    from app.services import launchpad
    from app.services.social import linkedin, x

    li = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    upload = made(db_session, ws, "upload", key="ws/u/clip.mp4", data=os.urandom(100_000), media="video",
                  content_type="video/mp4", filename="clip.mp4")
    r = schedule(client, auth, "linkedin", li, content="", artifact_id=str(upload.id))
    assert r.status_code == 200, r.text
    r = schedule(client, auth, "linkedin", li, content="  ")
    assert r.status_code == 422 and r.json()["detail"]["message"] == "Write something to post, or attach an image or video."
    created = schedule(client, auth, "linkedin", li, content="Words", artifact_id=str(upload.id)).json()
    r = client.patch(f"/api/calendar/{created['id']}", json={"content": "", "artifact_id": None}, headers=auth)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "no_text"  # emptied and no media left

    # Publishing: LinkedIn gets an empty caption, X a post with the media and no "text" at all.
    sent: dict = {}
    monkeypatch.setattr(linkedin, "_upload_video", lambda acct, m: "urn:li:video:1")
    monkeypatch.setattr(linkedin, "_call", lambda method, url, **kw: sent.setdefault("li", kw["json"]) and httpx.Response(
        201, headers={"x-restli-id": "urn:li:share:1"}, request=httpx.Request(method, url)))
    li_item = item(db_session, ws, li, minutes=0, content="", artifact_id=upload.id)
    launchpad.publish_item(db_session, li_item)
    assert li_item.status == "posted" and sent["li"]["commentary"] == "" and sent["li"]["content"]["media"]["id"]

    xa = account(db_session, ws, "x", scopes="tweet.write media.write")
    monkeypatch.setattr(x, "can_post_media", lambda a: True)
    monkeypatch.setattr(x, "_upload_video", lambda headers, m: "m1")
    monkeypatch.setattr(x, "_access", lambda db, a: "token")
    monkeypatch.setattr(x, "_call", lambda method, url, **kw: sent.setdefault("x", kw["json"]) and httpx.Response(
        201, json={"data": {"id": "t1"}}, request=httpx.Request(method, url)))
    x_item = item(db_session, ws, xa, minutes=0, content="", artifact_id=upload.id)
    launchpad.publish_item(db_session, x_item)
    assert x_item.status == "posted" and sent["x"] == {"media": {"media_ids": ["m1"]}}

    text_only = item(db_session, ws, xa, minutes=0, content="")
    launchpad.publish_item(db_session, text_only)
    assert text_only.status == "failed" and text_only.error == "Nothing to post."


def test_post_now_publishes_in_the_same_request_and_is_never_left_scheduled(client, auth, ws, db_session, monkeypatch):
    from app.models import Job
    from app.services.social import linkedin

    li = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    monkeypatch.setattr(linkedin, "publish", lambda db, a, posts, media=None: ("urn:li:share:9", "https://linkedin.com/x"))
    now = lambda **kw: client.post("/api/calendar", json={  # noqa: E731  (no time sent: the server takes it)
        "platform": "linkedin", "content": "Hello", "social_account_id": str(li.id), "publish_now": True, **kw}, headers=auth)

    text = now()
    assert text.status_code == 200, text.text
    assert text.json()["status"] == "posted" and text.json()["external_url"] == "https://linkedin.com/x"

    video = made(db_session, ws, "video", key="ws/v/now.mp4", data=os.urandom(100_000), duration_s=30)
    media = now(artifact_id=str(video.id)).json()
    assert media["status"] == "publishing"  # uploading goes through a job: never "scheduled" in between
    job = db_session.query(Job).filter(Job.kind == "publish_post").one()
    assert job.params["item_id"] == media["id"]


def test_saving_a_failed_or_draft_post_reschedules_it_at_a_time_still_ahead(client, auth, ws, db_session):
    li = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    year = datetime.now(UTC).year + 1
    for status in ("failed", "draft", "reminded"):
        it = item(db_session, ws, li, minutes=-90, status=status)
        # Its old time has passed: rescheduled there, it would go out at the very next run.
        r = client.patch(f"/api/calendar/{it.id}", json={"status": "scheduled"}, headers=auth)
        assert r.status_code == 409 and r.json()["detail"]["code"] == "missed", status
        r = client.patch(f"/api/calendar/{it.id}", json={"status": "scheduled", "local_time": f"{year}-01-05T10:30",
                                                         "timezone": "UTC"}, headers=auth)
        assert r.status_code == 200, r.text
        got = r.json()
        assert got["status"] == "scheduled" and got["error"] is None
        assert datetime.fromisoformat(got["scheduled_at"]) == datetime(year, 1, 5, 10, 30, tzinfo=UTC)


def test_the_list_says_what_each_item_already_has_scheduled(client, auth, ws, db_session):
    li = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    deck = made(db_session, ws, "summary", summary="Raise prices once a year.")
    video = made(db_session, ws, "video", key="ws/v/s.mp4", data=os.urandom(100_000), duration_s=30)
    later = item(db_session, ws, li, minutes=600, artifact_id=deck.id)
    sooner = item(db_session, ws, li, minutes=120, artifact_id=deck.id)
    item(db_session, ws, li, minutes=-60, artifact_id=deck.id)  # its time has passed
    item(db_session, ws, li, minutes=300, status="posted", artifact_id=deck.id)
    item(db_session, ws, li, minutes=300, status="failed", artifact_id=deck.id)
    listed = {a["id"]: a for a in client.get("/api/launchpad/postable", headers=auth).json()}
    assert [s["id"] for s in listed[str(deck.id)]["scheduled"]] == [str(sooner.id), str(later.id)]
    assert listed[str(deck.id)]["scheduled"][0]["platform_label"] == "LinkedIn"
    assert listed[str(video.id)]["scheduled"] == []


def test_linkedin_callback_redirect_fits_proxy_header_buffer(client, auth, ws, monkeypatch):
    from urllib.parse import parse_qs, urlparse

    from app.auth import encode_signed
    from app.services.social import linkedin

    # LinkedIn's openid scope adds an id_token JWT; carrying it in the ticket made Nginx answer 502.
    monkeypatch.setattr(linkedin, "exchange_code", lambda code: {
        "access_token": "a" * 600, "expires_in": 5183999, "scope": "openid,profile,w_member_social",
        "token_type": "Bearer", "id_token": "j" * 2000, "external_id": "li7", "handle": "Ada Lovelace",
        "avatar_url": "https://media.licdn.com/" + "p" * 200})
    state = encode_signed({"typ": "social_state", "nonce": "n", "ws": str(ws.id), "platform": "linkedin"},
                          timedelta(minutes=5))
    r = client.get("/api/social/linkedin/callback", params={"code": "c", "state": state}, follow_redirects=False)
    assert r.status_code == 302 and len(r.headers["location"]) < 3500
    ticket = parse_qs(urlparse(r.headers["location"]).query)["link"][0]
    r = client.post("/api/social/complete", json={"ticket": ticket}, headers=auth)
    assert r.status_code == 200 and any(a["handle"] == "Ada Lovelace" for a in r.json()["accounts"])


def test_x_oauth_state_fits_x_limit_and_recovers_pkce_verifier(client, auth, ws, monkeypatch):
    import base64
    import hashlib
    from urllib.parse import parse_qs, urlparse

    from app.auth import decode_token_full
    from app.services.social import x

    monkeypatch.setattr(x, "configured", lambda: True)
    exchanged = []
    monkeypatch.setattr(x, "exchange_code", lambda code, verifier: exchanged.append((code, verifier)) or {
        "access_token": "a", "refresh_token": "r", "expires_in": 7200, "scope": X_SCOPES,
        "external_id": "x-oauth-1", "handle": "ada",
    })

    started = client.post("/api/social/x/start", headers=auth)
    assert started.status_code == 200
    query = parse_qs(urlparse(started.json()["url"]).query)
    state = query["state"][0]
    saved = decode_token_full(state, expected_type="social_state")
    assert len(state) <= 500 and "verifier" not in saved
    verifier = x.pkce_verifier(saved["nonce"])
    expected_challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    assert query["code_challenge"] == [expected_challenge]

    callback = client.get("/api/social/x/callback", params={"code": "code", "state": state}, follow_redirects=False)
    assert callback.status_code == 302 and exchanged == [("code", verifier)]


def test_threads_connects_directly_and_can_be_scheduled(client, auth, ws, db_session, monkeypatch):
    from urllib.parse import parse_qs, urlparse

    from app.services.social import threads

    monkeypatch.setattr(threads, "configured", lambda: True)
    monkeypatch.setattr(threads, "authorize_url", lambda state: f"https://www.threads.com/oauth/authorize?state={state}")
    monkeypatch.setattr(threads, "exchange_code", lambda code: {
        "access_token": "threads-access", "refresh_token": "threads-access", "expires_in": 5_184_000,
        "scope": "threads_basic,threads_content_publish", "external_id": "threads-1", "handle": "ada.threads",
    })

    started = client.post("/api/social/threads/start", headers=auth)
    assert started.status_code == 200
    state = parse_qs(urlparse(started.json()["url"]).query)["state"][0]
    callback = client.get("/api/social/threads/callback", params={"code": "code", "state": state},
                          follow_redirects=False)
    ticket = parse_qs(urlparse(callback.headers["location"]).query)["link"][0]
    completed = client.post("/api/social/complete", json={"ticket": ticket}, headers=auth)
    assert completed.status_code == 200
    direct = next(a for a in completed.json()["accounts"] if a["platform"] == "threads")
    assert direct["handle"] == "ada.threads"

    connected = db_session.get(SocialAccount, uuid.UUID(direct["id"]))
    assert schedule(client, auth, "threads", connected).status_code == 200


def test_meta_channels_are_visible_and_callable_only_for_allowlisted_notestack_email(
        client, auth, ws, db_session, monkeypatch):
    from app.config import settings
    from app.services.social import facebook, instagram, threads, x

    connected = account(db_session, ws, "threads", external_id="threads-private")
    connected_x = account(db_session, ws, "x", external_id="x-private")
    for module in (x, facebook, instagram, threads):
        monkeypatch.setattr(module, "configured", lambda: True)
    monkeypatch.setattr(threads, "authorize_url", lambda state: f"https://threads.example/authorize?state={state}")

    monkeypatch.setattr(settings, "social_review_allowed_emails", "somebody-else@example.com")
    hidden = client.get("/api/social/accounts", headers=auth).json()
    assert hidden["visible"]["facebook"] is False
    assert hidden["visible"]["instagram"] is False
    assert hidden["visible"]["threads"] is False
    assert hidden["visible"]["x"] is False
    assert not any(row["platform"] in ("x", "facebook", "instagram", "threads") for row in hidden["accounts"])
    denied = client.post("/api/social/threads/start", headers=auth)
    assert denied.status_code == 403 and denied.json()["detail"]["code"] == "not_available"
    assert schedule(client, auth, "threads", connected).status_code == 403
    assert client.post("/api/social/x/start", headers=auth).status_code == 403
    assert schedule(client, auth, "x", connected_x).status_code == 403

    # Matching is case-insensitive and ignores surrounding whitespace.
    monkeypatch.setattr(settings, "social_review_allowed_emails", "  ADA@EXAMPLE.COM  ")
    shown = client.get("/api/social/accounts", headers=auth).json()
    assert all(shown["visible"][platform] and shown["available"][platform]
               for platform in ("x", "facebook", "instagram", "threads"))
    assert any(row["platform"] == "threads" for row in shown["accounts"])
    assert client.post("/api/social/threads/start", headers=auth).status_code == 200


def test_threads_publishes_a_direct_reply_chain(ws, db_session, monkeypatch):
    from app.services.social import threads

    acct = account(db_session, ws, "threads", refresh="threads-token")
    created, published = [], []

    def call(method, url, **kwargs):
        if method == "POST" and url.endswith("/me/threads"):
            created.append(kwargs["params"])
            return reply(200, method, url, {"id": f"container-{len(created)}"})
        if method == "POST" and url.endswith("/me/threads_publish"):
            published.append(kwargs["params"])
            return reply(200, method, url, {"id": f"thread-{len(published)}"})
        if method == "GET" and url.endswith("/thread-1"):
            return reply(200, method, url, {"permalink": "https://www.threads.net/@ada/post/one"})
        raise AssertionError((method, url, kwargs))

    monkeypatch.setattr(threads, "_call", call)
    external_id, external_url = threads.publish(db_session, acct, ["First", "Second"], [])
    assert (external_id, external_url) == ("thread-1", "https://www.threads.net/@ada/post/one")
    assert created[0]["media_type"] == "TEXT" and "reply_to_id" not in created[0]
    assert created[1]["reply_to_id"] == "thread-1"


def test_instagram_unified_login_url_uses_configuration_not_scopes(monkeypatch):
    from urllib.parse import parse_qs, urlparse

    from app.config import settings
    from app.services.social import instagram

    monkeypatch.setattr(settings, "instagram_enabled", True)
    monkeypatch.setattr(settings, "instagram_client_id", "meta-app-1")
    monkeypatch.setattr(settings, "instagram_client_secret", "meta-secret")
    monkeypatch.setattr(settings, "instagram_config_id", "unified-config-1")
    monkeypatch.setattr(settings, "instagram_graph_version", "v26.0")

    assert instagram.configured() is True
    query = parse_qs(urlparse(instagram.authorize_url("signed-state")).query)
    assert query == {
        "client_id": ["meta-app-1"],
        "redirect_uri": [instagram.redirect_uri()],
        "state": ["signed-state"],
        "response_type": ["code"],
        "config_id": ["unified-config-1"],
        "override_default_response_type": ["true"],
    }
    assert "scope" not in query


def test_facebook_business_login_url_uses_configuration_not_scopes(monkeypatch):
    from urllib.parse import parse_qs, urlparse

    from app.config import settings
    from app.services.social import facebook

    monkeypatch.setattr(settings, "facebook_enabled", True)
    monkeypatch.setattr(settings, "facebook_client_id", "meta-app-1")
    monkeypatch.setattr(settings, "facebook_client_secret", "meta-secret")
    monkeypatch.setattr(settings, "facebook_config_id", "pages-config-1")
    monkeypatch.setattr(settings, "facebook_graph_version", "v26.0")

    assert facebook.configured() is True
    query = parse_qs(urlparse(facebook.authorize_url("signed-state")).query)
    assert query == {
        "client_id": ["meta-app-1"],
        "redirect_uri": [facebook.redirect_uri()],
        "state": ["signed-state"],
        "response_type": ["code"],
        "config_id": ["pages-config-1"],
        "override_default_response_type": ["true"],
    }
    assert "scope" not in query


def test_facebook_callback_links_the_selected_page(client, auth, ws, db_session, monkeypatch):
    from urllib.parse import parse_qs, urlparse

    from app.services.social import facebook

    monkeypatch.setattr(facebook, "configured", lambda: True)
    monkeypatch.setattr(facebook, "authorize_url",
                        lambda state: f"https://www.facebook.com/dialog/oauth?state={state}")
    monkeypatch.setattr(facebook, "exchange_code", lambda code: {
        "access_token": "page-access-token",
        "scope": "pages_show_list,pages_read_engagement,pages_manage_posts",
        "authorization_user_id": "meta-user-42",
        "external_id": "page-42",
        "handle": "Ada's Studio",
        "avatar_url": "https://cdn.example.com/page.jpg",
    })

    started = client.post("/api/social/facebook/start", headers=auth)
    assert started.status_code == 200
    state = parse_qs(urlparse(started.json()["url"]).query)["state"][0]
    callback = client.get("/api/social/facebook/callback", params={"code": "meta-code", "state": state})
    assert callback.status_code == 200
    assert "Facebook connected" in callback.text and "Close this tab" in callback.text
    assert "Return to Notestack" in callback.text and "/app/launchpad" in callback.text

    stored = db_session.query(SocialAccount).filter_by(workspace_id=ws.id, platform="facebook").one()
    assert stored.handle == "Ada's Studio"
    assert stored.external_id == "page-42"
    assert stored.authorization_user_id == "meta-user-42"


def test_facebook_exchanges_code_and_discovers_selected_page(monkeypatch):
    from app.config import settings
    from app.services.social import facebook

    monkeypatch.setattr(settings, "facebook_client_id", "meta-app-1")
    monkeypatch.setattr(settings, "facebook_client_secret", "meta-secret")
    calls = []

    def call(method, url, **kwargs):
        calls.append((method, url, kwargs.get("params") or {}))
        if url.endswith("/oauth/access_token"):
            return reply(200, method, url, {"access_token": "business-token"})
        if url.endswith("/me"):
            return reply(200, method, url, {"id": "meta-user-42"})
        if url.endswith("/me/accounts"):
            return reply(200, method, url, {"data": [{
                "id": "page-42", "name": "Ada's Studio", "access_token": "page-token",
                "picture": {"data": {"url": "https://cdn.example/page.jpg"}},
            }]})
        raise AssertionError((method, url, kwargs))

    monkeypatch.setattr(facebook, "_call", call)
    info = facebook.exchange_code("one-time-code")
    assert info["access_token"] == "page-token" and info["external_id"] == "page-42"
    assert info["authorization_user_id"] == "meta-user-42"
    assert info["handle"] == "Ada's Studio" and info["avatar_url"] == "https://cdn.example/page.jpg"
    assert calls[0][2]["client_secret"] == "meta-secret" and calls[0][2]["code"] == "one-time-code"


def test_facebook_publishes_a_page_post(ws, db_session, monkeypatch):
    from app.services.social import facebook

    acct = account(db_session, ws, "facebook", scopes=facebook.SCOPES)
    calls = []

    def call(method, url, **kwargs):
        calls.append((method, url, kwargs.get("params") or {}))
        if method == "POST" and url.endswith(f"/{acct.external_id}/feed"):
            return reply(200, method, url, {"id": "page-42_post-1"})
        if method == "GET" and url.endswith("/page-42_post-1"):
            return reply(200, method, url, {"permalink_url": "https://www.facebook.com/page-42/posts/post-1"})
        raise AssertionError((method, url, kwargs))

    monkeypatch.setattr(facebook, "_call", call)
    external_id, external_url = facebook.publish(db_session, acct, ["Hello from Notestack"], [])
    assert (external_id, external_url) == (
        "page-42_post-1", "https://www.facebook.com/page-42/posts/post-1")
    assert calls[0][2]["message"] == "Hello from Notestack" and calls[0][2]["access_token"] == "tok"


def test_instagram_callback_links_the_selected_account(client, auth, ws, db_session, monkeypatch):
    from urllib.parse import parse_qs, urlparse

    from app.services.social import instagram

    monkeypatch.setattr(instagram, "configured", lambda: True)
    monkeypatch.setattr(instagram, "authorize_url",
                        lambda state: f"https://www.facebook.com/dialog/oauth?state={state}")
    monkeypatch.setattr(instagram, "exchange_code", lambda code: {
        "access_token": "instagram-system-user-token",
        "scope": "instagram_basic,instagram_content_publish",
        "authorization_user_id": "meta-user-42",
        "external_id": "ig-17841400000000000",
        "handle": "ada.photos",
        "avatar_url": "https://cdn.example.com/ada.jpg",
    })

    started = client.post("/api/social/instagram/start", headers=auth)
    assert started.status_code == 200
    state = parse_qs(urlparse(started.json()["url"]).query)["state"][0]
    callback = client.get("/api/social/instagram/callback", params={"code": "meta-code", "state": state})
    assert callback.status_code == 200
    assert "Instagram connected" in callback.text and "close this tab" in callback.text
    assert "Return to Notestack" in callback.text and "/app/launchpad" in callback.text

    # The recipient only needs the shareable Meta URL. No Notestack session or /social/complete request is required.
    stored = db_session.query(SocialAccount).filter_by(workspace_id=ws.id, platform="instagram").one()
    assert stored.handle == "ada.photos"
    assert stored.external_id == "ig-17841400000000000"
    assert stored.authorization_user_id == "meta-user-42"


def test_expired_instagram_link_shows_its_expiry_without_a_login(client, ws):
    from app.auth import encode_signed

    state = encode_signed({"typ": "social_state", "nonce": "n", "ws": str(ws.id), "platform": "instagram"},
                          timedelta(seconds=-1))
    response = client.get("/api/social/instagram/callback", params={"code": "unused", "state": state})
    assert response.status_code == 410
    assert "connection link expired" in response.text
    assert "Ask the Notestack workspace owner" in response.text
    assert 'id="expiry"' in response.text


def test_instagram_exchanges_code_and_discovers_assigned_account(monkeypatch):
    from app.config import settings
    from app.services.social import instagram

    monkeypatch.setattr(settings, "instagram_client_id", "meta-app-1")
    monkeypatch.setattr(settings, "instagram_client_secret", "meta-secret")
    calls = []

    def call(method, url, **kwargs):
        calls.append((method, url, kwargs.get("params") or {}))
        if url.endswith("/oauth/access_token"):
            return reply(200, method, url, {"access_token": "system-token"})
        if url.endswith("/me"):
            return reply(200, method, url, {"id": "meta-user-42"})
        if url.endswith("/me/assigned_instagram_accounts"):
            return reply(200, method, url, {"data": [{
                "id": "ig-1", "username": "ada.photos", "profile_picture_url": "https://cdn.example/ada.jpg",
            }]})
        raise AssertionError((method, url, kwargs))

    monkeypatch.setattr(instagram, "_call", call)
    info = instagram.exchange_code("one-time-code")
    assert info["access_token"] == "system-token" and info["external_id"] == "ig-1"
    assert info["authorization_user_id"] == "meta-user-42"
    assert calls[0][2]["client_secret"] == "meta-secret" and calls[0][2]["code"] == "one-time-code"


def test_instagram_publishes_a_direct_image(ws, db_session, monkeypatch):
    from app.services.social import instagram
    from app.services.social.media import Media

    acct = account(db_session, ws, "instagram", scopes="instagram_basic,instagram_content_publish")
    uploaded = {}
    monkeypatch.setattr(instagram.storage, "put_bytes",
                        lambda key, data, content_type=None: uploaded.update({key: (data, content_type)}) or key)
    monkeypatch.setattr(instagram.storage, "public_url", lambda key: f"https://media.example.com/{key}")
    created = []

    def call(method, url, **kwargs):
        params = kwargs.get("params") or {}
        if method == "POST" and url.endswith(f"/{acct.external_id}/media"):
            created.append(params)
            return reply(200, method, url, {"id": "container-1"})
        if method == "GET" and url.endswith("/container-1"):
            return reply(200, method, url, {"status_code": "FINISHED"})
        if method == "POST" and url.endswith(f"/{acct.external_id}/media_publish"):
            assert params["creation_id"] == "container-1"
            return reply(200, method, url, {"id": "instagram-media-1"})
        if method == "GET" and url.endswith("/instagram-media-1"):
            return reply(200, method, url, {"permalink": "https://www.instagram.com/p/one/"})
        raise AssertionError((method, url, kwargs))

    monkeypatch.setattr(instagram, "_call", call)
    external_id, external_url = instagram.publish(
        db_session, acct, ["Photo caption"], [Media("image", "photo.jpg", "image/jpeg", data=b"JPEG")])
    assert (external_id, external_url) == ("instagram-media-1", "https://www.instagram.com/p/one/")
    assert created[0]["caption"] == "Photo caption"
    assert created[0]["image_url"].startswith("https://media.example.com/ws/")
    assert next(iter(uploaded.values())) == (b"JPEG", "image/jpeg")


def test_instagram_preserves_the_original_caption_url(ws, db_session, monkeypatch):
    from app.config import settings
    from app.models import TrackedLink
    from app.services import launchpad
    from app.services.social import instagram

    original = "Download it: https://play.google.com/store/apps/details?id=ai.notestack.app&pli=1"
    acct = account(db_session, ws, "instagram", scopes="instagram_basic,instagram_content_publish")
    image = made(db_session, ws, "quote_card", key="ws/q/instagram-link.png")
    post = item(db_session, ws, acct, minutes=0, content=original, artifact_id=image.id)
    sent = []
    monkeypatch.setattr(settings, "api_url", "https://public.notestack.example")
    monkeypatch.setattr(instagram, "can_post_media", lambda _account: True)
    monkeypatch.setattr(instagram, "publish", lambda _db, _account, posts, _media: sent.extend(posts)
                        or ("ig-post-1", "https://instagram.com/p/one"))

    launchpad.publish_item(db_session, post)

    assert post.status == "posted" and sent == [original]
    assert db_session.query(TrackedLink).filter_by(calendar_item_id=post.id).count() == 0


@pytest.mark.parametrize("platform", ["instagram", "threads"])
def test_direct_meta_media_uses_signed_r2_url_without_public_bucket(platform, ws, db_session, monkeypatch):
    from app.services.social import instagram, threads
    from app.services.social.media import Media

    module = instagram if platform == "instagram" else threads
    acct = account(db_session, ws, platform)
    uploaded = []
    signed = []
    monkeypatch.setattr(module.storage, "public_url", lambda key: None)
    monkeypatch.setattr(module.storage, "put_bytes",
                        lambda key, data, content_type=None: uploaded.append((key, data, content_type)) or key)
    monkeypatch.setattr(module.storage, "presign_get",
                        lambda key, ttl=None: signed.append((key, ttl)) or f"https://signed-r2.example/{key}?token=test")

    media = module._public_media(acct, [Media("image", "photo.jpg", "image/jpeg", data=b"JPEG")])
    assert module.can_post_media(acct) is True
    assert media[0][0] == "image" and media[0][1].startswith("https://signed-r2.example/ws/")
    assert uploaded[0][1:] == (b"JPEG", "image/jpeg")
    assert signed[-1][1] == module.MEDIA_URL_TTL


def test_linkedin_connect_from_the_app_returns_to_the_app(client, auth, ws, monkeypatch):
    from urllib.parse import parse_qs, urlparse

    from app.services.social import linkedin

    # The app starts the flow with client=app; the signed state remembers it and the callback answers the app's address.
    monkeypatch.setattr(linkedin, "configured", lambda: True)
    monkeypatch.setattr(linkedin, "authorize_url", lambda state: f"https://www.linkedin.com/oauth?state={state}")
    monkeypatch.setattr(linkedin, "exchange_code", lambda code: {
        "access_token": "a", "expires_in": 5183999, "scope": "w_member_social", "external_id": "li8", "handle": "Grace Hopper"})
    r = client.post("/api/social/linkedin/start", params={"client": "app"}, headers=auth)
    assert r.status_code == 200
    state = parse_qs(urlparse(r.json()["url"]).query)["state"][0]

    r = client.get("/api/social/linkedin/callback", params={"code": "c", "state": state}, follow_redirects=False)
    location = r.headers["location"]
    assert r.status_code == 302 and location.startswith("notestack://launchpad?")
    ticket = parse_qs(urlparse(location).query)["link"][0]
    r = client.post("/api/social/complete", json={"ticket": ticket}, headers=auth)
    assert r.status_code == 200 and any(a["handle"] == "Grace Hopper" for a in r.json()["accounts"])


def test_linkedin_connect_from_the_web_still_returns_to_the_web(client, auth, ws, monkeypatch):
    from urllib.parse import parse_qs, urlparse

    from app.config import settings
    from app.services.social import linkedin

    monkeypatch.setattr(linkedin, "configured", lambda: True)
    monkeypatch.setattr(linkedin, "authorize_url", lambda state: f"https://www.linkedin.com/oauth?state={state}")
    monkeypatch.setattr(linkedin, "exchange_code", lambda code: {"access_token": "a", "external_id": "li9", "handle": "Ada"})
    r = client.post("/api/social/linkedin/start", headers=auth)
    state = parse_qs(urlparse(r.json()["url"]).query)["state"][0]
    r = client.get("/api/social/linkedin/callback", params={"code": "c", "state": state}, follow_redirects=False)
    assert r.headers["location"].startswith(f"{settings.frontend_url.rstrip('/')}/app/launchpad?")


def test_linkedin_cancel_in_the_app_returns_to_the_app(client, ws):
    from app.auth import encode_signed

    state = encode_signed({"typ": "social_state", "nonce": "n", "ws": str(ws.id), "platform": "linkedin", "client": "app"},
                          timedelta(minutes=5))
    r = client.get("/api/social/linkedin/callback", params={"error": "user_cancelled", "state": state}, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith("notestack://launchpad?error=")

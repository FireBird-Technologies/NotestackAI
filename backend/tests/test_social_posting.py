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
    assert db_session.get(SocialAccount, acct.id).status == "revoked"
    assert statuses(db_session, later, due) == ["paused", "paused"]
    assert launchpad.publish_due(session_factory) == 0  # paused posts are never claimed
    got = client.get("/api/social/accounts", headers=auth).json()["accounts"][0]
    assert got["needs_reconnect"] is True


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
    acct = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    assert schedule(client, auth, "linkedin", acct, artifact_id=str(art.id)).status_code == 200
    r = schedule(client, auth, "bluesky", artifact_id=str(art.id))
    assert r.status_code == 400 and "X and LinkedIn" in r.json()["detail"]  # images go to X and LinkedIn only


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

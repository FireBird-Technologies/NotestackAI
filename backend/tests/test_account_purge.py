"""A deleted account's data is removed for good 30 days later; the users row stays, inactive."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text

from app.models import McpGrant, Notebook, Upload, User, Workspace, WorkspaceMember
from app.services.account_purge import erase_requested_accounts, purge_deleted_accounts
from app.services.email import ConsoleEmailProvider
from app.services.jobs import create_job
from app.services.storage import storage
from app.worker import run_job
from tests.test_auth import _signup


def _deleted_account(client, db, email: str, days_ago: int):
    data = _signup(client, email=email)
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    assert client.post("/api/notebooks", json={"title": "Research"}, headers=headers).status_code in (200, 201)
    user = db.scalar(select(User).where(User.email == email))
    workspace = db.scalar(select(Workspace).where(Workspace.owner_id == user.id))
    key = f"ws/{workspace.id}/uploads/u1/notes.txt"
    storage.put_bytes(key, b"my notes", "text/plain")
    db.add(Upload(workspace_id=workspace.id, user_id=user.id, key=key, filename="notes.txt",
                  content_type="text/plain", status="complete"))
    db.commit()
    assert client.post("/api/auth/delete-account", headers=headers).status_code == 200
    user.deleted_at = datetime.now(UTC) - timedelta(days=days_ago)
    db.commit()
    return user, workspace.id, key


def test_purge_removes_data_and_keeps_the_user_row(client, db_session):
    old, old_ws, old_key = _deleted_account(client, db_session, "old@example.com", days_ago=31)
    recent, recent_ws, recent_key = _deleted_account(client, db_session, "recent@example.com", days_ago=5)
    sent = len(ConsoleEmailProvider.sent)

    # Enforce foreign keys as Postgres does, so the purge is checked to delete children before their parents.
    db_session.commit()
    db_session.execute(text("PRAGMA foreign_keys=ON"))
    assert db_session.execute(text("PRAGMA foreign_keys")).scalar() == 1
    assert purge_deleted_accounts(db_session) == 1
    db_session.expire_all()

    # The old account: everything it made is gone...
    assert db_session.get(Workspace, old_ws) is None
    assert not db_session.scalars(select(Notebook).where(Notebook.workspace_id == old_ws)).all()
    assert not db_session.scalars(select(Upload).where(Upload.workspace_id == old_ws)).all()
    assert not db_session.scalars(select(WorkspaceMember).where(WorkspaceMember.user_id == old.id)).all()
    assert not db_session.scalars(select(McpGrant).where(McpGrant.user_id == old.id)).all()
    assert not storage.exists(old_key)
    # ...but its row is kept: inactive, purged, and with nothing left to sign in with.
    kept = db_session.get(User, old.id)
    assert kept is not None and kept.email == "old@example.com"
    assert kept.is_active is False and kept.deleted_at is not None and kept.purged_at is not None
    assert kept.password_hash is None and kept.name is None

    # The account deleted 5 days ago is untouched for now.
    assert db_session.get(Workspace, recent_ws) is not None
    assert storage.exists(recent_key)
    assert db_session.get(User, recent.id).purged_at is None

    # No emails, and a second run has nothing to do.
    assert len(ConsoleEmailProvider.sent) == sent
    assert purge_deleted_accounts(db_session) == 0

    # Signing in again is still refused.
    r = client.post("/api/auth/email/login", json={"email": "old@example.com", "password": "stardust-42"})
    assert r.status_code in (401, 403)


# Deleted from the iOS app: erased at once


IOS = {"X-Client-Platform": "ios"}


def _account(client, db, email: str):
    data = _signup(client, email=email)
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    client.post("/api/notebooks", json={"title": "Research"}, headers=headers)
    user = db.scalar(select(User).where(User.email == email))
    workspace = db.scalar(select(Workspace).where(Workspace.owner_id == user.id))
    key = f"ws/{workspace.id}/uploads/u1/notes.txt"
    storage.put_bytes(key, b"my notes", "text/plain")
    db.add(Upload(workspace_id=workspace.id, user_id=user.id, key=key, filename="notes.txt",
                  content_type="text/plain", status="complete"))
    db.commit()
    return user.id, workspace.id, key, headers


def test_deleting_from_ios_erases_everything_now(client, db_session):
    user_id, ws_id, key, headers = _account(client, db_session, "ios@example.com")
    other_id, other_ws, other_key, _ = _account(client, db_session, "other@example.com")
    # A file they added to someone else's workspace stays there, with its owner.
    db_session.add(Upload(workspace_id=other_ws, user_id=user_id, key="ws/x/shared.txt", filename="shared.txt",
                          content_type="text/plain", status="complete"))
    db_session.commit()
    db_session.execute(text("PRAGMA foreign_keys=ON"))  # as Postgres does (off for the sign ups: no plans rows here)
    assert client.post("/api/auth/delete-account", headers={**headers, **IOS}).json() == {"ok": True, "erased": True}
    db_session.commit()
    db_session.execute(text("PRAGMA foreign_keys=OFF"))
    db_session.expire_all()
    assert db_session.get(User, user_id) is None
    assert db_session.get(Workspace, ws_id) is None
    assert not db_session.scalars(select(Notebook).where(Notebook.workspace_id == ws_id)).all()
    assert not storage.exists(key)
    assert db_session.scalar(select(Upload.user_id).where(Upload.key == "ws/x/shared.txt")) == other_id
    assert db_session.get(User, other_id) and storage.exists(other_key)
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    # Nothing is left to refuse the address: it can sign up again, as a new account.
    assert _signup(client, email="ios@example.com")["user"]["id"] != str(user_id)


def test_deleting_from_android_or_the_web_keeps_the_30_days(client, db_session):
    for email, extra in (("a@example.com", {"X-Client-Platform": "android"}), ("w@example.com", {})):
        user_id, ws_id, key, headers = _account(client, db_session, email)
        assert client.post("/api/auth/delete-account", headers={**headers, **extra}).status_code == 200
        db_session.expire_all()
        user = db_session.get(User, user_id)
        assert user.deleted_at and user.erase_requested_at is None and user.purged_at is None
        assert db_session.get(Workspace, ws_id) and storage.exists(key)


@pytest.mark.parametrize("platform", [IOS, {"X-Client-Platform": "android"}, {}])
def test_deleting_signs_out_every_device(client, db_session, platform):
    first = _signup(client, email="many@example.com")
    login = {"email": "many@example.com", "password": "stardust-42"}
    devices = [first, *(client.post("/api/auth/email/login", json=login).json() for _ in range(2))]
    for d in devices:
        assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {d['access_token']}"}).status_code == 200
    headers = {"Authorization": f"Bearer {devices[1]['access_token']}", **platform}
    assert client.post("/api/auth/delete-account", headers=headers).status_code == 200
    db_session.expire_all()
    for d in devices:
        assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {d['access_token']}"}).status_code == 401
        assert client.get("/api/notebooks", headers={"Authorization": f"Bearer {d['access_token']}"}).status_code == 401
        assert client.post("/api/auth/refresh", json={"refresh_token": d["refresh_token"]}).status_code == 401


def test_an_erase_that_fails_is_finished_later(client, db_session, monkeypatch):
    user_id, ws_id, key, headers = _account(client, db_session, "flaky@example.com")
    real = storage.delete_prefix

    def down(prefix):
        raise RuntimeError("storage down")

    monkeypatch.setattr(storage, "delete_prefix", down)
    assert client.post("/api/auth/delete-account", headers={**headers, **IOS}).json() == {"ok": True, "erased": False}
    db_session.expire_all()
    assert db_session.get(User, user_id).is_active is False  # closed at once all the same
    assert client.get("/api/auth/me", headers=headers).status_code == 401
    monkeypatch.setattr(storage, "delete_prefix", real)
    assert erase_requested_accounts(db_session) == 1
    db_session.expire_all()
    assert db_session.get(User, user_id) is None and not storage.exists(key)


def test_a_job_running_during_the_erase_leaves_nothing_behind(client, db_session, session_factory):
    user_id, ws_id, _, headers = _account(client, db_session, "busy@example.com")
    late = f"ws/{ws_id}/late.txt"

    def handler_for(outcome):
        def handler(db, job):
            if db_session.get(User, user_id):
                client.post("/api/auth/delete-account", headers={**headers, **IOS})
            storage.put_bytes(late, b"late", "text/plain")
            if outcome:
                raise outcome

        return handler

    job = create_job(db_session, ws_id, "busy", {})
    run_job(job.id, session_factory=session_factory, handlers={"busy": handler_for(RuntimeError("gone"))})
    db_session.expire_all()
    assert db_session.get(User, user_id) is None
    assert not storage.exists(late)

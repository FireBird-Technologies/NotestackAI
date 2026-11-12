"""A deleted account's data is removed for good 30 days later; the users row stays, inactive."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text

from app.models import McpGrant, Notebook, Upload, User, Workspace, WorkspaceMember
from app.services.account_purge import purge_deleted_accounts
from app.services.email import ConsoleEmailProvider
from app.services.storage import storage
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

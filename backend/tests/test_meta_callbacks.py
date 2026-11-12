import base64
import hashlib
import hmac
import json

import pytest

from app.config import settings
from app.models import SocialAccount, Workspace
from app.services.crypto import encrypt
from tests.conftest import last_code


@pytest.fixture()
def workspace(client, db_session):
    client.post("/api/auth/email/register/start", json={
        "email": "meta@example.com", "password": "stardust-42", "name": "Meta Tester",
    })
    client.post("/api/auth/email/register/verify", json={"email": "meta@example.com", "code": last_code()})
    return db_session.query(Workspace).first()


def _signed(secret: str, user_id: str) -> str:
    raw = json.dumps({"algorithm": "HMAC-SHA256", "user_id": user_id}, separators=(",", ":")).encode()
    payload = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    signature = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    return f"{base64.urlsafe_b64encode(signature).decode().rstrip('=')}.{payload}"


def test_threads_data_deletion_callback_removes_credentials(client, db_session, workspace, monkeypatch):
    monkeypatch.setattr(settings, "threads_client_secret", "threads-test-secret")
    monkeypatch.setattr(settings, "api_url", "https://notestack.example")
    account = SocialAccount(
        workspace_id=workspace.id, platform="threads", handle="ada", external_id="threads-42",
        access_token=encrypt("access"), refresh_token=encrypt("refresh"), status="active",
    )
    db_session.add(account)
    db_session.commit()

    response = client.post("/meta/data-deletion", data={
        "signed_request": _signed("threads-test-secret", "threads-42"),
    })

    assert response.status_code == 200
    assert response.json()["url"].startswith("https://notestack.example/meta/data-deletion/status?code=")
    db_session.refresh(account)
    assert account.status == "disconnected"
    assert account.access_token == "" and account.refresh_token is None
    assert account.handle == "Deleted connection" and account.external_id == f"deleted:{account.id}"
    status = client.get(response.json()["url"].replace("https://notestack.example", ""))
    assert status.status_code == 200 and "deletion complete" in status.text.lower()


def test_threads_data_deletion_rejects_a_bad_signature(client, monkeypatch):
    monkeypatch.setattr(settings, "threads_client_secret", "threads-test-secret")
    response = client.post("/meta/data-deletion", data={"signed_request": _signed("wrong-secret", "threads-42")})
    assert response.status_code == 400


def test_threads_data_deletion_instructions_are_public(client):
    response = client.get("/meta/data-deletion")
    assert response.status_code == 200
    assert "Launchpad" in response.text and "Disconnect" in response.text


def test_facebook_instagram_data_deletion_removes_only_matching_meta_grants(
        client, db_session, workspace, monkeypatch):
    monkeypatch.setattr(settings, "facebook_client_secret", "main-meta-secret")
    monkeypatch.setattr(settings, "instagram_client_secret", "main-meta-secret")
    monkeypatch.setattr(settings, "api_url", "https://notestack.example")
    accounts = [
        SocialAccount(
            workspace_id=workspace.id, platform=platform, handle=platform,
            external_id=external_id, authorization_user_id=authorization_user_id,
            access_token=encrypt("access"), refresh_token=encrypt("refresh"), status="active",
        )
        for platform, external_id, authorization_user_id in (
            ("facebook", "page-42", "meta-user-42"),
            ("instagram", "ig-42", "meta-user-42"),
            ("facebook", "page-other", "meta-user-other"),
        )
    ]
    db_session.add_all(accounts)
    db_session.commit()

    response = client.post("/meta/facebook-instagram/data-deletion", data={
        "signed_request": _signed("main-meta-secret", "meta-user-42"),
    })

    assert response.status_code == 200
    assert response.json()["url"].startswith("https://notestack.example/meta/data-deletion/status?code=")
    for account in accounts:
        db_session.refresh(account)
    assert all(account.status == "disconnected" and account.access_token == "" and account.refresh_token is None
               and account.authorization_user_id is None and account.handle == "Deleted connection"
               for account in accounts[:2])
    assert accounts[2].status == "active" and accounts[2].access_token
    status = client.get(response.json()["url"].replace("https://notestack.example", ""))
    assert status.status_code == 200 and "Facebook and Instagram data deletion complete" in status.text


def test_facebook_instagram_deauthorize_uses_main_meta_secret(client, db_session, workspace, monkeypatch):
    monkeypatch.setattr(settings, "facebook_client_secret", "main-meta-secret")
    monkeypatch.setattr(settings, "instagram_client_secret", "main-meta-secret")
    monkeypatch.setattr(settings, "threads_client_secret", "threads-secret")
    account = SocialAccount(
        workspace_id=workspace.id, platform="instagram", handle="ada",
        external_id="ig-42", authorization_user_id="meta-user-42",
        access_token=encrypt("access"), refresh_token=encrypt("refresh"), status="active",
    )
    db_session.add(account)
    db_session.commit()

    rejected = client.post("/meta/facebook-instagram/deauthorize", data={
        "signed_request": _signed("threads-secret", "meta-user-42"),
    })
    assert rejected.status_code == 400

    response = client.post("/meta/facebook-instagram/deauthorize", data={
        "signed_request": _signed("main-meta-secret", "meta-user-42"),
    })
    assert response.status_code == 200 and response.json()["connections_removed"] == 1
    db_session.refresh(account)
    assert account.status == "disconnected" and account.access_token == ""


def test_facebook_instagram_data_deletion_instructions_are_public(client):
    response = client.get("/meta/facebook-instagram/data-deletion")
    assert response.status_code == 200
    assert "Facebook and Instagram data deletion" in response.text
    assert "Notestack Launchpad" in response.text and "Disconnect" in response.text

from app.services.email import ConsoleEmailProvider
from tests.conftest import last_code


def _signup(client, email="writer@example.com", password="stardust-42"):
    r = client.post("/api/auth/email/register/start", json={"email": email, "password": password, "name": "Ada L"})
    assert r.status_code == 200, r.text
    r = client.post("/api/auth/email/register/verify", json={"email": email, "code": last_code()})
    assert r.status_code == 200, r.text
    return r.json()


def test_signup_login_me_logout(client):
    data = _signup(client)
    assert data["created"] is True
    assert any(e.subject == "Welcome to Notestack" for e in ConsoleEmailProvider.sent)
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    assert client.get("/api/auth/me", headers=headers).json()["email"] == "writer@example.com"

    r = client.post("/api/auth/email/login", json={"email": "WRITER@example.com", "password": "stardust-42"})
    assert r.status_code == 200

    assert client.post("/api/auth/logout", headers=headers).status_code == 200
    assert client.get("/api/auth/me", headers=headers).status_code == 401  # token_version bumped


def test_wrong_code_and_attempt_limit(client):
    client.post("/api/auth/email/register/start", json={"email": "a@b.co", "password": "longenough"})
    for _ in range(5):
        r = client.post("/api/auth/email/register/verify", json={"email": "a@b.co", "code": "000000"})
        if last_code() == "000000":
            return  # astronomically unlikely collision
        assert r.status_code == 400
    r = client.post("/api/auth/email/register/verify", json={"email": "a@b.co", "code": last_code()})
    assert r.json()["detail"]["code"] == "too_many_attempts"


def test_resend_cooldown(client):
    client.post("/api/auth/email/register/start", json={"email": "c@d.co", "password": "longenough"})
    r = client.post("/api/auth/email/register/resend", json={"email": "c@d.co"})
    assert r.status_code == 429


def test_bad_password_and_weak_password(client):
    _signup(client)
    r = client.post("/api/auth/email/login", json={"email": "writer@example.com", "password": "nope-nope"})
    assert r.status_code == 401
    r = client.post("/api/auth/email/register/start", json={"email": "x@y.co", "password": "short"})
    assert r.status_code == 400


def test_password_reset_revokes_old_tokens(client):
    data = _signup(client)
    old = {"Authorization": f"Bearer {data['access_token']}"}
    client.post("/api/auth/password/forgot/start", json={"email": "writer@example.com"})
    code = last_code()
    r = client.post("/api/auth/password/forgot/check", json={"email": "writer@example.com", "code": code})
    assert r.status_code == 200
    r = client.post("/api/auth/password/forgot/complete",
                    json={"email": "writer@example.com", "code": code, "password": "new-orbit-99"})
    assert r.status_code == 200
    assert client.get("/api/auth/me", headers=old).status_code == 401


def test_google_user_cannot_use_password(client, db_session):
    from app.services.auth_identity import resolve_or_create_google_user

    resolve_or_create_google_user(db_session, email="g@example.com", google_id="123", name="G", avatar_url=None)
    db_session.commit()
    r = client.post("/api/auth/email/register/start", json={"email": "g@example.com", "password": "longenough"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "wrong_provider"


def test_delete_account(client):
    data = _signup(client)
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    assert client.post("/api/auth/delete-account", headers=headers).status_code == 200
    r = client.post("/api/auth/email/login", json={"email": "writer@example.com", "password": "stardust-42"})
    assert r.status_code == 403

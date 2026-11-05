"""Sign in with Apple (native and web) and Google tokens from the apps' own clients."""

import json
import time
import uuid
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from app.auth import create_access_token, encode_signed
from app.config import settings
from app.models import User
from app.services import apple_auth

BUNDLE = "ai.notestack.app"
SERVICES = "ai.notestack.web"
RELAY = "@privaterelay.appleid.com"
APPLE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
P8 = ec.generate_private_key(ec.SECP256R1()).private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
).decode()


class _Key:
    key = APPLE_KEY.public_key()


class _Keys:
    def get_signing_key_from_jwt(self, token):
        return _Key()


def apple_token(sub="apple-1", email="star@privaterelay.appleid.com", aud=BUNDLE, iss=apple_auth.APPLE_ISSUER, **extra):
    now = int(time.time())
    claims = {"iss": iss, "aud": aud, "sub": sub, "iat": now, "exp": now + 600, **extra}
    if email:
        claims.update(email=email, email_verified="true", is_private_email=str(email.endswith(RELAY)).lower())
    return jwt.encode(claims, APPLE_KEY, algorithm="RS256", headers={"kid": "k1"})


class _Res:
    def __init__(self, body):
        self.body = body

    def raise_for_status(self):
        return None

    def json(self):
        return self.body


@pytest.fixture
def apple(monkeypatch):
    """Apple configured, its keys this test's, and its token / revoke endpoints recorded instead of called."""
    monkeypatch.setattr(settings, "apple_team_id", "TEAM")
    monkeypatch.setattr(settings, "apple_key_id", "KEY")
    monkeypatch.setattr(settings, "apple_private_key", P8)
    monkeypatch.setattr(settings, "apple_bundle_ids", f"{BUNDLE},ai.notestack.app.dev")
    monkeypatch.setattr(settings, "apple_services_id", SERVICES)
    monkeypatch.setattr(apple_auth, "_keys", lambda: _Keys())
    calls = []

    def post(url, data=None, timeout=None):
        calls.append((url, data))
        return _Res({"refresh_token": "rt-1"} if url == apple_auth.APPLE_TOKEN_URL else {})

    monkeypatch.setattr(apple_auth.httpx, "post", post)
    return calls


def test_native_sign_up_then_sign_in_by_apple_id(client, apple):
    r = client.post("/api/auth/apple", json={"identity_token": apple_token(), "authorization_code": "c1", "name": "Star Gazer"})
    assert r.status_code == 200
    data = r.json()
    assert data["created"] is True and data["user"]["auth_provider"] == "apple" and data["user"]["name"] == "Star Gazer"
    # The code was traded for the refresh token, with a client secret signed by our key, for the app's client.
    url, form = apple[0]
    assert url == apple_auth.APPLE_TOKEN_URL and form["client_id"] == BUNDLE and form["code"] == "c1"
    assert jwt.get_unverified_header(form["client_secret"])["kid"] == "KEY"
    # Later sign ins carry no email: the account is found by Apple's id.
    r = client.post("/api/auth/apple", json={"identity_token": apple_token(email=None)})
    assert r.status_code == 200 and r.json()["created"] is False


def test_rejects_bad_tokens(client, apple):
    for token in (apple_token(aud="com.other.app"), apple_token(iss="https://evil.example"), "not-a-jwt"):
        assert client.post("/api/auth/apple", json={"identity_token": token}).status_code == 401
    expired = jwt.encode({"iss": apple_auth.APPLE_ISSUER, "aud": BUNDLE, "sub": "x", "iat": 1, "exp": 2}, APPLE_KEY, algorithm="RS256")
    assert client.post("/api/auth/apple", json={"identity_token": expired}).status_code == 401


def test_first_sign_in_without_email_is_refused(client, apple):
    r = client.post("/api/auth/apple", json={"identity_token": apple_token(sub="new", email=None)})
    assert r.status_code == 400


def test_one_provider_per_email(client, apple, db_session):
    from app.services.auth_identity import resolve_or_create_google_user

    resolve_or_create_google_user(db_session, email="g@example.com", google_id="g-1", name="G", avatar_url=None)
    db_session.commit()
    r = client.post("/api/auth/apple", json={"identity_token": apple_token(sub="a-2", email="g@example.com")})
    assert r.status_code == 409 and "Google" in r.json()["detail"]["message"]
    # And the other way round: an Apple account's email can't sign in with a password.
    client.post("/api/auth/apple", json={"identity_token": apple_token(sub="a-3", email="mine@example.com")})
    r = client.post("/api/auth/email/register/start", json={"email": "mine@example.com", "password": "stardust-42"})
    assert r.status_code == 409 and "Apple" in r.json()["detail"]["message"]


def test_delete_account_revokes_apple(client, apple):
    data = client.post("/api/auth/apple", json={"identity_token": apple_token(), "authorization_code": "c1"}).json()
    r = client.post("/api/auth/delete-account", headers={"Authorization": f"Bearer {data['access_token']}"})
    assert r.status_code == 200
    url, form = apple[-1]
    assert url == apple_auth.APPLE_REVOKE_URL and form["token"] == "rt-1" and form["client_id"] == BUNDLE


def test_web_redirect_flow(client, apple):
    assert client.get("/api/auth/providers").json()["apple"] == "redirect"
    r = client.get("/api/auth/apple/start", params={"next": "/app/notebooks"}, follow_redirects=False)
    assert r.status_code == 302
    q = parse_qs(urlparse(r.headers["location"]).query)
    assert q["client_id"] == [SERVICES] and q["response_mode"] == ["form_post"]
    assert q["redirect_uri"] == ["http://localhost:8000/api/auth/apple/callback"]
    nonce = q["nonce"][0]
    form = {
        "code": "c2",
        "state": q["state"][0],
        "id_token": apple_token(sub="web-1", email="web@example.com", aud=SERVICES, nonce=nonce),
        "user": json.dumps({"name": {"firstName": "Web", "lastName": "Star"}}),
    }
    # Apple's form POST comes back cross-site: the state cookie is sent as a header here.
    r = client.post("/api/auth/apple/callback", data=form, headers={"Cookie": f"ns_oauth_state={nonce}"}, follow_redirects=False)
    assert r.status_code == 303
    location = urlparse(r.headers["location"])
    assert location.path == "/auth/callback"
    frag = parse_qs(location.fragment)
    data = client.post("/api/auth/ticket", json={"ticket": frag["ticket"][0]}).json()
    assert data["created"] is True and data["user"]["name"] == "Web Star" and data["user"]["auth_provider"] == "apple"
    assert apple[0][1]["client_id"] == SERVICES


def _users(db_session):
    return db_session.query(User).count()


def _hidden_signup(client, **body):
    return client.post(
        "/api/auth/apple",
        json={"identity_token": apple_token(), "authorization_code": "c1", "name": "Star Gazer", "warn_hidden_email": True, **body},
    )


def test_hidden_email_asks_before_making_an_account(client, apple, db_session):
    before = _users(db_session)
    r = _hidden_signup(client)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "apple_hidden_email"
    assert _users(db_session) == before and apple == []  # nothing made, and the code is still unspent


def test_confirm_makes_the_account_once(client, apple, db_session):
    token = _hidden_signup(client).json()["detail"]["signup_token"]
    before = _users(db_session)
    r = client.post("/api/auth/apple/confirm", json={"signup_token": token})
    assert r.status_code == 200
    data = r.json()
    assert data["created"] is True and data["user"]["name"] == "Star Gazer" and data["user"]["email"].endswith(RELAY)
    url, form = apple[0]  # the code went with the token, for deleting the account later
    assert url == apple_auth.APPLE_TOKEN_URL and form["code"] == "c1" and form["client_id"] == BUNDLE
    r = client.post("/api/auth/apple/confirm", json={"signup_token": token})
    assert r.status_code == 200 and r.json()["created"] is False
    assert _users(db_session) == before + 1


@pytest.mark.parametrize(
    "token",
    [
        lambda good: good[:-4] + "abcd",
        lambda good: encode_signed({**jwt.decode(good, options={"verify_signature": False}), "exp": None}, timedelta(seconds=-5)),
        lambda good: create_access_token(uuid.uuid4(), 0),
    ],
    ids=["tampered", "expired", "another_kind"],
)
def test_confirm_refuses_bad_tokens(client, apple, db_session, token):
    good = _hidden_signup(client).json()["detail"]["signup_token"]
    before = _users(db_session)
    r = client.post("/api/auth/apple/confirm", json={"signup_token": token(good)})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "apple_signup_expired"
    assert _users(db_session) == before


def test_decline_revokes_so_apple_asks_again(client, apple, db_session):
    token = _hidden_signup(client).json()["detail"]["signup_token"]
    before = _users(db_session)
    assert client.post("/api/auth/apple/decline", json={"signup_token": token}).json() == {"ok": True}
    assert [url for url, _ in apple] == [apple_auth.APPLE_TOKEN_URL, apple_auth.APPLE_REVOKE_URL]
    assert apple[0][1]["code"] == "c1" and apple[1][1]["token"] == "rt-1" and apple[1][1]["client_id"] == BUNDLE
    assert _users(db_session) == before


def test_decline_leaves_a_made_account_alone(client, apple):
    token = _hidden_signup(client).json()["detail"]["signup_token"]
    client.post("/api/auth/apple/confirm", json={"signup_token": token})
    apple.clear()
    assert client.post("/api/auth/apple/decline", json={"signup_token": token}).json() == {"ok": True}
    assert apple == []


def test_decline_ignores_a_bad_token(client, apple):
    assert client.post("/api/auth/apple/decline", json={"signup_token": "nonsense"}).json() == {"ok": True}
    assert apple == []


def test_hidden_email_never_names_the_workspace(client, apple):
    def workspace(data):
        headers = {"Authorization": f"Bearer {data['access_token']}"}
        return client.get("/api/settings", headers=headers).json()["workspace"]["name"]

    # No name from Apple, through the warning or from a build that doesn't warn.
    token = _hidden_signup(client, name=None).json()["detail"]["signup_token"]
    assert workspace(client.post("/api/auth/apple/confirm", json={"signup_token": token}).json()) == "My workspace"
    older = client.post("/api/auth/apple", json={"identity_token": apple_token(sub="older", email=f"older{RELAY}")}).json()
    assert workspace(older) == "My workspace"
    # A name, or a real address, still names it.
    named = apple_token(sub="named", email=f"named{RELAY}")
    token = _hidden_signup(client, identity_token=named).json()["detail"]["signup_token"]
    assert workspace(client.post("/api/auth/apple/confirm", json={"signup_token": token}).json()) == "Star's workspace"
    shared = client.post("/api/auth/apple", json={"identity_token": apple_token(sub="shared", email="me@example.com")}).json()
    assert workspace(shared) == "me's workspace"


def test_a_name_given_later_is_kept(client, apple):
    data = client.post("/api/auth/apple", json={"identity_token": apple_token(sub="later")}).json()
    assert data["user"]["name"] is None
    r = client.patch("/api/settings", headers={"Authorization": f"Bearer {data['access_token']}"}, json={"name": "Real Person"})
    assert r.status_code == 200
    r = client.post("/api/auth/apple", json={"identity_token": apple_token(sub="later", email=None)})
    assert r.json()["user"]["name"] == "Real Person"


def test_real_email_is_never_asked_about(client, apple):
    r = client.post("/api/auth/apple", json={"identity_token": apple_token(sub="real", email="me@example.com"), "warn_hidden_email": True})
    assert r.status_code == 200 and r.json()["created"] is True


def test_returning_hidden_email_is_not_asked_again(client, apple):
    token = _hidden_signup(client).json()["detail"]["signup_token"]
    client.post("/api/auth/apple/confirm", json={"signup_token": token})
    r = _hidden_signup(client)
    assert r.status_code == 200 and r.json()["created"] is False
    # Apple usually leaves the email out of later sign ins.
    r = client.post("/api/auth/apple", json={"identity_token": apple_token(email=None), "warn_hidden_email": True})
    assert r.status_code == 200 and r.json()["created"] is False


def test_older_builds_make_the_account_straight_away(client, apple):
    r = client.post("/api/auth/apple", json={"identity_token": apple_token()})
    assert r.status_code == 200 and r.json()["created"] is True


def test_deleted_account_stays_refused(client, apple):
    token = _hidden_signup(client).json()["detail"]["signup_token"]
    data = client.post("/api/auth/apple/confirm", json={"signup_token": token}).json()
    client.post("/api/auth/delete-account", headers={"Authorization": f"Bearer {data['access_token']}"})
    r = client.post("/api/auth/apple/confirm", json={"signup_token": token})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "account_deleted"
    # Back through Apple's sheet, hidden email or not: Apple's id finds the deleted account first.
    for email in ("other@privaterelay.appleid.com", "real@example.com", None):
        r = client.post("/api/auth/apple", json={"identity_token": apple_token(email=email), "warn_hidden_email": True})
        assert r.status_code == 403 and r.json()["detail"]["code"] == "account_deleted"


def test_web_hidden_email_asks_first(client, apple, db_session):
    r = client.get("/api/auth/apple/start", params={"next": "/app/notebooks"}, follow_redirects=False)
    q = parse_qs(urlparse(r.headers["location"]).query)
    nonce = q["nonce"][0]
    form = {
        "code": "c3",
        "state": q["state"][0],
        "id_token": apple_token(sub="web-hidden", aud=SERVICES, nonce=nonce),
        "user": json.dumps({"name": {"firstName": "Web", "lastName": "Star"}}),
    }
    before = _users(db_session)
    r = client.post("/api/auth/apple/callback", data=form, headers={"Cookie": f"ns_oauth_state={nonce}"}, follow_redirects=False)
    assert r.status_code == 303
    location = urlparse(r.headers["location"])
    frag = parse_qs(location.fragment)
    assert location.path == "/auth/callback" and "ticket" not in frag and frag["next"] == ["/app/notebooks"]
    assert _users(db_session) == before and apple == []
    data = client.post("/api/auth/apple/confirm", json={"signup_token": frag["apple_signup"][0]}).json()
    assert data["created"] is True and data["user"]["name"] == "Web Star"
    assert apple[0][1]["client_id"] == SERVICES and apple[0][1]["code"] == "c3"
    assert apple[0][1]["redirect_uri"] == settings.apple_redirect_url


def test_web_callback_requires_state_cookie(client, apple):
    r = client.get("/api/auth/apple/start", follow_redirects=False)
    q = parse_qs(urlparse(r.headers["location"]).query)
    form = {"code": "c", "state": q["state"][0], "id_token": apple_token(aud=SERVICES, nonce=q["nonce"][0])}
    r = client.post("/api/auth/apple/callback", data=form, follow_redirects=False)
    assert r.headers["location"].startswith("http://localhost:5173/auth#error=")


def test_google_accepts_the_apps_own_clients(client, monkeypatch):
    from app.routers import auth as auth_router

    monkeypatch.setattr(settings, "google_client_id", "web-cid")
    monkeypatch.setattr(settings, "google_ios_client_ids", "ios-cid")
    claims = {"email": "g@example.com", "email_verified": True, "sub": "g-9"}
    for aud, ok in (("web-cid", True), ("ios-cid", True), ("someone-else", False)):
        monkeypatch.setattr(auth_router.google_id_token, "verify_oauth2_token", lambda *a, aud=aud, **k: {**claims, "aud": aud})
        r = client.post("/api/auth/google", json={"credential": "t"})
        assert (r.status_code == 200) is ok, (aud, r.status_code)

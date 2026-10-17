# ruff: noqa: E501
"""MCP: the OAuth sign-in, what tokens can and cannot do, and the tools, against the real API."""

import base64
import hashlib
import json
import uuid
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from mcp.server.auth.provider import AccessToken

from app.mcp import common, loopback, policy, provider, tokens, widgets
from app.models import McpAuthRequest, McpGrant, User
from tests.conftest import last_code
from tests.test_buildout import auth, connect, docs, feed  # noqa: F401  (fixtures and helpers)

BASE = "http://localhost:8000"
CLAUDE = "https://claude.ai/api/mcp/auth_callback"


@pytest.fixture()
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def mcp_db(monkeypatch, session_factory):
    """The OAuth provider opens its own sessions: point just those at the test database."""
    from app.mcp import store

    monkeypatch.setattr(store, "open_session", session_factory)


@pytest.fixture()
def http():
    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE, follow_redirects=False)


@pytest.fixture()
async def live():
    """A fresh MCP server with its session manager running (a manager can only be started once)."""
    from app.main import app
    from app.mcp.server import build_app

    server, asgi = build_app()
    old = (app.state.mcp_server, app.state.mcp_asgi)
    app.state.mcp_server, app.state.mcp_asgi = server, asgi
    async with server.session_manager.run():
        yield server
    app.state.mcp_server, app.state.mcp_asgi = old


def pkce():
    verifier = base64.urlsafe_b64encode(uuid.uuid4().bytes + uuid.uuid4().bytes).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


async def register(http, redirect=CLAUDE, name="Claude", **extra):
    body = {"client_name": name, "redirect_uris": [redirect], "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], **extra}
    r = await http.post("/register", json=body)
    return r


async def start(http, client_id, challenge, redirect=CLAUDE, state="st8", **extra):
    params = {"response_type": "code", "client_id": client_id, "redirect_uri": redirect, "code_challenge": challenge,
              "code_challenge_method": "S256", "state": state, "resource": f"{BASE}/mcp", **extra}
    return await http.get("/authorize", params=params)


def request_id(location: str) -> str:
    return parse_qs(urlparse(location).query)["req"][0]


async def connect_app(http, web, redirect=CLAUDE, approve=True, scopes=None, **authorize_extra):
    """The whole sign-in, the way an app and a writer do it. Returns what the app ends up holding."""
    client_id = (await register(http, redirect)).json()["client_id"]
    verifier, challenge = pkce()
    r = await start(http, client_id, challenge, redirect, **authorize_extra)
    assert r.status_code == 302, r.text
    req = request_id(r.headers["location"])
    d = await http.post(f"/api/mcp/requests/{req}/decision", json={"approve": approve, "scopes": scopes}, headers=web)
    assert d.status_code == 200, d.text
    back = urlparse(d.json()["redirect_url"])
    q = parse_qs(back.query)
    out = {"client_id": client_id, "verifier": verifier, "redirect": redirect, "request": req, "query": q, "back": back}
    if approve:
        out["code"] = q["code"][0]
    return out


async def exchange(http, app_, code=None, verifier=None, redirect=None):
    return await http.post("/token", data={
        "grant_type": "authorization_code", "client_id": app_["client_id"], "code": code or app_["code"],
        "code_verifier": verifier or app_["verifier"], "redirect_uri": redirect or app_["redirect"]})


async def sign_in(http, web, **kw):
    app_ = await connect_app(http, web, **kw)
    r = await exchange(http, app_)
    assert r.status_code == 200, r.text
    return {**app_, **r.json()}


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


# Discovery


@pytest.mark.anyio
async def test_discovery_documents_are_served_at_the_root(http):
    meta = (await http.get("/.well-known/oauth-authorization-server")).json()
    assert meta["issuer"].rstrip("/") == BASE
    assert meta["authorization_endpoint"] == f"{BASE}/authorize" and meta["token_endpoint"] == f"{BASE}/token"
    assert meta["registration_endpoint"] == f"{BASE}/register" and meta["code_challenge_methods_supported"] == ["S256"]
    res = (await http.get("/.well-known/oauth-protected-resource/mcp")).json()
    assert res["resource"] == f"{BASE}/mcp" and [a.rstrip("/") for a in res["authorization_servers"]] == [BASE]


@pytest.mark.anyio
async def test_an_unsigned_call_is_pointed_at_the_sign_in_discovery(http):
    r = await http.post("/mcp", json={})
    assert r.status_code == 401
    assert f"{BASE}/.well-known/oauth-protected-resource/mcp" in r.headers["www-authenticate"]


@pytest.mark.anyio
async def test_other_urls_still_belong_to_the_api(http):
    r = await http.get("/api/nope")
    assert r.status_code == 404 and r.json() == {"detail": "Not Found"}


# Registering an app


@pytest.mark.anyio
@pytest.mark.parametrize("redirect", [CLAUDE, "https://chatgpt.com/connector/oauth/x", "http://localhost:6274/cb",
                                      "http://127.0.0.1:3000/cb", "cursor://anysphere.cursor-retrieval/oauth/callback",
                                      "https://some-new-client.example/cb"])
async def test_sensible_redirects_can_register(http, redirect):
    assert (await register(http, redirect)).status_code == 201


@pytest.mark.anyio
@pytest.mark.parametrize("redirect", ["javascript:alert(1)", "http://evil.example/cb", "ftp://x.example/cb",
                                      "https://user:pw@x.example/cb", "https://x.example/cb#frag", "myapp://cb",
                                      "data:text/html,hi", "file:///etc/passwd"])
async def test_dangerous_redirects_are_refused(http, redirect):
    r = await register(http, redirect)
    assert r.status_code == 400 and r.json()["error"] in ("invalid_redirect_uri", "invalid_client_metadata")


@pytest.mark.anyio
async def test_unknown_scopes_cannot_be_registered(http):
    assert (await register(http, scope="mcp:admin")).status_code == 400


def test_how_much_to_trust_an_app_comes_from_where_it_returns_to():
    assert policy.check_redirect_uri(CLAUDE) == "verified"
    assert policy.check_redirect_uri("https://evil.example/cb") == "unverified"
    assert policy.check_redirect_uri("http://localhost:1/cb") == "local"
    assert policy.check_redirect_uri("vscode://x/cb") == "local"


# The approval step


@pytest.mark.anyio
async def test_authorize_sends_the_writer_to_the_web_app(http):
    cid = (await register(http)).json()["client_id"]
    r = await start(http, cid, pkce()[1])
    assert r.status_code == 302 and r.headers["location"].startswith("http://localhost:5173/connect?req=")


@pytest.mark.anyio
async def test_authorize_refuses_an_unregistered_redirect(http):
    cid = (await register(http)).json()["client_id"]
    r = await start(http, cid, pkce()[1], redirect="https://attacker.example/cb")
    assert r.status_code == 400


@pytest.mark.anyio
async def test_authorize_refuses_plain_pkce_and_other_servers(http):
    cid = (await register(http)).json()["client_id"]
    plain = await http.get("/authorize", params={"response_type": "code", "client_id": cid, "redirect_uri": CLAUDE,
                                                  "code_challenge": "x" * 43, "code_challenge_method": "plain"})
    assert plain.status_code in (302, 400) and "code_challenge_method" in plain.headers.get("location", plain.text)
    other = await start(http, cid, pkce()[1], resource="https://other.example/mcp")
    assert "error" in parse_qs(urlparse(other.headers.get("location", "")).query) or other.status_code == 400


@pytest.mark.anyio
async def test_the_approval_screen_tells_the_writer_who_is_asking(http, auth):  # noqa: F811
    cid = (await register(http, "https://evil.example/cb", name="Official Claude")).json()["client_id"]
    req = request_id((await start(http, cid, pkce()[1], "https://evil.example/cb")).headers["location"])
    shown = (await http.get(f"/api/mcp/requests/{req}", headers=auth)).json()
    assert shown["client_name"] == "Official Claude" and shown["redirect_host"] == "evil.example"
    assert shown["trust"] == "unverified"  # a name anyone can type is not proof; the address is
    assert [(s["scope"], s["requested"], s["required"]) for s in shown["scopes"]] == [
        ("mcp:read", True, True), ("mcp:write", True, False), ("mcp:share", True, False)]


@pytest.mark.anyio
async def test_only_a_signed_in_writer_can_see_or_decide_a_request(http, auth):  # noqa: F811
    cid = (await register(http)).json()["client_id"]
    req = request_id((await start(http, cid, pkce()[1])).headers["location"])
    assert (await http.get(f"/api/mcp/requests/{req}")).status_code == 401
    assert (await http.post(f"/api/mcp/requests/{req}/decision", json={"approve": True})).status_code == 401
    assert (await http.get(f"/api/mcp/requests/{req}", headers=bearer("junk"))).status_code == 401


@pytest.mark.anyio
async def test_denying_sends_the_app_back_with_an_error(http, auth):  # noqa: F811
    app_ = await connect_app(http, auth, approve=False, state="abc")
    assert app_["query"]["error"] == ["access_denied"] and app_["query"]["state"] == ["abc"]
    assert "code" not in app_["query"]


@pytest.mark.anyio
async def test_an_expired_request_is_gone(http, auth, db_session):  # noqa: F811
    cid = (await register(http)).json()["client_id"]
    req = request_id((await start(http, cid, pkce()[1])).headers["location"])
    row = db_session.get(McpAuthRequest, uuid.UUID(req))
    row.expires_at = row.expires_at.replace(year=2020)
    db_session.commit()
    assert (await http.get(f"/api/mcp/requests/{req}", headers=auth)).status_code == 404
    assert (await http.post(f"/api/mcp/requests/{req}/decision", json={"approve": True}, headers=auth)).status_code == 404


@pytest.mark.anyio
async def test_a_request_can_only_be_decided_once(http, auth):  # noqa: F811
    app_ = await connect_app(http, auth)
    again = await http.post(f"/api/mcp/requests/{app_['request']}/decision", json={"approve": True}, headers=auth)
    assert again.status_code == 404


# Trading the code for tokens


@pytest.mark.anyio
async def test_the_full_sign_in_gives_the_app_tokens(http, auth):  # noqa: F811
    t = await sign_in(http, auth)
    assert t["token_type"].lower() == "bearer" and t["expires_in"] == 3600 and t["refresh_token"]
    assert set(t["scope"].split()) == {"mcp:read", "mcp:write", "mcp:share"}
    assert t["query"]["state"] == ["st8"]


@pytest.mark.anyio
async def test_the_wrong_pkce_verifier_gets_nothing(http, auth):  # noqa: F811
    app_ = await connect_app(http, auth)
    r = await exchange(http, app_, verifier=pkce()[0])
    assert r.status_code == 400 and r.json()["error"] == "invalid_grant"
    assert (await exchange(http, app_)).status_code == 200  # a bad guess spends nothing: the real app can still finish


@pytest.mark.anyio
async def test_a_code_works_once(http, auth):  # noqa: F811
    app_ = await connect_app(http, auth)
    assert (await exchange(http, app_)).status_code == 200
    again = await exchange(http, app_)
    assert again.status_code == 400 and again.json()["error"] == "invalid_grant"


@pytest.mark.anyio
async def test_a_code_does_not_work_for_another_redirect_or_app(http, auth):  # noqa: F811
    app_ = await connect_app(http, auth)
    assert (await exchange(http, app_, redirect="https://claude.com/api/mcp/auth_callback")).status_code == 400
    other = (await register(http)).json()["client_id"]
    r = await http.post("/token", data={"grant_type": "authorization_code", "client_id": other, "code": app_["code"],
                                         "code_verifier": app_["verifier"], "redirect_uri": CLAUDE})
    assert r.status_code == 400


@pytest.mark.anyio
async def test_a_made_up_code_gets_nothing(http, auth):  # noqa: F811
    app_ = await connect_app(http, auth)
    assert (await exchange(http, app_, code="not-a-real-code")).status_code == 400


# Tokens: what they can and cannot do


@pytest.mark.anyio
async def test_mcp_tokens_do_not_work_on_the_web_api_and_web_tokens_do_not_work_on_mcp(http, auth):  # noqa: F811
    t = await sign_in(http, auth)
    for path in ("/api/auth/me", "/api/notebooks", "/api/settings", "/api/mcp/grants"):
        assert (await http.get(path, headers=bearer(t["access_token"]))).status_code == 401, path
    assert (await http.post("/api/auth/delete-account", headers=bearer(t["access_token"]))).status_code == 401
    web = auth["Authorization"].removeprefix("Bearer ")
    assert (await http.post("/mcp", json={}, headers=bearer(web))).status_code == 401
    assert (await http.post("/mcp", json={}, headers=bearer(t["refresh_token"]))).status_code == 401


def test_forged_and_misdirected_tokens_are_rejected():
    uid, grant = uuid.uuid4(), uuid.uuid4()
    good, _ = tokens.mint_access(uid, 1, grant, "c", ["mcp:read"])
    assert tokens.decode_access(good)
    elsewhere, _ = tokens.mint_access(uid, 1, grant, "c", ["mcp:read"], audience="https://other.example/mcp")
    assert tokens.decode_access(elsewhere) is None
    import jwt as pyjwt

    from app.config import settings

    web_signed = pyjwt.encode({"sub": str(uid), "typ": "mcp_access", "aud": tokens.resource(), "gid": str(grant), "tv": 1},
                              settings.jwt_secret, algorithm="HS256")
    assert tokens.decode_access(web_signed) is None  # the web secret cannot make an MCP token
    web_access = pyjwt.encode({"sub": str(uid), "typ": "access", "aud": tokens.resource()}, tokens.signing_key(), algorithm="HS256")
    assert tokens.decode_access(web_access) is None  # and a token of the wrong type is not one


@pytest.mark.anyio
async def test_refreshing_rotates_and_reusing_an_old_token_ends_the_connection(http, auth):  # noqa: F811
    t = await sign_in(http, auth)

    async def refresh(token):
        return await http.post("/token", data={"grant_type": "refresh_token", "client_id": t["client_id"],
                                                "refresh_token": token})

    second = await refresh(t["refresh_token"])
    assert second.status_code == 200 and second.json()["refresh_token"] != t["refresh_token"]
    stolen = await refresh(t["refresh_token"])  # the first one again: a copy was kept somewhere
    assert stolen.status_code == 400 and stolen.json()["error"] == "invalid_grant"
    # the connection is over, including the newest tokens the real app holds
    assert (await refresh(second.json()["refresh_token"])).status_code == 400


@pytest.mark.anyio
async def test_a_password_reset_disconnects_every_app(http, auth, live):  # noqa: F811
    t = await sign_in(http, auth)
    await http.post("/api/auth/password/forgot/start", json={"email": "ada@example.com"})
    r = await http.post("/api/auth/password/forgot/complete",
                        json={"email": "ada@example.com", "code": last_code(), "password": "new-orbit-99"})
    assert r.status_code == 200, r.text
    refreshed = await http.post("/token", data={"grant_type": "refresh_token", "client_id": t["client_id"],
                                                "refresh_token": t["refresh_token"]})
    assert refreshed.status_code == 400 and refreshed.json()["error"] == "invalid_grant"
    assert (await http.post("/mcp", json={}, headers=bearer(t["access_token"]))).status_code == 401
    assert (await http.get("/api/mcp/grants", headers=bearer(r.json()["access_token"]))).json() == []


@pytest.mark.anyio
async def test_a_refresh_token_belongs_to_one_app(http, auth):  # noqa: F811
    t = await sign_in(http, auth)
    other = (await register(http)).json()["client_id"]
    r = await http.post("/token", data={"grant_type": "refresh_token", "client_id": other, "refresh_token": t["refresh_token"]})
    assert r.status_code == 400


@pytest.mark.anyio
async def test_the_writer_can_list_and_end_a_connection(http, auth, live):  # noqa: F811
    t = await sign_in(http, auth)
    listed = (await http.get("/api/mcp/grants", headers=auth)).json()
    assert len(listed) == 1 and listed[0]["client_name"] == "Claude"
    assert listed[0]["scopes"] == ["mcp:read", "mcp:write", "mcp:share"]
    assert "token" not in json.dumps(listed).lower()
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    h = {**bearer(t["access_token"]), "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    assert (await http.post("/mcp", json=rpc, headers=h)).status_code == 200
    assert (await http.delete(f"/api/mcp/grants/{listed[0]['id']}", headers=auth)).status_code == 200
    assert (await http.post("/mcp", json=rpc, headers=h)).status_code == 401  # immediately, not when the token expires
    assert (await http.get("/api/mcp/grants", headers=auth)).json() == []
    assert (await http.post("/token", data={"grant_type": "refresh_token", "client_id": t["client_id"],
                                             "refresh_token": t["refresh_token"]})).status_code == 400


@pytest.mark.anyio
async def test_reconnecting_an_app_replaces_the_old_connection(http, auth, live, db_session):  # noqa: F811
    first = await sign_in(http, auth)
    second = await sign_in(http, auth)  # a fresh dynamic client registration with the same app identity

    listed = (await http.get("/api/mcp/grants", headers=auth)).json()
    assert len(listed) == 1
    assert listed[0]["id"] == str(db_session.query(McpGrant).filter(McpGrant.revoked_at.is_(None)).one().id)

    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    first_headers = {**bearer(first["access_token"]), "Accept": "application/json, text/event-stream",
                     "Content-Type": "application/json"}
    second_headers = {**bearer(second["access_token"]), "Accept": "application/json, text/event-stream",
                      "Content-Type": "application/json"}
    assert (await http.post("/mcp", json=rpc, headers=first_headers)).status_code == 401
    assert (await http.post("/mcp", json=rpc, headers=second_headers)).status_code == 200

    assert (await http.delete(f"/api/mcp/grants/{listed[0]['id']}", headers=auth)).status_code == 200
    assert (await http.post("/mcp", json=rpc, headers=second_headers)).status_code == 401
    assert (await http.get("/api/mcp/grants", headers=auth)).json() == []


@pytest.mark.anyio
async def test_nobody_can_end_someone_elses_connection(http, auth, client, db_session):  # noqa: F811
    await sign_in(http, auth)
    grant = db_session.query(McpGrant).one()
    client.post("/api/auth/email/register/start", json={"email": "bob@example.com", "password": "stardust-42", "name": "Bob"})
    from tests.conftest import last_code

    bob = client.post("/api/auth/email/register/verify", json={"email": "bob@example.com", "code": last_code()}).json()
    mine = {"Authorization": f"Bearer {bob['access_token']}"}
    assert (await http.delete(f"/api/mcp/grants/{grant.id}", headers=mine)).status_code == 404
    assert (await http.get("/api/mcp/grants", headers=mine)).json() == []


@pytest.mark.anyio
async def test_logging_out_everywhere_ends_mcp_access_too(http, auth, live):  # noqa: F811
    t = await sign_in(http, auth)
    h = {**bearer(t["access_token"]), "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    assert (await http.post("/mcp", json=rpc, headers=h)).status_code == 200
    assert (await http.post("/api/auth/logout", headers=auth)).status_code == 200  # bumps token_version
    assert (await http.post("/mcp", json=rpc, headers=h)).status_code == 401


@pytest.mark.anyio
async def test_a_deactivated_account_loses_mcp_access(http, auth, db_session, live):  # noqa: F811
    t = await sign_in(http, auth)
    db_session.query(User).update({"is_active": False})
    db_session.commit()
    h = {**bearer(t["access_token"]), "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    assert (await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers=h)).status_code == 401
    assert (await http.post("/token", data={"grant_type": "refresh_token", "client_id": t["client_id"],
                                             "refresh_token": t["refresh_token"]})).status_code == 400


@pytest.mark.anyio
async def test_reading_is_required_to_connect(http, auth):  # noqa: F811
    cid = (await register(http)).json()["client_id"]
    req = request_id((await start(http, cid, pkce()[1])).headers["location"])
    r = await http.post(f"/api/mcp/requests/{req}/decision", json={"approve": True, "scopes": ["mcp:write"]}, headers=auth)
    assert r.status_code == 400
    assert (await http.post(f"/api/mcp/requests/{req}/decision", json={"approve": True, "scopes": ["mcp:read"]}, headers=auth)).status_code == 200


@pytest.mark.anyio
async def test_the_writer_decides_what_an_app_may_do(http, auth):  # noqa: F811
    read_only = await sign_in(http, auth, scopes=["mcp:read"])
    assert read_only["scope"] == "mcp:read"
    with_share = await sign_in(http, auth, scopes=["mcp:read", "mcp:write", "mcp:share"])
    assert set(with_share["scope"].split()) == {"mcp:read", "mcp:write", "mcp:share"}
    assert "mcp:share" in policy.ADVERTISED  # generated results always carry their frontend Share URL


@pytest.mark.anyio
async def test_resource_metadata_asks_for_read_edit_and_share(http):
    res = (await http.get("/.well-known/oauth-protected-resource/mcp")).json()
    assert res["scopes_supported"] == ["mcp:read", "mcp:write", "mcp:share"]


@pytest.mark.anyio
async def test_the_loopback_only_goes_where_the_writer_allowed(auth, db_session):  # noqa: F811
    read_only = AccessToken(token="x", client_id="c", scopes=["mcp:read"], subject=str(uuid.uuid4()), claims={"tv": 1})
    no_scopes = AccessToken(token="x", client_id="c", scopes=[], subject=str(uuid.uuid4()), claims={"tv": 1})
    for method, path in [("GET", "/api/auth/me"), ("POST", "/api/auth/delete-account"), ("POST", "/api/billing/portal"),
                         ("DELETE", "/api/notebooks/00000000-0000-0000-0000-000000000000"), ("GET", "/api/settings"),
                         ("GET", "/api/documents/../auth/me"), ("POST", "/api/notebooks/../auth/logout/chat")]:
        with pytest.raises(loopback.NotAllowed):
            await loopback.call(method, path, read_only)
    with pytest.raises(loopback.NotAllowed):
        await loopback.call("GET", "/api/documents", no_scopes)
    for method, path in [("POST", "/api/artifacts/generate"), ("POST", "/api/notebooks"), ("POST", "/api/sources"),
                         ("POST", f"/api/artifacts/{uuid.uuid4()}/share")]:
        with pytest.raises(loopback.NotAllowed):  # read only: it cannot change anything or share
            await loopback.call(method, path, read_only)
    edit = AccessToken(token="x", client_id="c", scopes=["mcp:read", "mcp:write"], subject=str(uuid.uuid4()), claims={"tv": 1})
    with pytest.raises(loopback.NotAllowed):  # editing is not sharing
        await loopback.call("POST", f"/api/artifacts/{uuid.uuid4()}/share", edit)


def test_ids_cannot_smuggle_a_path():
    assert loopback.uid("00000000-0000-0000-0000-000000000000")
    for bad in ("../auth/me", "abc", "", "00000000-0000-0000-0000-000000000000/../x"):
        with pytest.raises(ValueError):
            loopback.uid(bad)


def test_the_server_will_not_run_on_a_plain_http_address_in_production(monkeypatch):
    from app.config import settings
    from app.mcp.server import build

    monkeypatch.setattr(settings, "env", "production")
    monkeypatch.setattr(settings, "api_url", "http://api.example.com")
    with pytest.raises(RuntimeError, match="https"):
        build()


def test_unused_registrations_do_not_pile_up(db_session, monkeypatch):
    from mcp.server.auth.provider import RegistrationError
    from mcp.shared.auth import OAuthClientInformationFull

    monkeypatch.setattr(provider, "MAX_UNUSED_CLIENTS", 3)
    for _ in range(3):
        provider.NotestackProvider._register(db_session, OAuthClientInformationFull(
            client_id=str(uuid.uuid4()), redirect_uris=[CLAUDE]))
    with pytest.raises(RegistrationError):
        provider.NotestackProvider._register(db_session, OAuthClientInformationFull(
            client_id=str(uuid.uuid4()), redirect_uris=[CLAUDE]))


# The tools


@pytest.fixture()
def as_writer(monkeypatch, client, auth, db_session):  # noqa: F811
    """Run a tool as the signed-in test user with full permissions, as the auth layer would set it."""
    me = client.get("/api/auth/me", headers=auth).json()
    tv = db_session.get(User, uuid.UUID(me["id"])).token_version
    access = AccessToken(token="x", client_id="t", scopes=["mcp:read", "mcp:write", "mcp:share"], subject=me["id"], claims={"tv": tv, "gid": "g"})
    monkeypatch.setattr(common, "get_access_token", lambda: access)
    return access


@pytest.fixture()
def mcp():
    from app.main import app

    return app.state.mcp_server


async def call(mcp, name, **args):
    from mcp.types import CallToolResult

    result = await mcp.call_tool(name, args)
    if isinstance(result, CallToolResult):  # a tool that also draws something in the chat
        return json.loads(result.content[0].text)
    return result[1] if isinstance(result, tuple) else json.loads(result[0].text)


async def call_raw(mcp, name, **args):
    """The whole result, including what only a widget receives."""
    return await mcp.call_tool(name, args)


def _blog(client, auth, run_jobs):  # noqa: F811
    connect(client, auth, run_jobs)
    return docs(client, auth)


@pytest.mark.anyio
async def test_find_content_searches_every_kind_at_once(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    posts = _blog(client, auth, run_jobs)
    client.post("/api/notebooks", json={"title": "Pricing essays", "document_ids": [posts[0]["id"]]}, headers=auth)
    out = await call(mcp, "find_content", query="pric")
    assert set(out) == {"posts", "topics", "sources", "notebooks"}
    assert out["posts"]["total"] >= 1 and all(p["id"] for p in out["posts"]["items"])
    assert [n["title"] for n in out["notebooks"]] == ["Pricing essays"]


@pytest.mark.anyio
async def test_find_content_matches_a_source_by_its_address(client, auth, run_jobs, feed, as_writer, mcp):  # noqa: F811
    _blog(client, auth, run_jobs)
    out = await call(mcp, "find_content", query="ada.example.com", kinds=["sources"])
    assert list(out) == ["sources"] and len(out["sources"]) == 1 and out["sources"][0]["post_count"] >= 1


@pytest.mark.anyio
async def test_find_content_needs_a_query(as_writer, mcp):
    assert (await call(mcp, "find_content", query="  "))["error"] == "empty_query"


@pytest.mark.anyio
async def test_find_content_only_sees_the_callers_own_workspace(client, auth, run_jobs, feed, monkeypatch, mcp, db_session):  # noqa: F811
    _blog(client, auth, run_jobs)
    client.post("/api/auth/email/register/start", json={"email": "bob@example.com", "password": "stardust-42", "name": "Bob"})
    from tests.conftest import last_code

    bob = client.post("/api/auth/email/register/verify", json={"email": "bob@example.com", "code": last_code()}).json()
    tv = db_session.get(User, uuid.UUID(bob["user"]["id"])).token_version
    monkeypatch.setattr(common, "get_access_token", lambda: AccessToken(
        token="x", client_id="t", scopes=["mcp:read"], subject=bob["user"]["id"], claims={"tv": tv}))
    out = await call(mcp, "find_content", query="pric")
    assert out["posts"]["total"] == 0 and out["sources"] == [] and out["notebooks"] == []


@pytest.mark.anyio
async def test_a_stale_sign_in_is_reported_not_crashed(client, monkeypatch, mcp):
    stale = AccessToken(token="x", client_id="t", scopes=["mcp:read"], subject=str(uuid.uuid4()), claims={"tv": 99})
    monkeypatch.setattr(common, "get_access_token", lambda: stale)
    assert (await call(mcp, "find_content", query="x"))["error"] == "not_signed_in"


@pytest.mark.anyio
async def test_a_tool_without_the_permission_says_so(monkeypatch, mcp):
    nothing = AccessToken(token="x", client_id="t", scopes=[], subject=str(uuid.uuid4()), claims={"tv": 1})
    monkeypatch.setattr(common, "get_access_token", lambda: nothing)
    assert (await call(mcp, "find_content", query="x"))["error"] == "not_allowed"


@pytest.fixture()
def fake_research(monkeypatch):
    from app.pipeline.research import ResearchResult
    from app.routers import notebooks as nbr

    seen = []

    def research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **kw):
        seen.append({"question": question, "notebook": notebook_title, "history": [(t.role, t.text) for t in history or []]})
        return ResearchResult(f"answer to {question}", False, [])

    monkeypatch.setattr(nbr, "research", research)
    return seen


@pytest.mark.anyio
async def test_ask_notebook_defaults_to_all_posts_and_continues_a_chat(client, auth, run_jobs, feed, as_writer, mcp, fake_research):  # noqa: F811
    _blog(client, auth, run_jobs)
    nb = client.post("/api/notebooks/archive", headers=auth).json()["id"]
    assert (await call(mcp, "ask_notebook", question="What about pricing?"))["error"] == "choose_scope"  # the writer chooses first
    first = await call(mcp, "ask_notebook", question="What about pricing?", notebook_id=nb)
    assert first["answer"] == "answer to What about pricing?" and first["unsupported"] is False
    assert first["chat_id"] and first["notebook_id"] and first["citations"] == []
    second = await call(mcp, "ask_notebook", question="Why?", chat_id=first["chat_id"], notebook_id=first["notebook_id"])
    assert second["chat_id"] == first["chat_id"]
    assert fake_research[1]["history"] == [("user", "What about pricing?"), ("assistant", "answer to What about pricing?")]


@pytest.mark.anyio
async def test_ask_notebook_scopes_to_a_named_notebook(client, auth, run_jobs, feed, as_writer, mcp, fake_research):  # noqa: F811
    posts = _blog(client, auth, run_jobs)
    nb = client.post("/api/notebooks", json={"title": "Habits", "document_ids": [posts[0]["id"]]}, headers=auth).json()
    out = await call(mcp, "ask_notebook", question="Tell me", notebook_id=nb["id"])
    assert out["notebook_id"] == nb["id"] and fake_research[-1]["notebook"] == "Habits"


@pytest.mark.anyio
async def test_ask_notebook_returns_citations(client, auth, run_jobs, feed, as_writer, mcp, monkeypatch):  # noqa: F811
    from app.pipeline.research import ResearchResult, VerifiedCitation
    from app.routers import notebooks as nbr

    posts = _blog(client, auth, run_jobs)
    path = next(p["path"] for p in posts if p["path"])
    monkeypatch.setattr(nbr, "research", lambda *a, **k: ResearchResult(
        "Charging more helped [1].", False, [VerifiedCitation(marker=1, path=path, line_start=1, line_end=2, quote="x")]))
    nb = client.post("/api/notebooks/archive", headers=auth).json()["id"]
    out = await call(mcp, "ask_notebook", question="Did pricing help?", notebook_id=nb)
    assert out["citations"] and out["citations"][0]["marker"] == 1 and out["citations"][0]["title"]


@pytest.mark.anyio
async def test_ask_notebook_rejects_a_bad_id_before_any_request(as_writer, mcp):
    assert (await call(mcp, "ask_notebook", question="hi", notebook_id="../auth/me"))["error"] == "bad_id"


@pytest.mark.anyio
async def test_ask_notebook_unknown_notebook_is_a_clean_error(as_writer, mcp):
    out = await call(mcp, "ask_notebook", question="hi", notebook_id="00000000-0000-0000-0000-000000000000")
    assert out["error"] == "not_found" and out["status"] == 404


# Everything together, over HTTP, as an app would do it


@pytest.mark.anyio
async def test_connect_then_use_the_tools_over_http(http, client, auth, run_jobs, feed, fake_research, live, db_session):  # noqa: F811
    from app.models import Artifact, Workspace

    _blog(client, auth, run_jobs)
    mind_map = Artifact(workspace_id=db_session.query(Workspace).first().id, type="mind_map", status="ready",
                        content_json={"title": "Map", "root": {"label": "Root", "note": "n", "children": [{"label": "Branch"}]}})
    db_session.add(mind_map)
    db_session.commit()
    t = await sign_in(http, auth)
    h = {**bearer(t["access_token"]), "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}

    async def rpc(method, params=None, id_=1, headers=h):
        r = await http.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}})
        assert r.status_code == 200, r.text
        return r.json()["result"]

    init = await rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
    assert init["serverInfo"]["name"] == "Notestack" and "find_content" in init["instructions"]
    assert "omit internal identifiers" in init["instructions"] and "refer to items by title" in init["instructions"]
    # Claude cannot read posts itself, so questions about the writer's words go through ask_notebook
    assert "ask_notebook" in init["instructions"] and "returns citations" in init["instructions"]
    assert "choose_options" in init["instructions"]
    assert "in-chat view" in init["instructions"]
    assert "artifact_preview_url" in init["instructions"]
    listed = {x["name"] for x in (await rpc("tools/list", id_=2))["tools"]}
    assert {"find_content", "ask_notebook", "generate_report", "share_artifact"} <= listed
    assert "get_document" not in listed
    found = await rpc("tools/call", {"name": "find_content", "arguments": {"query": "pric", "kinds": ["posts"]}}, 3)
    assert found["isError"] is False and json.loads(found["content"][0]["text"])["posts"]["total"] >= 1
    asked = await rpc("tools/call", {"name": "ask_notebook", "arguments": {"question": "Pricing?", "notebook_id": client.post("/api/notebooks/archive", headers=auth).json()["id"]}}, 4)
    assert json.loads(asked["content"][0]["text"])["answer"] == "answer to Pricing?"
    # the picture in the chat: the page is fetched like any resource, and the map goes only to the widget
    page = (await rpc("resources/read", {"uri": widgets.MIND_MAP_URI}, 7))["contents"][0]
    assert page["mimeType"] == "text/html;profile=mcp-app" and "ui/initialize" in page["text"]
    tools = {x["name"]: x for x in (await rpc("tools/list", id_=8))["tools"]}
    assert tools["show_mind_map"]["_meta"]["ui"]["resourceUri"] == widgets.MIND_MAP_URI
    shown = await rpc("tools/call", {"name": "show_mind_map", "arguments": {"artifact_id": str(mind_map.id)}}, 9)
    assert shown["structuredContent"]["root"]["children"][0]["label"] == "Branch" and shown["isError"] is False
    assert "structuredContent" not in json.loads(shown["content"][0]["text"])  # the model's text has no copy of the map
    # the same call after the access token is refreshed still works with the new token
    new = (await http.post("/token", data={"grant_type": "refresh_token", "client_id": t["client_id"],
                                            "refresh_token": t["refresh_token"]})).json()
    again = await rpc("tools/call", {"name": "find_content", "arguments": {"query": "pric"}}, 5,
                      headers={**h, "Authorization": f"Bearer {new['access_token']}"})
    assert again["isError"] is False
    # a page on another host pointing its name at us cannot reach /mcp
    evil = await http.post("/mcp", headers={**h, "Host": "evil.example"}, json={"jsonrpc": "2.0", "id": 6, "method": "tools/list"})
    assert evil.status_code in (400, 421)


def test_openai_apps_challenge_is_served_as_plain_text(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "openai_apps_challenge", "")
    assert client.get("/.well-known/openai-apps-challenge").status_code == 404
    monkeypatch.setattr(settings, "openai_apps_challenge", "tok-123\n")
    r = client.get("/.well-known/openai-apps-challenge")
    assert r.status_code == 200 and r.text == "tok-123" and r.headers["content-type"].startswith("text/plain")

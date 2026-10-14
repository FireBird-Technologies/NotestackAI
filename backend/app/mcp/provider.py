"""Notestack as an OAuth authorization server for MCP clients (Claude, ChatGPT, Cursor ...).

The flow: an app registers itself, sends the writer's browser to /authorize, which hands it to the web app's /connect
page. There the writer signs in the usual way and approves the app, which turns the request into a one-time code the
app trades for tokens. Everything is stored hashed; an app's access is one grant the writer can revoke."""

import logging
import time
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.config import settings
from app.mcp import policy, store, tokens
from app.models import McpAuthRequest, McpClient, McpGrant, User

log = logging.getLogger(__name__)

REQUEST_TTL = timedelta(minutes=10)
MAX_UNUSED_CLIENTS = 2000
STALE_CLIENT_AFTER = timedelta(days=7)
LAST_USED_EVERY = timedelta(minutes=5)


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime | None) -> datetime | None:
    return dt.replace(tzinfo=UTC) if dt is not None and dt.tzinfo is None else dt


def _live_user(db: Session, user_id: uuid.UUID | str | None) -> User | None:
    user = db.get(User, uuid.UUID(str(user_id))) if user_id else None
    return user if user and user.is_active and not user.deleted_at else None


def connect_url(request_id: uuid.UUID) -> str:
    return f"{settings.frontend_url.rstrip('/')}/connect?{urlencode({'req': str(request_id)})}"


def _scopes(requested: list[str] | None, client: OAuthClientInformationFull) -> list[str]:
    wanted = requested or (client.scope.split() if client.scope else None) or policy.ADVERTISED
    return [s for s in policy.SCOPES if s in wanted]


def client_key(info: dict) -> tuple[str, tuple[str, ...]]:
    """Stable identity for one app even when it dynamically registers again."""
    name = str(info.get("client_name") or "An app").strip().casefold()
    redirects = tuple(sorted(str(uri).strip().rstrip("/") for uri in (info.get("redirect_uris") or [])))
    return name, redirects


class NotestackProvider:
    # Registration

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        for uri in client_info.redirect_uris or []:
            try:
                policy.check_redirect_uri(str(uri))
            except policy.BadRedirect as exc:
                raise RegistrationError("invalid_redirect_uri", str(exc)) from exc
        await store.run(self._register, client_info)

    @staticmethod
    def _register(db: Session, info: OAuthClientInformationFull) -> None:
        cutoff = _now() - STALE_CLIENT_AFTER
        in_use = select(McpGrant.client_id).distinct()
        db.execute(delete(McpClient).where(McpClient.created_at < cutoff, McpClient.client_id.not_in(in_use)))
        unused = db.scalar(select(func.count()).select_from(McpClient).where(McpClient.client_id.not_in(in_use))) or 0
        if unused >= MAX_UNUSED_CLIENTS:
            raise RegistrationError("invalid_client_metadata", "Too many apps are registering. Try again later.")
        db.add(McpClient(client_id=info.client_id, info=info.model_dump(mode="json")))
        db.commit()

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        def load(db: Session):
            row = db.get(McpClient, client_id)
            return row.info if row else None

        info = await store.run(load)
        return OAuthClientInformationFull.model_validate(info) if info else None

    # Authorization

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        if params.resource and params.resource.rstrip("/") != tokens.resource():
            raise AuthorizeError("invalid_request", "That resource is not this server.")
        scopes = _scopes(params.scopes, client)
        if not scopes:
            raise AuthorizeError("invalid_scope", "No valid scope was requested.")

        def create(db: Session) -> uuid.UUID:
            req = McpAuthRequest(
                client_id=client.client_id, redirect_uri=str(params.redirect_uri),
                redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
                code_challenge=params.code_challenge, state=params.state, scopes=scopes,
                resource=tokens.resource(), expires_at=_now() + REQUEST_TTL, code_used=False,
            )
            db.add(req)
            db.commit()
            return req.id

        return connect_url(await store.run(create))

    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str):
        def load(db: Session):
            req = db.scalar(select(McpAuthRequest).where(McpAuthRequest.code_hash == tokens.digest(authorization_code)))
            if (not req or req.client_id != client.client_id or req.code_used or not req.user_id
                    or _aware(req.expires_at) < _now()):
                return None
            return req

        req = await store.run(load)
        if not req:
            return None
        return AuthorizationCode(
            code=authorization_code, scopes=list(req.scopes), expires_at=_aware(req.expires_at).timestamp(),
            client_id=req.client_id, code_challenge=req.code_challenge, redirect_uri=req.redirect_uri,
            redirect_uri_provided_explicitly=req.redirect_uri_provided_explicitly, resource=req.resource,
            subject=str(req.user_id),
        )

    async def exchange_authorization_code(self, client: OAuthClientInformationFull, authorization_code) -> OAuthToken:
        def exchange(db: Session):
            claimed = db.execute(
                update(McpAuthRequest)
                .where(McpAuthRequest.code_hash == tokens.digest(authorization_code.code), McpAuthRequest.code_used.is_(False))
                .values(code_used=True)
            ).rowcount
            if claimed != 1:  # used a moment ago by someone else, or twice: never hand out a second set of tokens
                db.rollback()
                raise TokenError("invalid_grant", "That code has already been used.")
            user = _live_user(db, authorization_code.subject)
            if not user:
                db.rollback()
                raise TokenError("invalid_grant", "That account is no longer active.")
            # Reconnecting the same logical app replaces its older connection. Some MCP clients dynamically register
            # again and receive a new client_id, so compare their displayed identity and redirect addresses too.
            now = _now()
            this_client = client_key(client.model_dump(mode="json"))
            previous = db.execute(
                select(McpGrant, McpClient).join(McpClient, McpClient.client_id == McpGrant.client_id)
                .where(McpGrant.user_id == user.id, McpGrant.revoked_at.is_(None))
            ).all()
            for old_grant, old_client in previous:
                if client_key(old_client.info) == this_client:
                    old_grant.revoked_at = now
            refresh = tokens.random_token()
            grant = McpGrant(
                user_id=user.id, client_id=client.client_id, scopes=list(authorization_code.scopes),
                resource=authorization_code.resource, refresh_hash=tokens.digest(refresh),
                refresh_expires_at=now + timedelta(days=settings.mcp_refresh_ttl_days), last_used_at=now,
            )
            db.add(grant)
            db.flush()
            access, ttl = tokens.mint_access(user.id, user.token_version, grant.id, client.client_id, grant.scopes)
            db.commit()
            return OAuthToken(access_token=access, expires_in=ttl, scope=" ".join(grant.scopes), refresh_token=refresh)

        return await store.run(exchange)

    # Refresh

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str):
        def load(db: Session):
            digest = tokens.digest(refresh_token)
            grant = db.scalar(select(McpGrant).where(McpGrant.client_id == client.client_id,
                                                      (McpGrant.refresh_hash == digest) | (McpGrant.previous_refresh_hash == digest)))
            if not grant or grant.revoked_at:
                return None
            if grant.refresh_hash != digest:  # an old token again: someone kept a copy. End the whole connection.
                grant.revoked_at = _now()
                db.commit()
                log.warning("MCP refresh token reused; grant %s revoked", grant.id)
                return None
            if _aware(grant.refresh_expires_at) < _now() or not _live_user(db, grant.user_id):
                return None
            return grant

        grant = await store.run(load)
        if not grant:
            return None
        return RefreshToken(token=refresh_token, client_id=grant.client_id, scopes=list(grant.scopes),
                            expires_at=int(_aware(grant.refresh_expires_at).timestamp()), resource=grant.resource,
                            subject=str(grant.user_id))

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token, scopes: list[str]) -> OAuthToken:
        def rotate(db: Session):
            digest = tokens.digest(refresh_token.token)
            grant = db.scalar(select(McpGrant).where(McpGrant.refresh_hash == digest, McpGrant.revoked_at.is_(None)))
            user = _live_user(db, grant.user_id) if grant else None
            if not grant or not user:
                raise TokenError("invalid_grant", "That connection is no longer active.")
            granted = list(grant.scopes)
            if scopes and not set(scopes) <= set(granted):
                raise TokenError("invalid_scope", "Those permissions were not granted.")
            new_refresh = tokens.random_token()
            grant.previous_refresh_hash, grant.refresh_hash = digest, tokens.digest(new_refresh)
            grant.refresh_expires_at = _now() + timedelta(days=settings.mcp_refresh_ttl_days)
            grant.last_used_at = _now()
            use = [s for s in granted if s in scopes] if scopes else granted
            access, ttl = tokens.mint_access(user.id, user.token_version, grant.id, grant.client_id, use)
            db.commit()
            return OAuthToken(access_token=access, expires_in=ttl, scope=" ".join(use), refresh_token=new_refresh)

        return await store.run(rotate)

    # Using a token

    async def load_access_token(self, token: str) -> AccessToken | None:
        claims = tokens.decode_access(token)
        if not claims:
            return None

        def check(db: Session):
            """The app's name when this is a live connection, otherwise None."""
            try:
                grant = db.get(McpGrant, uuid.UUID(claims["gid"]))
            except (KeyError, ValueError):
                return None
            user = _live_user(db, claims.get("sub"))
            if (not grant or grant.revoked_at or not user or str(grant.user_id) != claims["sub"]
                    or user.token_version != claims.get("tv")):
                return None
            if not grant.last_used_at or _now() - _aware(grant.last_used_at) > LAST_USED_EVERY:
                grant.last_used_at = _now()
                db.commit()
            client = db.get(McpClient, grant.client_id)
            return ((client.info.get("client_name") if client else None) or "App").strip()[:30] or "App"

        name = await store.run(check)
        if name is None:
            return None
        return AccessToken(token=token, client_id=claims["cid"], scopes=claims.get("scope", "").split(),
                           expires_at=int(claims.get("exp", time.time())), resource=claims["aud"], subject=claims["sub"],
                           claims={"gid": claims["gid"], "tv": claims["tv"], "cn": name})

    async def revoke_token(self, token) -> None:
        def revoke(db: Session):
            if isinstance(token, AccessToken):
                grant = db.get(McpGrant, uuid.UUID(token.claims["gid"])) if token.claims else None
            else:
                grant = db.scalar(select(McpGrant).where(McpGrant.refresh_hash == tokens.digest(token.token)))
            if grant and not grant.revoked_at:
                grant.revoked_at = _now()
                db.commit()

        await store.run(revoke)


# What the web app does with a request on the writer's behalf (see routers/mcp_oauth.py)


def describe_request(db: Session, request_id: uuid.UUID) -> dict | None:
    req = db.get(McpAuthRequest, request_id)
    if not req or req.code_hash or _aware(req.expires_at) < _now():
        return None
    client = db.get(McpClient, req.client_id)
    info = client.info if client else {}
    return {
        "client_name": (info.get("client_name") or "An app").strip()[:80],
        "redirect_host": policy.display_host(req.redirect_uri),
        "trust": policy.check_redirect_uri(req.redirect_uri),
        # Every permission, with what the app asked for pre-ticked. The writer decides; reading is always needed.
        "scopes": [{"scope": s, "label": policy.SCOPE_LABELS[s], "requested": s in req.scopes, "required": s == "mcp:read"}
                   for s in policy.SCOPES],
    }


class BadScopes(ValueError):
    pass


def decide(db: Session, request_id: uuid.UUID, user: User, approve: bool, scopes: list[str] | None = None) -> str | None:
    """Approve or refuse a pending sign-in. Returns where to send the browser, or None when the request is gone.
    scopes is what the writer ticked; without it the app gets what it asked for."""
    req = db.get(McpAuthRequest, request_id)
    if not req or req.code_hash or _aware(req.expires_at) < _now():
        return None
    chosen = [s for s in policy.SCOPES if s in (scopes if scopes is not None else req.scopes)]
    if approve and "mcp:read" not in chosen:
        raise BadScopes("Reading your posts is needed for any app to connect.")
    target, state = req.redirect_uri, req.state
    if not approve:
        db.delete(req)
        db.commit()
        return construct_redirect_uri(target, error="access_denied", state=state)
    code = tokens.random_token()
    req.user_id, req.code_hash, req.expires_at = user.id, tokens.digest(code), _now() + REQUEST_TTL
    req.scopes = chosen
    db.commit()
    return construct_redirect_uri(target, code=code, state=state)

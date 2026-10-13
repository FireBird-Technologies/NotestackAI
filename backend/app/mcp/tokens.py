"""MCP access tokens: short lived JWTs that only the MCP endpoint accepts.

They carry their own type ("mcp_access"), audience (the MCP address) and signing key, so the web app's own tokens do
not work here and these do not work on the web app's API (get_current_user only takes typ "access")."""

import hashlib
import hmac
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt

from app.config import settings

TYPE = "mcp_access"


def signing_key() -> str:
    if settings.mcp_signing_key:
        return settings.mcp_signing_key
    return hmac.new(settings.jwt_secret.encode(), b"notestack-mcp-access-tokens", hashlib.sha256).hexdigest()


def resource() -> str:
    return f"{settings.api_url.rstrip('/')}/mcp"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def random_token() -> str:
    return secrets.token_urlsafe(32)


def mint_access(user_id: uuid.UUID, token_version: int, grant_id: uuid.UUID, client_id: str, scopes: list[str],
                audience: str | None = None) -> tuple[str, int]:
    now = datetime.now(UTC)
    ttl = settings.mcp_access_ttl_seconds
    payload = {"sub": str(user_id), "typ": TYPE, "aud": audience or resource(), "tv": token_version,
               "gid": str(grant_id), "cid": client_id, "scope": " ".join(scopes), "iat": now,
               "exp": now + timedelta(seconds=ttl)}
    return jwt.encode(payload, signing_key(), algorithm="HS256"), ttl


def decode_access(token: str) -> dict | None:
    """The token's claims, or None when it is not a valid, current MCP access token for this server."""
    try:
        payload = jwt.decode(token, signing_key(), algorithms=["HS256"], audience=resource())
    except jwt.PyJWTError:
        return None
    return payload if payload.get("typ") == TYPE else None

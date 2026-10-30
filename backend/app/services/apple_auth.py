"""Sign in with Apple: checks Apple's identity tokens, trades an authorization code for a refresh token, and revokes it
when the account is deleted (App Store guideline 5.1.1(v)).

The identity token is a JWT signed by Apple (RS256, keys published at APPLE_KEYS_URL). Its audience is the iOS app's
bundle id for a native sign in, or the web Services ID for the redirect flow. Talking back to Apple (token, revoke)
needs a client secret: a short ES256 JWT signed with the team's Sign in with Apple key (.p8).
"""

import logging
import time
from dataclasses import dataclass

import httpx
import jwt

from app.config import settings

log = logging.getLogger(__name__)

APPLE_ISSUER = "https://appleid.apple.com"
APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys"
APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token"
APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke"
APPLE_AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize"
# Apple's clock and ours can differ by a little: a token minted a moment "in the future" is still fine.
CLOCK_SKEW_SECONDS = 10

_jwks: jwt.PyJWKClient | None = None


def _keys() -> jwt.PyJWKClient:
    """Apple's signing keys, fetched once and cached (PyJWKClient refetches when a token names an unknown key)."""
    global _jwks
    if _jwks is None:
        _jwks = jwt.PyJWKClient(APPLE_KEYS_URL, cache_keys=True, lifespan=24 * 3600)
    return _jwks


class AppleTokenError(Exception):
    """The identity token is not a valid Apple token for one of our apps."""


@dataclass
class AppleIdentity:
    sub: str  # Apple's stable user id for our team
    email: str | None  # only sent on the first sign in, for most accounts
    email_verified: bool
    is_private_email: bool


def _truthy(value: object) -> bool:
    # Apple writes these booleans as true or as the string "true".
    return value is True or value == "true"


def verify_identity_token(token: str, audiences: list[str], nonce: str | None = None) -> AppleIdentity:
    """The claims of a valid identity token minted for one of `audiences`, else AppleTokenError."""
    if not audiences:
        raise AppleTokenError("Sign in with Apple is not configured")
    try:
        key = _keys().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            key.key,
            algorithms=["RS256"],
            audience=audiences,
            issuer=APPLE_ISSUER,
            leeway=CLOCK_SKEW_SECONDS,
            options={"require": ["exp", "iat", "sub", "aud", "iss"]},
        )
    except (jwt.PyJWTError, jwt.PyJWKClientError) as exc:
        raise AppleTokenError(str(exc)) from exc
    if nonce is not None and claims.get("nonce") != nonce:
        raise AppleTokenError("nonce mismatch")
    return AppleIdentity(
        sub=str(claims["sub"]),
        email=claims.get("email"),
        email_verified=_truthy(claims.get("email_verified")),
        is_private_email=_truthy(claims.get("is_private_email")),
    )


def client_secret(client_id: str) -> str:
    """The client secret Apple asks for when talking back to it: a short ES256 JWT signed with our .p8 key."""
    now = int(time.time())
    key = settings.apple_private_key.replace("\\n", "\n")
    return jwt.encode(
        {"iss": settings.apple_team_id, "iat": now, "exp": now + 300, "aud": APPLE_ISSUER, "sub": client_id},
        key,
        algorithm="ES256",
        headers={"kid": settings.apple_key_id},
    )


def exchange_code(code: str, client_id: str, redirect_uri: str | None = None) -> str | None:
    """Trade an authorization code for Apple's refresh token (kept to revoke on account deletion). None on failure:
    signing in never depends on it."""
    if not settings.apple_configured:
        return None
    data = {"client_id": client_id, "client_secret": client_secret(client_id), "code": code, "grant_type": "authorization_code"}
    if redirect_uri:
        data["redirect_uri"] = redirect_uri
    try:
        res = httpx.post(APPLE_TOKEN_URL, data=data, timeout=10)
        res.raise_for_status()
        return res.json().get("refresh_token")
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("Apple code exchange failed: %s: %s", type(exc).__name__, exc)
        return None


def revoke(refresh_token: str, client_id: str) -> bool:
    """Revoke our access to the person's Apple ID (account deletion). True when Apple accepted it."""
    if not settings.apple_configured:
        return False
    try:
        res = httpx.post(
            APPLE_REVOKE_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret(client_id),
                "token": refresh_token,
                "token_type_hint": "refresh_token",
            },
            timeout=10,
        )
        res.raise_for_status()
        return True
    except httpx.HTTPError as exc:
        log.warning("Apple token revocation failed: %s: %s", type(exc).__name__, exc)
        return False

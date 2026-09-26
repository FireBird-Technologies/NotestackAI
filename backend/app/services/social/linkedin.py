"""LinkedIn member posts (Share on LinkedIn + Sign In with LinkedIn using OpenID Connect products)."""

import re
from urllib.parse import quote, urlencode

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import SocialAccount
from app.services.social import SocialError, expired, token

AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization"
TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
SCOPES = "openid profile w_member_social"
VERSION = "202509"  # LinkedIn-Version header, YYYYMM; LinkedIn supports each version for a year


def redirect_uri() -> str:
    return f"{settings.api_url.rstrip('/')}/api/social/linkedin/callback"


def configured() -> bool:
    return bool(settings.linkedin_client_id and settings.linkedin_client_secret)


def authorize_url(state: str) -> str:
    return AUTH_URL + "?" + urlencode({
        "response_type": "code", "client_id": settings.linkedin_client_id, "redirect_uri": redirect_uri(),
        "state": state, "scope": SCOPES,
    })


def exchange_code(code: str) -> dict:
    resp = httpx.post(TOKEN_URL, data={
        "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(),
        "client_id": settings.linkedin_client_id, "client_secret": settings.linkedin_client_secret,
    }, timeout=20)
    if resp.status_code >= 400:
        raise SocialError(f"LinkedIn token request failed: {resp.text[:300]}", permanent=True)
    tokens = resp.json()
    me = httpx.get("https://api.linkedin.com/v2/userinfo",
                   headers={"Authorization": f"Bearer {tokens['access_token']}"}, timeout=20)
    me.raise_for_status()
    info = me.json()
    return {**tokens, "external_id": info["sub"], "handle": info.get("name") or info["sub"],
            "avatar_url": info.get("picture")}


_RESERVED = re.compile(r"([\\|{}@\[\]()<>#*_~])")


def little_text(text: str) -> str:
    """LinkedIn's commentary field uses 'little text' markup; reserved characters must be escaped."""
    return _RESERVED.sub(r"\\\1", text)


def publish(db: Session, account: SocialAccount, posts: list[str]) -> tuple[str, str]:
    if expired(account):
        account.status = "expired"
        db.commit()
        raise SocialError("The LinkedIn connection expired. Reconnect the account.", permanent=True)
    body = {
        "author": f"urn:li:person:{account.external_id}",
        "commentary": little_text("\n\n".join(posts)),
        "visibility": "PUBLIC",
        "distribution": {"feedDistribution": "MAIN_FEED", "targetEntities": [], "thirdPartyDistributionChannels": []},
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }
    resp = httpx.post("https://api.linkedin.com/rest/posts", json=body, timeout=20, headers={
        "Authorization": f"Bearer {token(account)}", "LinkedIn-Version": VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
    })
    if resp.status_code == 401:
        account.status = "expired"
        db.commit()
        raise SocialError("LinkedIn rejected the token. Reconnect the account.", permanent=True)
    if resp.status_code >= 400:
        raise SocialError(f"LinkedIn {resp.status_code}: {resp.text[:300]}",
                          permanent=resp.status_code in (400, 403, 422))
    urn = resp.headers.get("x-restli-id") or resp.headers.get("x-linkedin-id") or ""
    return urn, f"https://www.linkedin.com/feed/update/{quote(urn)}/" if urn else ""


def metrics(db: Session, account: SocialAccount, external_id: str) -> dict:
    return {}  # member post analytics need the Community Management API, which personal apps rarely have

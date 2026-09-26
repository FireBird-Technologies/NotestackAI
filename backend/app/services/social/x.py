"""X (Twitter) API v2 with OAuth 2.0 user context (PKCE). Threads are reply chains."""

import base64
import hashlib
import secrets
from urllib.parse import urlencode

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import SocialAccount
from app.services.crypto import decrypt
from app.services.social import SocialError, expired, save_tokens, token

AUTH_URL = "https://x.com/i/oauth2/authorize"
TOKEN_URL = "https://api.x.com/2/oauth2/token"
API = "https://api.x.com/2"
SCOPES = "tweet.read tweet.write users.read offline.access"


def redirect_uri() -> str:
    return f"{settings.api_url.rstrip('/')}/api/social/x/callback"


def configured() -> bool:
    return bool(settings.x_client_id and settings.x_client_secret)


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


def authorize_url(state: str, challenge: str) -> str:
    return AUTH_URL + "?" + urlencode({
        "response_type": "code", "client_id": settings.x_client_id, "redirect_uri": redirect_uri(),
        "scope": SCOPES, "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
    })


def _token_request(data: dict) -> dict:
    resp = httpx.post(TOKEN_URL, data={**data, "client_id": settings.x_client_id},
                      auth=(settings.x_client_id, settings.x_client_secret), timeout=20)
    if resp.status_code >= 400:
        raise SocialError(f"X token request failed: {resp.text[:300]}", permanent=resp.status_code in (400, 401))
    return resp.json()


def exchange_code(code: str, verifier: str) -> dict:
    tokens = _token_request({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(),
                             "code_verifier": verifier})
    me = httpx.get(f"{API}/users/me", params={"user.fields": "profile_image_url"},
                   headers={"Authorization": f"Bearer {tokens['access_token']}"}, timeout=20)
    me.raise_for_status()
    user = me.json()["data"]
    return {**tokens, "external_id": user["id"], "handle": user["username"],
            "avatar_url": user.get("profile_image_url")}


def _access(db: Session, account: SocialAccount) -> str:
    if expired(account) and account.refresh_token:
        tokens = _token_request({"grant_type": "refresh_token", "refresh_token": decrypt(account.refresh_token)})
        save_tokens(db, account, tokens["access_token"], tokens.get("refresh_token"), tokens.get("expires_in"))
    return token(account)


def publish(db: Session, account: SocialAccount, posts: list[str]) -> tuple[str, str]:
    headers = {"Authorization": f"Bearer {_access(db, account)}"}
    first_id, reply_to = None, None
    for text in posts:
        body: dict = {"text": text}
        if reply_to:
            body["reply"] = {"in_reply_to_tweet_id": reply_to}
        resp = httpx.post(f"{API}/tweets", json=body, headers=headers, timeout=20)
        if resp.status_code == 401:
            account.status = "expired"
            db.commit()
            raise SocialError("X rejected the token. Reconnect the account.", permanent=True)
        if resp.status_code >= 400:
            raise SocialError(f"X {resp.status_code}: {resp.text[:300]}", permanent=resp.status_code in (400, 403))
        reply_to = resp.json()["data"]["id"]
        first_id = first_id or reply_to
    return first_id, f"https://x.com/{account.handle}/status/{first_id}"


def metrics(db: Session, account: SocialAccount, external_id: str) -> dict:
    resp = httpx.get(f"{API}/tweets", params={"ids": external_id, "tweet.fields": "public_metrics"},
                     headers={"Authorization": f"Bearer {_access(db, account)}"}, timeout=20)
    if resp.status_code >= 400:
        return {}
    data = (resp.json().get("data") or [{}])[0].get("public_metrics") or {}
    return {"likes": data.get("like_count", 0), "reposts": data.get("retweet_count", 0),
            "replies": data.get("reply_count", 0), "impressions": data.get("impression_count", 0)}

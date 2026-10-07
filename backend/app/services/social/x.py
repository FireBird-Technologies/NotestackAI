"""X (Twitter) API v2 with OAuth 2.0 user context (PKCE). Threads are reply chains; images and a video go on the
first post (v2 media upload: one call for an image, initialize / append / finalize / status for a video)."""

import base64
import hashlib
import secrets
import time
from urllib.parse import urlencode

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import SocialAccount
from app.services.crypto import decrypt
from app.services.social import SocialError, expired, save_tokens, scope_set, token

AUTH_URL = "https://x.com/i/oauth2/authorize"
TOKEN_URL = "https://api.x.com/2/oauth2/token"
API = "https://api.x.com/2"
SCOPES = "tweet.read tweet.write users.read offline.access media.write"
CHUNK = 4 * 1024 * 1024  # video upload segments
PROCESSING_WAIT = 600  # seconds X may take to process a video before we give up


def redirect_uri() -> str:
    return f"{settings.api_url.rstrip('/')}/api/social/x/callback"


def configured() -> bool:
    return bool(settings.x_enabled and settings.x_client_id and settings.x_client_secret)


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


def refresh(db: Session, account: SocialAccount) -> None:
    """Swap the refresh token for new tokens (X rotates the refresh token too). A refused refresh means the
    connection is gone: reconnect."""
    if not account.refresh_token:
        raise SocialError("The X connection expired. Reconnect X.", reconnect=True)
    try:
        tokens = _token_request({"grant_type": "refresh_token", "refresh_token": decrypt(account.refresh_token)})
    except SocialError as exc:
        if exc.permanent:
            raise SocialError("The X connection expired. Reconnect X.", reconnect=True) from exc
        raise
    save_tokens(db, account, tokens["access_token"], tokens.get("refresh_token"), tokens.get("expires_in"))


def _access(db: Session, account: SocialAccount) -> str:
    if expired(account):
        refresh(db, account)
    return token(account)


def check_alive(db: Session, account: SocialAccount) -> None:
    """One cheap call: raises SocialError(reconnect=True) when X no longer accepts this connection."""
    resp = _call("GET", f"{API}/users/me", headers={"Authorization": f"Bearer {_access(db, account)}"}, timeout=20)
    if resp.status_code == 401:
        raise SocialError("X no longer accepts this connection. Reconnect X.", reconnect=True)


def _call(method: str, url: str, **kw) -> httpx.Response:
    """Every request to X goes through here (tests replace it)."""
    return httpx.request(method, url, timeout=kw.pop("timeout", 60), **kw)


def can_post_media(account: SocialAccount) -> bool:
    """Accounts connected before media.write was asked for have to reconnect to post images or videos."""
    return "media.write" in scope_set(account.scopes)


def _media_error(resp: httpx.Response) -> SocialError:
    if resp.status_code in (401, 403):
        return SocialError("X refused the upload. Reconnect X to post images and videos.", reconnect=True)
    return SocialError(f"X media upload {resp.status_code}: {resp.text[:300]}",
                       permanent=400 <= resp.status_code < 500 and resp.status_code != 429)


def _upload_image(headers: dict, m) -> str:
    resp = _call("POST", f"{API}/media/upload", headers=headers, data={"media_category": "tweet_image"},
                 files={"media": (m.filename, m.read(), m.content_type)})
    if resp.status_code >= 400:
        raise _media_error(resp)
    return resp.json()["data"]["id"]


def _upload_video(headers: dict, m) -> str:
    resp = _call("POST", f"{API}/media/upload/initialize", headers=headers,
                 json={"media_type": m.content_type, "total_bytes": m.size, "media_category": "tweet_video"})
    if resp.status_code >= 400:
        raise _media_error(resp)
    media_id = resp.json()["data"]["id"]
    for i, start in enumerate(range(0, m.size, CHUNK)):
        resp = _call("POST", f"{API}/media/upload/{media_id}/append", headers=headers, data={"segment_index": i},
                     files={"media": (m.filename, m.read(start, start + CHUNK), "application/octet-stream")})
        if resp.status_code >= 400:
            raise _media_error(resp)
    resp = _call("POST", f"{API}/media/upload/{media_id}/finalize", headers=headers)
    if resp.status_code >= 400:
        raise _media_error(resp)
    info = (resp.json().get("data") or {}).get("processing_info")
    waited = 0
    while info and info.get("state") in ("pending", "in_progress"):
        if waited >= PROCESSING_WAIT:
            raise SocialError("X took too long to process the video.")
        pause = int(info.get("check_after_secs") or 5)
        time.sleep(pause)
        waited += pause
        resp = _call("GET", f"{API}/media/upload", headers=headers,
                     params={"command": "STATUS", "media_id": media_id})
        if resp.status_code >= 400:
            raise _media_error(resp)
        info = (resp.json().get("data") or {}).get("processing_info")
    if info and info.get("state") == "failed":
        reason = (info.get("error") or {}).get("message") or "X could not process the video"
        raise SocialError(f"{reason}. X takes videos up to 2:20.", permanent=True)
    return media_id


def publish(db: Session, account: SocialAccount, posts: list[str], media: list | None = None) -> tuple[str, str]:
    headers = {"Authorization": f"Bearer {_access(db, account)}"}
    media_ids: list[str] = []
    if media:
        if not can_post_media(account):
            raise SocialError("Reconnect X to post images and videos.", permanent=True)
        media_ids = [(_upload_video if m.kind == "video" else _upload_image)(headers, m) for m in media]
    first_id, reply_to = None, None
    for text in posts:
        body: dict = {"text": text}
        if reply_to:
            body["reply"] = {"in_reply_to_tweet_id": reply_to}
        elif media_ids:
            body["media"] = {"media_ids": media_ids}  # the images or video go on the first post
        resp = _call("POST", f"{API}/tweets", json=body, headers=headers, timeout=20)
        if resp.status_code == 401:
            raise SocialError("X rejected the connection. Reconnect X.", reconnect=True)
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

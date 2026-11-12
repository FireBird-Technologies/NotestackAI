"""Direct Threads OAuth and publishing through Meta's Threads API."""

import time
import uuid
from urllib.parse import urlencode

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import SocialAccount
from app.services.crypto import decrypt
from app.services.social import SocialError, expired, save_tokens, token
from app.services.storage import safe_filename, storage

AUTH_URL = "https://www.threads.com/oauth/authorize"
GRAPH = "https://graph.threads.com"
SCOPES = "threads_basic,threads_content_publish"
PROCESSING_WAIT = 180
MEDIA_URL_TTL = 3600


def configured() -> bool:
    return bool(settings.threads_enabled and settings.threads_client_id and settings.threads_client_secret)


def redirect_uri() -> str:
    return f"{settings.api_url.rstrip('/')}/api/social/threads/callback"


def authorize_url(state: str) -> str:
    return AUTH_URL + "?" + urlencode({
        "response_type": "code",
        "client_id": settings.threads_client_id,
        "redirect_uri": redirect_uri(),
        "scope": SCOPES,
        "state": state,
    })


def _call(method: str, url: str, **kwargs) -> httpx.Response:
    """Every Threads request goes through one test seam."""
    return httpx.request(method, url, timeout=kwargs.pop("timeout", 30), **kwargs)


def _payload(response: httpx.Response, action: str) -> dict:
    if response.status_code < 400:
        return response.json()
    try:
        detail = response.json().get("error") or {}
        message = detail.get("message") or response.text[:300]
        code = detail.get("code")
    except ValueError:
        message, code = response.text[:300], None
    if response.status_code == 401 or code == 190:
        raise SocialError("Threads no longer accepts this connection. Reconnect Threads.", reconnect=True)
    raise SocialError(f"Threads {action} failed: {message}",
                      permanent=400 <= response.status_code < 500 and response.status_code != 429)


def exchange_code(code: str) -> dict:
    short = _payload(_call("POST", f"{GRAPH}/oauth/access_token", data={
        "client_id": settings.threads_client_id,
        "client_secret": settings.threads_client_secret,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri(),
        "code": code,
    }, timeout=20), "authorization")
    access = short["access_token"]
    extended = _payload(_call("GET", f"{GRAPH}/access_token", params={
        "grant_type": "th_exchange_token",
        "client_secret": settings.threads_client_secret,
        "access_token": access,
    }, timeout=20), "long-lived token exchange")
    access = extended.get("access_token") or access
    profile = _payload(_call("GET", f"{GRAPH}/me", params={
        "fields": "id,username,threads_profile_picture_url",
        "access_token": access,
    }, timeout=20), "profile lookup")
    return {
        "access_token": access,
        # Meta refreshes a Threads long-lived access token using that token itself.
        "refresh_token": access,
        "expires_in": extended.get("expires_in") or short.get("expires_in") or 5_184_000,
        "scope": SCOPES,
        "external_id": profile["id"],
        "handle": profile.get("username") or "Threads",
        "avatar_url": profile.get("threads_profile_picture_url"),
    }


def refresh(db: Session, account: SocialAccount) -> None:
    current = decrypt(account.refresh_token) or token(account)
    response = _payload(_call("GET", f"{GRAPH}/refresh_access_token", params={
        "grant_type": "th_refresh_token",
        "access_token": current,
    }, timeout=20), "token refresh")
    access = response.get("access_token") or current
    save_tokens(db, account, access, access, response.get("expires_in") or 5_184_000)


def _access(db: Session, account: SocialAccount) -> str:
    if expired(account):
        refresh(db, account)
    return token(account)


def check_alive(db: Session, account: SocialAccount) -> None:
    _payload(_call("GET", f"{GRAPH}/me", params={
        "fields": "id", "access_token": _access(db, account),
    }, timeout=20), "connection check")


def _media_url(key: str) -> str | None:
    """Meta can fetch either a stable public URL or a short-lived signed URL created at publish time."""
    if url := storage.public_url(key):
        return url
    try:
        url = storage.presign_get(key, ttl=MEDIA_URL_TTL)
    except Exception:
        return None
    return url if url.startswith("https://") else None


def can_post_media(account: SocialAccount) -> bool:
    return bool(_media_url("threads-media-check"))


def _public_media(account: SocialAccount, media: list) -> list[tuple[str, str]]:
    if not media:
        return []
    if not can_post_media(account):
        raise SocialError("Configure HTTPS-accessible storage before posting images or videos directly to Threads.",
                          permanent=True)
    out = []
    for item in media[:10]:
        if item.kind not in ("image", "video"):
            continue
        key = f"ws/{account.workspace_id}/social/threads/{uuid.uuid4()}/{safe_filename(item.filename)}"
        storage.put_bytes(key, item.read(), item.content_type)
        out.append((item.kind, _media_url(key)))
    return [(kind, url) for kind, url in out if url]


def _create(access: str, text: str, reply_to: str | None, media: list[tuple[str, str]]) -> tuple[str, bool]:
    common = {"access_token": access}
    if text:
        common["text"] = text
    if reply_to:
        common["reply_to_id"] = reply_to
    if not media:
        params = {**common, "media_type": "TEXT"}
    elif len(media) == 1:
        kind, url = media[0]
        params = {**common, "media_type": kind.upper(), f"{kind}_url": url}
    else:
        children = []
        for kind, url in media:
            child = _payload(_call("POST", f"{GRAPH}/me/threads", params={
                "access_token": access,
                "media_type": kind.upper(),
                f"{kind}_url": url,
                "is_carousel_item": "true",
            }), "carousel item creation")
            children.append(child["id"])
        params = {**common, "media_type": "CAROUSEL", "children": ",".join(children)}
    created = _payload(_call("POST", f"{GRAPH}/me/threads", params=params), "container creation")
    return created["id"], bool(media)


def _wait(access: str, container_id: str) -> None:
    waited = 0
    while waited < PROCESSING_WAIT:
        data = _payload(_call("GET", f"{GRAPH}/{container_id}", params={
            "fields": "status,error_message", "access_token": access,
        }), "container status")
        status = str(data.get("status") or "").upper()
        if status in ("FINISHED", "PUBLISHED"):
            return
        if status in ("ERROR", "EXPIRED"):
            raise SocialError(data.get("error_message") or "Threads could not process the media.", permanent=True)
        time.sleep(2)
        waited += 2
    raise SocialError("Threads took too long to process the media.")


def publish(db: Session, account: SocialAccount, posts: list[str], media: list | None = None) -> tuple[str, str]:
    access = _access(db, account)
    public_media = _public_media(account, media or [])
    first_id = reply_to = None
    for index, text in enumerate(posts):
        container, needs_wait = _create(access, text, reply_to, public_media if index == 0 else [])
        if needs_wait:
            _wait(access, container)
        published = _payload(_call("POST", f"{GRAPH}/me/threads_publish", params={
            "creation_id": container, "access_token": access,
        }), "publishing")
        reply_to = published["id"]
        first_id = first_id or reply_to
    details = _payload(_call("GET", f"{GRAPH}/{first_id}", params={
        "fields": "permalink", "access_token": access,
    }), "permalink lookup")
    return first_id, details.get("permalink") or f"https://www.threads.net/@{account.handle}"


def metrics(db: Session, account: SocialAccount, external_id: str) -> dict:
    # Post insights need another permission; direct publishing intentionally requests only the minimum scopes.
    return {}

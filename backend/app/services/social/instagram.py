"""Direct Instagram Unified Login and content publishing through Meta's Graph API."""

import time
import uuid
from urllib.parse import urlencode

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import SocialAccount
from app.services.social import SocialError, token
from app.services.storage import safe_filename, storage

AUTH_URL = "https://www.facebook.com"
SCOPES = "instagram_basic,instagram_content_publish"
PROCESSING_WAIT = 300
MEDIA_URL_TTL = 3600


def graph() -> str:
    return f"https://graph.facebook.com/{settings.instagram_graph_version.strip('/') or 'v26.0'}"


def configured() -> bool:
    values = (settings.instagram_client_id, settings.instagram_client_secret, settings.instagram_config_id)
    return bool(settings.instagram_enabled and all(value and not value.strip().startswith("<") for value in values))


def redirect_uri() -> str:
    return f"{settings.api_url.rstrip('/')}/api/social/instagram/callback"


def authorize_url(state: str) -> str:
    """Unified Login uses the dashboard configuration instead of a caller-supplied scope list."""
    version = settings.instagram_graph_version.strip("/") or "v26.0"
    return f"{AUTH_URL}/{version}/dialog/oauth?" + urlencode({
        "client_id": settings.instagram_client_id,
        "redirect_uri": redirect_uri(),
        "state": state,
        "response_type": "code",
        "config_id": settings.instagram_config_id,
        "override_default_response_type": "true",
    })


def _call(method: str, url: str, **kwargs) -> httpx.Response:
    """Every Meta request goes through one seam so tests never contact the real API."""
    return httpx.request(method, url, timeout=kwargs.pop("timeout", 30), **kwargs)


def _payload(response: httpx.Response, action: str) -> dict:
    if response.status_code < 400:
        try:
            return response.json()
        except ValueError as exc:
            raise SocialError(f"Instagram {action} returned an invalid response.") from exc
    try:
        detail = response.json().get("error") or {}
        message = detail.get("message") or response.text[:300]
        code = detail.get("code")
    except ValueError:
        message, code = response.text[:300], None
    if response.status_code == 401 or code in (102, 190):
        raise SocialError("Instagram no longer accepts this connection. Reconnect Instagram.", reconnect=True)
    raise SocialError(f"Instagram {action} failed: {message}",
                      permanent=400 <= response.status_code < 500 and response.status_code != 429)


def _assigned_accounts(access: str) -> list[dict]:
    fields = "id,username,profile_picture_url"
    accounts: list[dict] = []
    after: str | None = None
    seen: set[str] = set()
    for _ in range(100):
        params = {"fields": fields, "limit": 100, "access_token": access}
        if after:
            params["after"] = after
        response = _call("GET", f"{graph()}/me/assigned_instagram_accounts", params=params, timeout=20)
        if response.status_code >= 400:
            break
        page = _payload(response, "account discovery")
        accounts.extend(page.get("data") or [])
        next_after = ((page.get("paging") or {}).get("cursors") or {}).get("after")
        if not next_after or next_after == after or next_after in seen:
            return accounts
        seen.add(next_after)
        after = next_after
    if accounts:
        return accounts
    # Some Meta configurations expose the same assigned edge through field expansion instead of the edge URL.
    fallback = _call("GET", f"{graph()}/me", params={
        "fields": f"assigned_instagram_accounts{{{fields}}}", "access_token": access,
    }, timeout=20)
    data = _payload(fallback, "account discovery").get("assigned_instagram_accounts") or {}
    return data.get("data") or []


def _authorization_user_id(access: str) -> str:
    profile = _payload(_call("GET", f"{graph()}/me", params={
        "fields": "id", "access_token": access,
    }, timeout=20), "authorization identity lookup")
    if not profile.get("id"):
        raise SocialError("Meta did not return the Instagram authorization identity. Try connecting again.",
                          permanent=True)
    return str(profile["id"])


def exchange_code(code: str) -> dict:
    tokens = _payload(_call("GET", f"{graph()}/oauth/access_token", params={
        "client_id": settings.instagram_client_id,
        "client_secret": settings.instagram_client_secret,
        "redirect_uri": redirect_uri(),
        "code": code,
    }, timeout=20), "authorization")
    access = tokens.get("access_token")
    if not access:
        raise SocialError("Instagram authorization returned no access token.", permanent=True)
    authorization_user_id = _authorization_user_id(access)
    accounts = _assigned_accounts(access)
    if not accounts:
        raise SocialError("Instagram authorized successfully, but Meta returned no assigned Instagram account. "
                          "Share a professional Instagram account with the Unified Login configuration and try again.",
                          permanent=True)
    if len(accounts) > 1:
        raise SocialError("Select one Instagram account in Meta's authorization window and try again.", permanent=True)
    profile = accounts[0]
    if not profile.get("id"):
        raise SocialError("Meta returned an Instagram account without an ID. Try connecting again.", permanent=True)
    return {
        "access_token": access,
        "expires_in": tokens.get("expires_in"),
        "scope": SCOPES,
        "authorization_user_id": authorization_user_id,
        "external_id": str(profile["id"]),
        "handle": profile.get("username") or "Instagram",
        "avatar_url": profile.get("profile_picture_url"),
    }


def check_alive(db: Session, account: SocialAccount) -> None:
    _payload(_call("GET", f"{graph()}/{account.external_id}", params={
        "fields": "id,username", "access_token": token(account),
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
    return bool(_media_url("instagram-media-check"))


def _public_media(account: SocialAccount, media: list) -> list[tuple[str, str]]:
    if not media:
        return []
    if not can_post_media(account):
        raise SocialError("Configure HTTPS-accessible storage before posting images or videos directly to Instagram.",
                          permanent=True)
    out: list[tuple[str, str]] = []
    for item in media[:10]:
        if item.kind not in ("image", "video"):
            continue
        key = f"ws/{account.workspace_id}/social/instagram/{uuid.uuid4()}/{safe_filename(item.filename)}"
        storage.put_bytes(key, item.read(), item.content_type)
        if url := _media_url(key):
            out.append((item.kind, url))
    return out


def _wait(access: str, container_id: str) -> None:
    waited = 0
    while waited < PROCESSING_WAIT:
        data = _payload(_call("GET", f"{graph()}/{container_id}", params={
            "fields": "status_code,status", "access_token": access,
        }), "container status")
        status = str(data.get("status_code") or "").upper()
        if status in ("FINISHED", "PUBLISHED"):
            return
        if status in ("ERROR", "EXPIRED"):
            raise SocialError(data.get("status") or "Instagram could not process the media.", permanent=True)
        time.sleep(2)
        waited += 2
    raise SocialError("Instagram took too long to process the media.")


def _create(access: str, ig_id: str, caption: str, media: list[tuple[str, str]]) -> str:
    if not media:
        raise SocialError("Instagram needs an image or video.", permanent=True)
    if len(media) == 1:
        kind, url = media[0]
        params = {"access_token": access, "caption": caption}
        if kind == "video":
            params.update({"media_type": "REELS", "video_url": url, "share_to_feed": "true"})
        else:
            params["image_url"] = url
        return _payload(_call("POST", f"{graph()}/{ig_id}/media", params=params), "container creation")["id"]

    children = []
    for kind, url in media:
        params = {"access_token": access, "is_carousel_item": "true", f"{kind}_url": url}
        if kind == "video":
            params["media_type"] = "VIDEO"
        child = _payload(_call("POST", f"{graph()}/{ig_id}/media", params=params), "carousel item creation")["id"]
        _wait(access, child)
        children.append(child)
    return _payload(_call("POST", f"{graph()}/{ig_id}/media", params={
        "access_token": access, "media_type": "CAROUSEL", "children": ",".join(children), "caption": caption,
    }), "carousel creation")["id"]


def publish(db: Session, account: SocialAccount, posts: list[str], media: list | None = None) -> tuple[str, str]:
    access = token(account)
    public_media = _public_media(account, media or [])
    container = _create(access, account.external_id, "\n\n".join(p for p in posts if p), public_media)
    _wait(access, container)
    published = _payload(_call("POST", f"{graph()}/{account.external_id}/media_publish", params={
        "creation_id": container, "access_token": access,
    }), "publishing")
    media_id = published["id"]
    details = _payload(_call("GET", f"{graph()}/{media_id}", params={
        "fields": "permalink", "access_token": access,
    }), "permalink lookup")
    return media_id, details.get("permalink") or f"https://www.instagram.com/{account.handle}/"


def metrics(db: Session, account: SocialAccount, external_id: str) -> dict:
    return {}

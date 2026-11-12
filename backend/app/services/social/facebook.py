"""Facebook Login for Business and direct publishing to a selected Facebook Page."""

import json
import uuid
from urllib.parse import urlencode

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import SocialAccount
from app.services.social import SocialError, token
from app.services.storage import safe_filename, storage

AUTH_URL = "https://www.facebook.com"
SCOPES = "pages_show_list,pages_read_engagement,pages_manage_posts"
MEDIA_URL_TTL = 3600


def graph() -> str:
    return f"https://graph.facebook.com/{settings.facebook_graph_version.strip('/') or 'v26.0'}"


def configured() -> bool:
    values = (settings.facebook_client_id, settings.facebook_client_secret, settings.facebook_config_id)
    return bool(settings.facebook_enabled and all(value and not value.strip().startswith("<") for value in values))


def redirect_uri() -> str:
    return f"{settings.api_url.rstrip('/')}/api/social/facebook/callback"


def authorize_url(state: str) -> str:
    """The dashboard configuration owns the Page assets and scopes shown in Meta's consent screen."""
    version = settings.facebook_graph_version.strip("/") or "v26.0"
    return f"{AUTH_URL}/{version}/dialog/oauth?" + urlencode({
        "client_id": settings.facebook_client_id,
        "redirect_uri": redirect_uri(),
        "state": state,
        "response_type": "code",
        "config_id": settings.facebook_config_id,
        "override_default_response_type": "true",
    })


def _call(method: str, url: str, **kwargs) -> httpx.Response:
    """Every Meta request passes through one seam so tests never contact Facebook."""
    return httpx.request(method, url, timeout=kwargs.pop("timeout", 30), **kwargs)


def _payload(response: httpx.Response, action: str) -> dict:
    if response.status_code < 400:
        try:
            return response.json()
        except ValueError as exc:
            raise SocialError(f"Facebook {action} returned an invalid response.") from exc
    try:
        detail = response.json().get("error") or {}
        message = detail.get("message") or response.text[:300]
        code = detail.get("code")
    except ValueError:
        message, code = response.text[:300], None
    if response.status_code == 401 or code in (102, 190):
        raise SocialError("Facebook no longer accepts this connection. Reconnect Facebook.", reconnect=True)
    raise SocialError(f"Facebook {action} failed: {message}",
                      permanent=400 <= response.status_code < 500 and response.status_code != 429)


def _pages(access: str) -> list[dict]:
    fields = "id,name,access_token,picture{url},tasks"
    pages: list[dict] = []
    after: str | None = None
    seen: set[str] = set()
    for _ in range(100):
        params = {"fields": fields, "limit": 100, "access_token": access}
        if after:
            params["after"] = after
        page = _payload(_call("GET", f"{graph()}/me/accounts", params=params, timeout=20), "Page discovery")
        pages.extend(page.get("data") or [])
        next_after = ((page.get("paging") or {}).get("cursors") or {}).get("after")
        if not next_after or next_after == after or next_after in seen:
            break
        seen.add(next_after)
        after = next_after
    return pages


def _authorization_user_id(access: str) -> str:
    profile = _payload(_call("GET", f"{graph()}/me", params={
        "fields": "id", "access_token": access,
    }, timeout=20), "authorization identity lookup")
    if not profile.get("id"):
        raise SocialError("Meta did not return the Facebook authorization identity. Try connecting again.",
                          permanent=True)
    return str(profile["id"])


def exchange_code(code: str) -> dict:
    tokens = _payload(_call("GET", f"{graph()}/oauth/access_token", params={
        "client_id": settings.facebook_client_id,
        "client_secret": settings.facebook_client_secret,
        "redirect_uri": redirect_uri(),
        "code": code,
    }, timeout=20), "authorization")
    user_access = tokens.get("access_token")
    if not user_access:
        raise SocialError("Facebook authorization returned no access token.", permanent=True)
    authorization_user_id = _authorization_user_id(user_access)
    pages = _pages(user_access)
    if not pages:
        raise SocialError("Facebook authorized successfully, but Meta returned no Page. Select a Page that the "
                          "connecting account can manage and try again.", permanent=True)
    if len(pages) > 1:
        raise SocialError("Select exactly one Facebook Page in Meta's authorization window and try again.",
                          permanent=True)
    page = pages[0]
    page_access = page.get("access_token")
    if not page.get("id") or not page_access:
        raise SocialError("Meta did not return a Page access token. Check the Page asset and permissions in your "
                          "Facebook Login for Business configuration.", permanent=True)
    picture = ((page.get("picture") or {}).get("data") or {}).get("url")
    return {
        "access_token": page_access,
        "expires_in": tokens.get("expires_in"),
        "scope": SCOPES,
        "authorization_user_id": authorization_user_id,
        "external_id": str(page["id"]),
        "handle": page.get("name") or "Facebook Page",
        "avatar_url": picture,
    }


def check_alive(db: Session, account: SocialAccount) -> None:
    _payload(_call("GET", f"{graph()}/{account.external_id}", params={
        "fields": "id,name", "access_token": token(account),
    }, timeout=20), "connection check")


def _media_url(key: str) -> str | None:
    if url := storage.public_url(key):
        return url
    try:
        url = storage.presign_get(key, ttl=MEDIA_URL_TTL)
    except Exception:
        return None
    return url if url.startswith("https://") else None


def can_post_media(account: SocialAccount) -> bool:
    return bool(_media_url("facebook-media-check"))


def _public_media(account: SocialAccount, media: list) -> list[tuple[str, str]]:
    if not media:
        return []
    if not can_post_media(account):
        raise SocialError("Configure HTTPS-accessible storage before posting images or videos directly to Facebook.",
                          permanent=True)
    out: list[tuple[str, str]] = []
    for item in media[:10]:
        if item.kind not in ("image", "video"):
            continue
        key = f"ws/{account.workspace_id}/social/facebook/{uuid.uuid4()}/{safe_filename(item.filename)}"
        storage.put_bytes(key, item.read(), item.content_type)
        if url := _media_url(key):
            out.append((item.kind, url))
    return out


def _permalink(access: str, object_id: str, page_id: str) -> str:
    response = _call("GET", f"{graph()}/{object_id}", params={
        "fields": "permalink_url", "access_token": access,
    }, timeout=20)
    if response.status_code < 400:
        return (response.json() or {}).get("permalink_url") or f"https://www.facebook.com/{page_id}"
    return f"https://www.facebook.com/{page_id}"


def publish(db: Session, account: SocialAccount, posts: list[str], media: list | None = None) -> tuple[str, str]:
    access = token(account)
    message = "\n\n".join(post for post in posts if post)
    public_media = _public_media(account, media or [])
    videos = [url for kind, url in public_media if kind == "video"]
    images = [url for kind, url in public_media if kind == "image"]
    if videos and images:
        raise SocialError("Facebook posts cannot mix a video with images. Attach one video or only images.",
                          permanent=True)
    if videos:
        if len(videos) > 1:
            raise SocialError("Facebook accepts one video per post.", permanent=True)
        result = _payload(_call("POST", f"{graph()}/{account.external_id}/videos", params={
            "file_url": videos[0], "description": message, "access_token": access,
        }), "video publishing")
        object_id = result["id"]
    elif len(images) == 1:
        result = _payload(_call("POST", f"{graph()}/{account.external_id}/photos", params={
            "url": images[0], "caption": message, "access_token": access,
        }), "photo publishing")
        object_id = result.get("post_id") or result["id"]
    elif images:
        photo_ids = []
        for url in images:
            uploaded = _payload(_call("POST", f"{graph()}/{account.external_id}/photos", params={
                "url": url, "published": "false", "access_token": access,
            }), "photo upload")
            photo_ids.append(uploaded["id"])
        result = _payload(_call("POST", f"{graph()}/{account.external_id}/feed", params={
            "message": message,
            "attached_media": json.dumps([{"media_fbid": photo_id} for photo_id in photo_ids]),
            "access_token": access,
        }), "post publishing")
        object_id = result["id"]
    else:
        result = _payload(_call("POST", f"{graph()}/{account.external_id}/feed", params={
            "message": message, "access_token": access,
        }), "post publishing")
        object_id = result["id"]
    return object_id, _permalink(access, object_id, account.external_id)


def metrics(db: Session, account: SocialAccount, external_id: str) -> dict:
    return {}

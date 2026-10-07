"""LinkedIn member posts (Share on LinkedIn + Sign In with LinkedIn using OpenID Connect products), with an image,
several images (multiImage) or a video uploaded first through the Images / Videos APIs."""

import re
import time
from urllib.parse import quote, urlencode

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import SocialAccount
from app.services.crypto import decrypt
from app.services.social import SocialError, expired, save_tokens, scope_set, token

AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization"
TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
SCOPES = "openid profile w_member_social"
VERSION = "202609"  # LinkedIn-Version header, YYYYMM; LinkedIn supports each version for a year
REST = "https://api.linkedin.com/rest"
PROCESSING_WAIT = 600  # seconds LinkedIn may take to process a video before we give up
PART_ATTEMPTS = 4  # a video part upload is tried this often (network errors, 5xx) before the post fails


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


def _call(method: str, url: str, **kw) -> httpx.Response:
    """Every request to LinkedIn goes through here (tests replace it)."""
    return httpx.request(method, url, timeout=kw.pop("timeout", 60), **kw)


def _headers(account: SocialAccount) -> dict:
    return {"Authorization": f"Bearer {token(account)}", "LinkedIn-Version": VERSION,
            "X-Restli-Protocol-Version": "2.0.0"}


def can_post_media(account: SocialAccount) -> bool:
    return "w_member_social" in scope_set(account.scopes)


def refresh(db: Session, account: SocialAccount) -> None:
    """Programmatic refresh, for apps LinkedIn gives refresh tokens to; without one the connection simply expires."""
    if not account.refresh_token:
        raise SocialError("The LinkedIn connection expired. Reconnect LinkedIn.", reconnect=True)
    resp = _call("POST", TOKEN_URL, data={
        "grant_type": "refresh_token", "refresh_token": decrypt(account.refresh_token),
        "client_id": settings.linkedin_client_id, "client_secret": settings.linkedin_client_secret}, timeout=20)
    if resp.status_code in (400, 401):
        raise SocialError("The LinkedIn connection expired. Reconnect LinkedIn.", reconnect=True)
    tokens = _check(resp, "token refresh")
    save_tokens(db, account, tokens["access_token"], tokens.get("refresh_token"), tokens.get("expires_in"))


def check_alive(db: Session, account: SocialAccount) -> None:
    """One cheap call: raises SocialError(reconnect=True) when LinkedIn no longer accepts this connection."""
    resp = _call("GET", "https://api.linkedin.com/v2/userinfo", headers={"Authorization": f"Bearer {token(account)}"},
                 timeout=20)
    if resp.status_code == 401:
        raise SocialError("LinkedIn no longer accepts this connection. Reconnect LinkedIn.", reconnect=True)


def _check(resp: httpx.Response, what: str) -> dict:
    if resp.status_code == 426 or "NONEXISTENT_VERSION" in resp.text:
        raise SocialError(f"LinkedIn retired API version {VERSION}; Notestack needs an update to post.", permanent=True)
    if resp.status_code == 401:
        raise SocialError("LinkedIn rejected the connection. Reconnect LinkedIn.", reconnect=True)
    if resp.status_code >= 400:
        raise SocialError(f"LinkedIn {what} {resp.status_code}: {resp.text[:300]}",
                          permanent=400 <= resp.status_code < 500 and resp.status_code != 429)
    return resp.json() if resp.content else {}


def _upload_image(account: SocialAccount, m) -> str:
    owner = f"urn:li:person:{account.external_id}"
    got = _check(_call("POST", f"{REST}/images", params={"action": "initializeUpload"}, headers=_headers(account),
                       json={"initializeUploadRequest": {"owner": owner}}), "image upload")["value"]
    _check(_call("PUT", got["uploadUrl"], content=m.read(),
                 headers={"Authorization": _headers(account)["Authorization"], "Content-Type": m.content_type}),
           "image upload")
    return got["image"]


def _upload_video(account: SocialAccount, m) -> str:
    owner = f"urn:li:person:{account.external_id}"
    got = _check(_call("POST", f"{REST}/videos", params={"action": "initializeUpload"}, headers=_headers(account),
                       json={"initializeUploadRequest": {"owner": owner, "fileSizeBytes": m.size,
                                                         "uploadCaptions": False, "uploadThumbnail": False}}),
                 "video upload")["value"]
    etags = [_put_part(part, m) for part in got["uploadInstructions"]]
    _check(_call("POST", f"{REST}/videos", params={"action": "finalizeUpload"}, headers=_headers(account),
                 json={"finalizeUploadRequest": {"video": got["video"], "uploadToken": got.get("uploadToken", ""),
                                                 "uploadedPartIds": etags}}), "video upload")
    waited = 0
    while True:  # usable in a post only once LinkedIn has processed it
        state = _check(_call("GET", f"{REST}/videos/{quote(got['video'])}", headers=_headers(account)),
                       "video status").get("status")
        if state == "AVAILABLE":
            return got["video"]
        if state == "PROCESSING_FAILED":
            raise SocialError("LinkedIn could not process the video.", permanent=True)
        if waited >= PROCESSING_WAIT:
            raise SocialError("LinkedIn took too long to process the video.")
        time.sleep(5)
        waited += 5


def _put_part(part: dict, m) -> str:
    """One part of a video, read from the file. Sent to LinkedIn's upload URL with no bearer token; network errors
    and 5xx are retried with backoff. Returns the part's ETag."""
    data = m.read(part["firstByte"], part["lastByte"] + 1)
    for attempt in range(1, PART_ATTEMPTS + 1):
        try:
            resp = _call("PUT", part["uploadUrl"], content=data, headers={"Content-Type": "application/octet-stream"},
                         timeout=300)
        except httpx.HTTPError as exc:
            if attempt == PART_ATTEMPTS:
                raise SocialError(f"LinkedIn video upload failed: {exc}") from exc
        else:
            if resp.status_code in (401, 403):
                raise SocialError("LinkedIn's upload session expired; trying again later.")
            if resp.status_code < 400:
                return resp.headers.get("etag", "").strip('"')
            if resp.status_code < 500 or attempt == PART_ATTEMPTS:
                raise SocialError(f"LinkedIn video upload {resp.status_code}: {resp.text[:200]}",
                                  permanent=resp.status_code < 500)
        time.sleep(2 ** attempt)
    raise SocialError("LinkedIn video upload failed.")  # not reached


def publish(db: Session, account: SocialAccount, posts: list[str], media: list | None = None) -> tuple[str, str]:
    if expired(account):
        refresh(db, account)  # without a refresh token: reconnect
    urns = [(_upload_video if m.kind == "video" else _upload_image)(account, m) for m in media or []]
    body = {
        "author": f"urn:li:person:{account.external_id}",
        "commentary": little_text("\n\n".join(posts)),
        "visibility": "PUBLIC",
        "distribution": {"feedDistribution": "MAIN_FEED", "targetEntities": [], "thirdPartyDistributionChannels": []},
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }
    if len(urns) == 1:
        body["content"] = {"media": {"id": urns[0]}}
    elif urns:
        body["content"] = {"multiImage": {"images": [{"id": u} for u in urns]}}
    resp = _call("POST", f"{REST}/posts", json=body, timeout=20, headers=_headers(account))
    if resp.status_code in (401, 426) or "NONEXISTENT_VERSION" in resp.text:
        _check(resp, "post")  # reconnect, or the API version was retired
    if resp.status_code >= 400:
        raise SocialError(f"LinkedIn {resp.status_code}: {resp.text[:300]}",
                          permanent=resp.status_code in (400, 403, 422))
    urn = resp.headers.get("x-restli-id") or resp.headers.get("x-linkedin-id") or ""
    return urn, f"https://www.linkedin.com/feed/update/{quote(urn)}/" if urn else ""


def metrics(db: Session, account: SocialAccount, external_id: str) -> dict:
    return {}  # member post analytics need the Community Management API, which personal apps rarely have

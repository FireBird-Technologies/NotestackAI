"""Bluesky over AT Protocol with an app password (bsky.app > Settings > App passwords)."""

import re
from datetime import UTC, datetime

import httpx
from sqlalchemy.orm import Session

from app.models import SocialAccount
from app.services.social import SocialError, token

PDS = "https://bsky.social/xrpc"
PUBLIC = "https://public.api.bsky.app/xrpc"
_URL = re.compile(r"https?://[^\s)\]]+")


def create_session(handle: str, app_password: str) -> dict:
    resp = httpx.post(f"{PDS}/com.atproto.server.createSession",
                      json={"identifier": handle.lstrip("@"), "password": app_password}, timeout=20)
    if resp.status_code in (400, 401):
        raise SocialError("Bluesky did not accept that handle and app password.", permanent=True)
    resp.raise_for_status()
    return resp.json()


def link_facets(text: str) -> list[dict]:
    """Links must be declared as facets with UTF-8 byte offsets to be clickable."""
    facets = []
    for m in _URL.finditer(text):
        start = len(text[: m.start()].encode())
        end = start + len(m.group(0).encode())
        facets.append({"index": {"byteStart": start, "byteEnd": end},
                       "features": [{"$type": "app.bsky.richtext.facet#link", "uri": m.group(0)}]})
    return facets


def publish(db: Session, account: SocialAccount, posts: list[str]) -> tuple[str, str]:
    session = create_session(account.handle, token(account))
    headers = {"Authorization": f"Bearer {session['accessJwt']}"}
    root = parent = None
    for text in posts:
        record: dict = {"$type": "app.bsky.feed.post", "text": text,
                        "createdAt": datetime.now(UTC).isoformat().replace("+00:00", "Z")}
        facets = link_facets(text)
        if facets:
            record["facets"] = facets
        if parent:
            record["reply"] = {"root": root, "parent": parent}
        resp = httpx.post(f"{PDS}/com.atproto.repo.createRecord", headers=headers, timeout=20,
                          json={"repo": session["did"], "collection": "app.bsky.feed.post", "record": record})
        if resp.status_code >= 400:
            raise SocialError(f"Bluesky {resp.status_code}: {resp.text[:300]}", permanent=resp.status_code == 400)
        ref = {"uri": resp.json()["uri"], "cid": resp.json()["cid"]}
        root = root or ref
        parent = ref
    rkey = root["uri"].rsplit("/", 1)[-1]
    return root["uri"], f"https://bsky.app/profile/{session.get('handle', account.handle)}/post/{rkey}"


def metrics(db: Session, account: SocialAccount, external_id: str) -> dict:
    resp = httpx.get(f"{PUBLIC}/app.bsky.feed.getPosts", params={"uris": external_id}, timeout=20)
    if resp.status_code >= 400:
        return {}
    posts = resp.json().get("posts") or [{}]
    p = posts[0]
    return {"likes": p.get("likeCount", 0), "reposts": p.get("repostCount", 0),
            "replies": p.get("replyCount", 0), "quotes": p.get("quoteCount", 0)}

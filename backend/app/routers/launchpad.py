"""Launchpad: the calendar, connected social accounts (OAuth / app password) and tracked short links."""

import json
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import Ctx, decode_token_full, encode_signed, get_ctx
from app.config import settings
from app.db import get_db
from app.models import Artifact, CalendarItem, Document, EngagementEvent, SocialAccount, TrackedLink, Upload
from app.services import launchpad as lp
from app.services.artifacts import TYPE_LABELS
from app.services.crypto import decrypt, encrypt
from app.services.social import AUTO_POST, LIMITS, PLATFORM_LABELS, SocialError, bluesky, linkedin, x
from app.services.social.health import pause_account_posts, resume_account_posts
from app.services.social.media import (MB, SIZE_LIMITS, UPLOAD_TYPES, check_postable, duration, is_blog2video,
                                       media_count, upload_kind)
from app.services.storage import storage

router = APIRouter(prefix="/api", tags=["launchpad"])

Platform = Literal["x", "linkedin", "bluesky", "substack_notes"]


# Calendar


class When(BaseModel):
    """When a post goes out: the wall time the user picked in their own time zone (local_time "2026-10-07T11:00" +
    timezone "Asia/Karachi", on a half hour), converted to UTC here; or an exact scheduled_at (Post now)."""
    scheduled_at: datetime | None = None
    local_time: str | None = Field(None, max_length=32)
    timezone: str | None = Field(None, max_length=64)

    def utc(self) -> datetime | None:
        if self.local_time:
            try:
                zone = ZoneInfo(self.timezone or "")
            except (ZoneInfoNotFoundError, ValueError) as exc:
                raise HTTPException(400, {"code": "bad_timezone", "message": "Unknown time zone."}) from exc
            try:
                wall = datetime.fromisoformat(self.local_time)
            except ValueError as exc:
                raise HTTPException(400, {"code": "bad_time", "message": "Pick a date and time."}) from exc
            if wall.tzinfo or wall.minute not in (0, 30) or wall.second or wall.microsecond:
                raise HTTPException(400, {"code": "half_hour_only", "message": "Pick a time on the hour or half hour."})
            return wall.replace(tzinfo=zone).astimezone(UTC)
        return _aware(self.scheduled_at) if self.scheduled_at else None


class ItemIn(When):
    platform: Platform
    content: str = Field(min_length=1, max_length=10000)
    thread: list[str] = Field(default_factory=list, max_length=25)
    artifact_id: uuid.UUID | None = None  # the attachment (a video, quote card, carousel...), never a Launch Kit
    kit_id: uuid.UUID | None = None  # the Launch Kit the post was written from (tracked, not attached)
    document_id: uuid.UUID | None = None
    social_account_id: uuid.UUID | None = None
    remind_by_email: bool = False
    draft: bool = False


class ItemPatch(When):
    artifact_id: uuid.UUID | None = None  # set or (null) clear what the post carries
    content: str | None = Field(None, min_length=1, max_length=10000)
    thread: list[str] | None = None
    social_account_id: uuid.UUID | None = None
    remind_by_email: bool | None = None
    status: Literal["scheduled", "draft", "paused"] | None = None


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


# audio can't be posted; "upload" is a file the user brought from their computer
POSTABLE = ("video", "quote_card", "carousel", "summary", "launch_kit", "mind_map", "upload")


def _cite_free(text: str) -> str:
    return re.sub(r"\s*\[\d+\]", "", text or "").strip()


def _prefill(a: Artifact) -> dict:
    """A starting text per platform for a post of this artifact: X as a list of posts (a thread), LinkedIn as one."""
    c = a.content_json or {}
    title = c.get("title") or TYPE_LABELS.get(a.type, a.type)
    if a.type == "upload":  # their own file: the words are theirs to write
        return {"x": [""], "linkedin": ""}
    if a.type == "launch_kit":
        posts = c.get("posts") or {}
        x_posts = posts.get("x_thread") or posts.get("x") or [title]
        return {"x": x_posts, "linkedin": "\n\n".join(posts.get("linkedin") or x_posts)}
    text = {
        "summary": _cite_free(c.get("summary") or title),
        "quote_card": f'"{c.get("quote")}"' + (f" ({c['source']})" if c.get("source") else "") if c.get("quote")
                      else title,
        "carousel": ((c.get("slides") or [{}])[0].get("heading") or title),
    }.get(a.type, title)
    return {"x": [text], "linkedin": text}


def artifact_brief(a: Artifact) -> dict:
    """What the composer and the calendar show of the attached artifact."""
    c = a.content_json or {}
    thumb = (a.storage_key if a.type == "quote_card" or upload_kind(a) == "image"
             else (c.get("slide_keys") or [a.storage_key])[0] if a.type == "carousel" else None)
    return {"id": str(a.id), "type": a.type, "type_label": TYPE_LABELS.get(a.type, a.type),
            "title": c.get("title") or TYPE_LABELS.get(a.type, a.type),
            "media": upload_kind(a) or ("video" if a.type == "video" else "image" if media_count(a) else "text"),
            "media_count": media_count(a), "duration_s": duration(a),
            "thumb_url": storage.presign_get(thumb) if thumb else None,
            # The user's own file, to preview before posting it.
            "view_url": storage.presign_get(a.storage_key) if a.type == "upload" and a.storage_key else None,
            # A blog2video video with scenes but no MP4 yet: listed, but it has to be rendered before it can go out.
            # Made by the video service (blog2video): it opens in the video editor.
            "editable_video": is_blog2video(a),
            "needs_render": is_blog2video(a) and not (a.content_json or {}).get("video_url"),
            # Its MP4 is being made right now: it can't be scheduled until the render finishes.
            "rendering": is_blog2video(a) and a.status == "rendering",
            "created_at": a.created_at.isoformat() if a.created_at else None, "prefill": _prefill(a)}


def serialize_item(item: CalendarItem, account: SocialAccount | None = None, clicks: int = 0,
                   artifact: Artifact | None = None, kit: Artifact | None = None) -> dict:
    return {
        "id": str(item.id),
        "platform": item.platform,
        "platform_label": PLATFORM_LABELS.get(item.platform, item.platform),
        "scheduled_at": _aware(item.scheduled_at).isoformat(),
        "status": item.status,
        "content": item.content,
        "thread": item.thread or [],
        "artifact_id": str(item.artifact_id) if item.artifact_id else None,
        "artifact": artifact_brief(artifact) if artifact else None,
        "kit_id": str(item.kit_id) if item.kit_id else None,
        "kit_title": ((kit.content_json or {}).get("post_title") or (kit.content_json or {}).get("title")) if kit else None,
        "document_id": str(item.document_id) if item.document_id else None,
        "social_account_id": str(item.social_account_id) if item.social_account_id else None,
        "account_handle": account.handle if account else None,
        "remind_by_email": item.remind_by_email,
        "auto_post": item.platform in AUTO_POST and bool(item.social_account_id) and not item.remind_by_email,
        "external_url": item.external_url,
        "posted_at": _aware(item.posted_at).isoformat() if item.posted_at else None,
        "error": item.error,
        "metrics": item.metrics or {},
        "clicks": clicks,
    }


def _item(ctx: Ctx, item_id: uuid.UUID) -> CalendarItem:
    item = ctx.db.scalar(select(CalendarItem).where(CalendarItem.id == item_id,
                                                    CalendarItem.workspace_id == ctx.workspace.id))
    if not item:
        raise HTTPException(404, "Calendar item not found")
    return item


def _account(ctx: Ctx, account_id: uuid.UUID | None, platform: str) -> SocialAccount | None:
    if not account_id:
        return None
    account = ctx.db.scalar(select(SocialAccount).where(SocialAccount.id == account_id,
                                                        SocialAccount.workspace_id == ctx.workspace.id))
    if not account or account.platform != platform:
        raise HTTPException(400, "That account does not match the platform")
    return account


CONNECTED_ONLY = ("x", "linkedin")  # these post only through a live connection (no email fallback)


def can_post_media(a: SocialAccount) -> bool:
    return {"x": x.can_post_media, "linkedin": linkedin.can_post_media}.get(a.platform, lambda _: False)(a)


def _require_connected(platform: str, account: SocialAccount | None, artifact: Artifact | None) -> None:
    """X and LinkedIn: scheduling needs a live connection (and one allowed to post media, when media is attached)."""
    if platform not in CONNECTED_ONLY:
        return
    label = PLATFORM_LABELS[platform]
    if not account or account.status != "active":
        raise HTTPException(409, {"code": "not_connected",
                                  "message": f"Connect {label} to schedule posts there."
                                  if not account else f"Your {label} connection is down. Reconnect {label} first."})
    if artifact and media_count(artifact) and not can_post_media(account):
        raise HTTPException(409, {"code": "reconnect", "message": f"Reconnect {label} to post images and videos."})


def _validate_lengths(platform: str, posts: list[str]) -> None:
    limit = LIMITS.get(platform)
    if platform in ("x", "bluesky") and limit:
        for i, p in enumerate(posts, start=1):
            if len(p) > limit:
                raise HTTPException(422, {"code": "too_long",
                                          "message": f"Post {i} is {len(p)} characters; {PLATFORM_LABELS[platform]} "
                                                     f"allows {limit}."})


def _enrich(ctx: Ctx, items: list[CalendarItem]) -> list[dict]:
    accounts = {a.id: a for a in ctx.db.scalars(
        select(SocialAccount).where(SocialAccount.workspace_id == ctx.workspace.id))}
    clicks = lp.clicks_by_item(ctx.db, [i.id for i in items])
    ids = {i.artifact_id for i in items if i.artifact_id} | {i.kit_id for i in items if i.kit_id}
    artifacts = {a.id: a for a in ctx.db.scalars(select(Artifact).where(Artifact.id.in_(ids)))} if ids else {}
    return [serialize_item(i, accounts.get(i.social_account_id), clicks.get(i.id, 0), artifacts.get(i.artifact_id),
                           artifacts.get(i.kit_id)) for i in items]


def _kit(ctx: Ctx, kit_id: uuid.UUID) -> Artifact:
    """This workspace's Launch Kit (what a post was written from)."""
    kit = ctx.db.scalar(select(Artifact).where(Artifact.id == kit_id, Artifact.workspace_id == ctx.workspace.id,
                                               Artifact.type == "launch_kit"))
    if not kit:
        raise HTTPException(404, "Launch Kit not found")
    return kit


def _postable(ctx: Ctx, artifact_id: uuid.UUID, platform: str) -> Artifact:
    """This workspace's artifact, checked for the platform (audio, unfinished, too long for X: 400)."""
    a = ctx.db.scalar(select(Artifact).where(Artifact.id == artifact_id, Artifact.workspace_id == ctx.workspace.id))
    if not a:
        raise HTTPException(404, "Artifact not found")
    check_postable(a, platform)
    return a


@router.get("/calendar")
def list_items(ctx: Ctx = Depends(get_ctx), start: datetime | None = None, end: datetime | None = None,
               status: str | None = None, limit: int = 500):
    q = select(CalendarItem).where(CalendarItem.workspace_id == ctx.workspace.id)
    if start:
        q = q.where(CalendarItem.scheduled_at >= start)
    if end:
        q = q.where(CalendarItem.scheduled_at < end)
    if status:
        q = q.where(CalendarItem.status.in_(status.split(",")))
    items = list(ctx.db.scalars(q.order_by(CalendarItem.scheduled_at).limit(min(limit, 1000))).all())
    return _enrich(ctx, items)


@router.post("/calendar")
def create_item(body: ItemIn, ctx: Ctx = Depends(get_ctx)):
    when = body.utc()
    if when is None:
        raise HTTPException(422, {"code": "no_time", "message": "Pick when it goes out."})
    account = _account(ctx, body.social_account_id, body.platform)
    _validate_lengths(body.platform, [body.content, *body.thread])
    artifact = _postable(ctx, body.artifact_id, body.platform) if body.artifact_id else None
    kit = _kit(ctx, body.kit_id) if body.kit_id else None
    _require_connected(body.platform, account, artifact)
    if body.document_id and not ctx.db.scalar(select(Document.id).where(Document.id == body.document_id,
                                                                        Document.workspace_id == ctx.workspace.id)):
        raise HTTPException(404, "Document not found")
    item = CalendarItem(
        workspace_id=ctx.workspace.id, platform=body.platform, scheduled_at=when,
        content=body.content, thread=[t for t in body.thread if t.strip()], artifact_id=body.artifact_id,
        kit_id=kit.id if kit else None,
        document_id=body.document_id, social_account_id=account.id if account else None,
        remind_by_email=body.remind_by_email or body.platform not in AUTO_POST or not account,
        status="draft" if body.draft else "scheduled",
    )
    ctx.db.add(item)
    ctx.db.commit()
    return _enrich(ctx, [item])[0]


@router.patch("/calendar/{item_id}")
def update_item(item_id: uuid.UUID, body: ItemPatch, ctx: Ctx = Depends(get_ctx)):
    item = _item(ctx, item_id)
    if item.status in ("posted", "publishing"):
        raise HTTPException(409, "This post already went out.")
    when = body.utc()
    if when is not None:
        item.scheduled_at = when
    if body.content is not None:
        item.content = body.content
    if body.thread is not None:
        item.thread = [t for t in body.thread if t.strip()]
    if "artifact_id" in body.model_fields_set:
        item.artifact_id = _postable(ctx, body.artifact_id, item.platform).id if body.artifact_id else None
    if "social_account_id" in body.model_fields_set:
        item.social_account_id = (_account(ctx, body.social_account_id, item.platform).id
                                  if body.social_account_id else None)
    if body.remind_by_email is not None:
        item.remind_by_email = body.remind_by_email
    if not item.social_account_id or item.platform not in AUTO_POST:
        item.remind_by_email = True
    account = ctx.db.get(SocialAccount, item.social_account_id) if item.social_account_id else None
    artifact = ctx.db.get(Artifact, item.artifact_id) if item.artifact_id else None
    if body.status == "paused":
        item.status = "paused"  # held by hand: never attempted until resumed
    elif body.status is not None or item.status in ("failed", "reminded", "paused"):
        # Going out (again): only through a live connection, and only at a time still ahead.
        _require_connected(item.platform, account, artifact)
        if item.status == "paused" and _aware(item.scheduled_at) <= datetime.now(UTC):
            raise HTTPException(409, {"code": "missed", "message": "Pick a time that is still ahead."})
        item.status = body.status or "scheduled"
    elif item.platform in CONNECTED_ONLY and body.model_fields_set & {"social_account_id", "artifact_id"}:
        _require_connected(item.platform, account, artifact)
    item.error = None
    item.attempts = 0
    _validate_lengths(item.platform, [item.content, *(item.thread or [])])
    ctx.db.commit()
    return _enrich(ctx, [item])[0]


@router.delete("/calendar/{item_id}")
def delete_item(item_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    item = _item(ctx, item_id)
    ctx.db.delete(item)
    ctx.db.commit()
    return {"ok": True}


@router.post("/calendar/{item_id}/publish")
async def publish_now(item_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    item = _item(ctx, item_id)
    if item.status in ("posted", "publishing"):
        raise HTTPException(409, "This post already went out.")
    item.status = "publishing"
    item.attempts = 0
    ctx.db.commit()
    if lp.has_media(ctx.db, item):
        lp.queue_publish(ctx.db, item)  # uploading takes a while: a job does it, the page follows the status
    else:
        await run_in_threadpool(lp.publish_item, ctx.db, item)
    return _enrich(ctx, [item])[0]


class UploadIn(BaseModel):
    upload_id: uuid.UUID
    duration_s: float | None = Field(None, ge=0, le=24 * 3600)  # a video's length, read by the browser


@router.post("/launchpad/uploads")
def register_upload(body: UploadIn, ctx: Ctx = Depends(get_ctx)):
    """A file the user uploaded from their computer (through /api/storage/uploads), made postable: it becomes an
    `upload` artifact, attached and posted like anything Notestack made, and offered again in the picker later."""
    upload = ctx.db.scalar(select(Upload).where(Upload.id == body.upload_id, Upload.workspace_id == ctx.workspace.id))
    if not upload:
        raise HTTPException(404, "Upload not found")
    if upload.status != "complete":
        raise HTTPException(409, "This file hasn't finished uploading.")
    kind = UPLOAD_TYPES.get(upload.content_type)
    if not kind:
        raise HTTPException(415, "LinkedIn takes JPG, PNG or GIF images and MP4 videos.")
    low, high = SIZE_LIMITS[("linkedin", kind)]
    size = upload.size_bytes or 0
    if size > high:
        raise HTTPException(413, f"This {kind} is {size / MB:.0f} MB; LinkedIn takes up to {high // MB} MB.")
    if size < low:
        raise HTTPException(400, f"This {kind} is too small for LinkedIn (at least {low // 1024} KB).")
    title = upload.filename.rsplit(".", 1)[0] if "." in upload.filename else upload.filename
    a = Artifact(workspace_id=ctx.workspace.id, type="upload", status="ready", storage_key=upload.key,
                 content_json={"title": title[:200] or "Upload", "filename": upload.filename,
                               "content_type": upload.content_type, "media": kind, "size_bytes": size,
                               **({"duration_s": body.duration_s} if body.duration_s else {})})
    ctx.db.add(a)
    ctx.db.commit()
    return artifact_brief(a)


@router.get("/launchpad/postable")
def postable(ctx: Ctx = Depends(get_ctx), q: str = "", limit: int = 60):
    """What can be attached to a post: finished videos, quote cards, carousels, summaries, launch kits, mind maps
    (not audio), newest first. Videos made but not rendered yet are listed too, flagged needs_render (they can only be
    posted once rendered), and so are videos being rendered, flagged rendering."""
    rows = ctx.db.scalars(select(Artifact).where(Artifact.workspace_id == ctx.workspace.id,
                                                 Artifact.type.in_(POSTABLE))
                          .order_by(Artifact.created_at.desc()).limit(400))
    needle = q.strip().lower()
    out = []
    for a in rows:
        # A blog2video video counts once blog2video made it (ready), rendered or not; anything else once it is ready.
        # A blog2video video mid-render stays listed (flagged rendering).
        ready = a.status == "ready" or (is_blog2video(a) and (bool((a.content_json or {}).get("video_url"))
                                                              or a.status == "rendering"))
        title = ((a.content_json or {}).get("title") or "").lower()
        if ready and (not needle or needle in title):
            out.append(artifact_brief(a))
        if len(out) >= min(limit, 200):
            break
    return out


# Social accounts


def serialize_account(a: SocialAccount) -> dict:
    return {"id": str(a.id), "platform": a.platform, "platform_label": PLATFORM_LABELS[a.platform],
            "handle": a.handle, "status": a.status, "avatar_url": a.avatar_url,
            "can_post_media": can_post_media(a),
            # No refresh token and the connection ends within a week (LinkedIn's 60 day tokens).
            "expires_soon": bool(a.expires_at and not a.refresh_token
                                 and _aware(a.expires_at) - datetime.now(UTC) < timedelta(days=7)),
            "expires_at": _aware(a.expires_at).isoformat() if a.expires_at else None,
            # Down (expired, revoked, disconnected), or unable to post images and videos.
            "needs_reconnect": a.status != "active" or (a.platform in CONNECTED_ONLY and not can_post_media(a)),
            "connected_at": a.created_at.isoformat() if a.created_at else None}


@router.get("/social/accounts")
def list_accounts(ctx: Ctx = Depends(get_ctx)):
    accounts = ctx.db.scalars(select(SocialAccount).where(SocialAccount.workspace_id == ctx.workspace.id)
                              .order_by(SocialAccount.created_at)).all()
    return {
        "accounts": [serialize_account(a) for a in accounts],
        "available": {"x": x.configured(), "linkedin": linkedin.configured(), "bluesky": True},
        "redirect_uris": {"x": x.redirect_uri(), "linkedin": linkedin.redirect_uri()},
    }


@router.delete("/social/accounts/{account_id}")
def disconnect(account_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    account = ctx.db.scalar(select(SocialAccount).where(SocialAccount.id == account_id,
                                                        SocialAccount.workspace_id == ctx.workspace.id))
    if not account:
        raise HTTPException(404, "Account not found")
    # Kept (its posts stay linked to it), tokens gone, posts paused: reconnecting the same account resumes them.
    account.status = "revoked"
    account.access_token = ""  # no usable token kept
    account.refresh_token = None
    label = PLATFORM_LABELS[account.platform]
    pause_account_posts(ctx.db, account, f"{label} disconnected. Reconnect {label} to resume.")
    ctx.db.commit()
    return {"ok": True}


def _upsert_account(db: Session, workspace_id: uuid.UUID, platform: str, info: dict, secret: str,
                    refresh: str | None = None, expires_in: int | None = None, scopes: str | None = None) -> None:
    account = db.scalar(select(SocialAccount).where(SocialAccount.workspace_id == workspace_id,
                                                    SocialAccount.platform == platform,
                                                    SocialAccount.external_id == info["external_id"]))
    if not account:
        account = SocialAccount(workspace_id=workspace_id, platform=platform, external_id=info["external_id"],
                                handle=info["handle"], access_token="")
        db.add(account)
    account.handle = info["handle"]
    account.avatar_url = info.get("avatar_url")
    account.access_token = encrypt(secret)
    account.refresh_token = encrypt(refresh) if refresh else account.refresh_token
    account.expires_at = datetime.now(UTC) + timedelta(seconds=int(expires_in)) if expires_in else None
    account.scopes = scopes
    account.status = "active"
    resume_account_posts(db, account)  # its paused posts still ahead go back to scheduled
    db.commit()


class BlueskyIn(BaseModel):
    handle: str = Field(min_length=3, max_length=200)
    app_password: str = Field(min_length=8, max_length=100)


@router.post("/social/bluesky")
async def connect_bluesky(body: BlueskyIn, ctx: Ctx = Depends(get_ctx)):
    try:
        session = await run_in_threadpool(bluesky.create_session, body.handle, body.app_password)
    except SocialError as exc:
        raise HTTPException(400, {"code": "bluesky_auth", "message": str(exc)}) from exc
    _upsert_account(ctx.db, ctx.workspace.id, "bluesky",
                    {"external_id": session["did"], "handle": session.get("handle", body.handle)}, body.app_password)
    return list_accounts(ctx)


# OAuth (X, LinkedIn). The signed state carries the workspace and PKCE verifier; the callback hands a
# short lived encrypted ticket back to the SPA, which completes the link as the signed in user.

STATE_TTL = timedelta(minutes=10)


def _launchpad_redirect(**params: str) -> RedirectResponse:
    return RedirectResponse(f"{settings.frontend_url.rstrip('/')}/app/launchpad?{urlencode(params)}", 302)


@router.post("/social/{platform}/start")
def oauth_start(platform: Literal["x", "linkedin"], ctx: Ctx = Depends(get_ctx)):
    """Returns the provider URL. The SPA calls this with its bearer token, then navigates to `url`."""
    mod = x if platform == "x" else linkedin
    if not mod.configured():
        raise HTTPException(503, {"code": "not_configured",
                                  "message": f"Set {platform.upper()}_CLIENT_ID and {platform.upper()}_CLIENT_SECRET."})
    nonce = secrets.token_urlsafe(24)
    payload = {"typ": "social_state", "nonce": nonce, "ws": str(ctx.workspace.id), "platform": platform}
    if platform == "x":
        verifier, challenge = x.pkce_pair()
        payload["verifier"] = verifier
        state = encode_signed(payload, STATE_TTL)
        url = x.authorize_url(state, challenge)
    else:
        state = encode_signed(payload, STATE_TTL)
        url = linkedin.authorize_url(state)
    return {"url": url, "nonce": nonce}


@router.get("/social/{platform}/callback")
def oauth_callback(platform: Literal["x", "linkedin"], code: str | None = None, state: str | None = None,
                   error: str | None = None, db: Session = Depends(get_db)):
    label = PLATFORM_LABELS[platform]
    if error or not code or not state:
        return _launchpad_redirect(error=f"{label} connection was cancelled.")
    try:
        saved = decode_token_full(state, expected_type="social_state")
    except HTTPException:
        return _launchpad_redirect(error=f"{label} connection expired. Try again.")
    if saved.get("platform") != platform:
        return _launchpad_redirect(error=f"{label} connection failed.")
    try:
        if platform == "x":
            info = x.exchange_code(code, saved["verifier"])
        else:
            info = linkedin.exchange_code(code)
    except Exception:
        return _launchpad_redirect(error=f"{label} connection failed. Try again.")
    # Do not link here: this request carries no session. The signed in SPA finishes the link, and only
    # for the workspace that started it, so a forwarded authorize link cannot attach someone's account
    # to another workspace.
    ticket = encode_signed({"typ": "social_link", "ws": saved["ws"], "platform": platform,
                            "data": encrypt(json.dumps(info))}, timedelta(minutes=10))
    return _launchpad_redirect(link=ticket, platform=platform)


class LinkIn(BaseModel):
    ticket: str


@router.post("/social/complete")
def oauth_complete(body: LinkIn, ctx: Ctx = Depends(get_ctx)):
    try:
        saved = decode_token_full(body.ticket, expected_type="social_link")
    except HTTPException as exc:
        raise HTTPException(400, {"code": "expired", "message": "That connection expired. Try again."}) from exc
    if saved.get("ws") != str(ctx.workspace.id):
        raise HTTPException(403, {"code": "wrong_workspace", "message": "This connection was started elsewhere."})
    info = json.loads(decrypt(saved["data"]) or "{}")
    if not info.get("access_token"):
        raise HTTPException(400, {"code": "expired", "message": "That connection expired. Try again."})
    _upsert_account(ctx.db, ctx.workspace.id, saved["platform"], info, info["access_token"],
                    info.get("refresh_token"), info.get("expires_in"), info.get("scope"))
    return list_accounts(ctx)


# Tracked links (public)

links_router = APIRouter(tags=["links"])


@links_router.get("/l/{slug}")
def follow_link(slug: str, request: Request, db: Session = Depends(get_db)):
    link = db.scalar(select(TrackedLink).where(TrackedLink.slug == slug))
    if not link:
        raise HTTPException(404, "Link not found")
    db.add(EngagementEvent(workspace_id=link.workspace_id, tracked_link_id=link.id, kind="click",
                           metadata_json={"referer": request.headers.get("referer", "")[:300],
                                          "ua": request.headers.get("user-agent", "")[:200]}))
    db.commit()
    return RedirectResponse(link.target_url, status_code=302)

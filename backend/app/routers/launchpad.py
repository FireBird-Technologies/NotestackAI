"""Launchpad: the calendar, connected social accounts (OAuth / app password) and tracked short links."""

import html
import json
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import Ctx, decode_token_full, encode_signed, get_ctx
from app.config import settings
from app.db import get_db
from app.llm import run as llm_run
from app.llm.signatures import SocialPostAssistant
from app.models import (
    Artifact,
    CalendarItem,
    Document,
    EngagementEvent,
    SocialAccount,
    TrackedLink,
    Upload,
    Workspace,
)
from app.pipeline.passages import voice_text
from app.services import launchpad as lp
from app.services.artifacts import TYPE_LABELS, download_name
from app.services.crypto import decrypt, encrypt
from app.services.report_export import report_caption
from app.services.social import AUTO_POST, LIMITS, PLATFORM_LABELS, SocialError, bluesky, facebook, instagram, linkedin, threads, x
from app.services.social.health import pause_account_posts, resume_account_posts
from app.services.social.media import (
    MB,
    SIZE_LIMITS,
    UPLOAD_TYPES,
    carries_media,
    check_postable,
    duration,
    is_blog2video,
    media_count,
    upload_kind,
)
from app.services.storage import storage

router = APIRouter(prefix="/api", tags=["launchpad"])

Platform = Literal["x", "facebook", "instagram", "threads", "linkedin", "bluesky", "substack_notes"]


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
    content: str = Field("", max_length=10000)  # may be empty when the post carries images or a video
    thread: list[str] = Field(default_factory=list, max_length=25)
    artifact_id: uuid.UUID | None = None  # the attachment (a video, quote card, carousel...), never a Launch Kit
    kit_id: uuid.UUID | None = None  # the Launch Kit the post was written from (tracked, not attached)
    document_id: uuid.UUID | None = None
    social_account_id: uuid.UUID | None = None
    remind_by_email: bool = False
    draft: bool = False
    # Post now: published (or, by email, reminded) in this request, never left scheduled; no time needed
    publish_now: bool = False


class ItemPatch(When):
    artifact_id: uuid.UUID | None = None  # set or (null) clear what the post carries
    content: str | None = Field(None, max_length=10000)
    thread: list[str] | None = None
    social_account_id: uuid.UUID | None = None
    remind_by_email: bool | None = None
    status: Literal["scheduled", "draft", "paused"] | None = None


class PostAssistIn(BaseModel):
    platform: Platform
    action: Literal["generate", "rephrase", "shorten", "expand", "casual", "formal"]
    prompt: str = Field("", max_length=4000)
    text: str = Field("", max_length=10000)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


# audio can't be posted; "upload" is a file the user brought from their computer
POSTABLE = ("video", "quote_card", "carousel", "summary", "launch_kit", "upload", "slide_deck", "report",
            "infographic")
# Listed on the Launchpad too, but only to download: X and LinkedIn take no audio files (check_postable refuses it)
LISTED = (*POSTABLE, "audio_overview")


def _cite_free(text: str) -> str:
    return re.sub(r"\s*\[\d+\]", "", text or "").strip()


def _prefill(a: Artifact) -> dict:
    """A starting text per platform for a post of this artifact: X as a list of posts (a thread), LinkedIn as one."""
    c = a.content_json or {}
    title = c.get("title") or TYPE_LABELS.get(a.type, a.type)
    if a.type == "upload":  # their own file: the words are theirs to write
        return {"x": [""], "linkedin": ""}
    if a.type == "report":  # always a PDF: a short caption, and the PDF carries the report
        text = report_caption(a)
        return {"x": [text], "linkedin": text}
    if a.type == "infographic":  # the image says it all: its title to start the caption with
        head = "\n\n".join(x for x in (c.get("title"), c.get("subtitle")) if isinstance(x, str) and x.strip())
        return {"x": [head or title], "linkedin": head or title}
    if a.type == "launch_kit":
        posts = c.get("posts") or {}
        x_posts = posts.get("x_thread") or posts.get("x") or [title]
        return {"x": x_posts, "linkedin": "\n\n".join(posts.get("linkedin") or x_posts)}
    text = {
        "summary": _cite_free(c.get("summary") or title),
        "quote_card": f'"{c.get("quote")}"' + (f" ({c['source']})" if c.get("source") else "") if c.get("quote")
                      else title,
        "carousel": ((c.get("slides") or [{}])[0].get("heading") or title),
        "slide_deck": _deck_prefill(c) or title,
    }.get(a.type, title)
    return {"x": [text], "linkedin": text}


def _deck_prefill(c: dict) -> str:
    """A slide deck's post: its title, its subtitle, and the takeaways of its closing slide."""
    deck = c.get("deck") or {}
    slides = deck.get("slides") or []
    closing = next((s for s in reversed(slides) if s.get("layout") == "closing"), {})
    head = "\n\n".join(x for x in (deck.get("title"), deck.get("subtitle")) if x)
    takeaways = "\n".join(f"- {t}" for t in closing.get("takeaways") or [])
    return "\n\n".join(x for x in (head, takeaways) if x)


def artifact_brief(a: Artifact) -> dict:
    """What the composer and the calendar show of the attached artifact."""
    c = a.content_json or {}
    thumb = (a.storage_key if a.type == "quote_card" or upload_kind(a) == "image"
             else (c.get("slide_keys") or [a.storage_key])[0] if a.type == "carousel" else None)
    return {"id": str(a.id), "type": a.type, "type_label": TYPE_LABELS.get(a.type, a.type),
            # A deck's title starts "Slide deck: ", which its tag already says
            "title": (c.get("title") or TYPE_LABELS.get(a.type, a.type)).removeprefix("Slide deck: " if a.type == "slide_deck" else ""),
            "media": upload_kind(a) or ("video" if a.type == "video" else "audio" if a.type == "audio_overview"
                                        # a report always goes as a PDF
                                        else "document" if a.type == "report"
                                        else "image" if media_count(a) else "text"),
            "media_count": media_count(a), "duration_s": duration(a),
            "thumb_url": storage.presign_get(thumb) if thumb else None,
            # The user's own file, to preview before posting it.
            "view_url": storage.presign_get(a.storage_key) if a.type == "upload" and a.storage_key else None,
            # An audio overview can't be posted: it is offered to download instead.
            "download_url": (storage.presign_get(a.storage_key, download_name=download_name(a))
                             if a.type == "audio_overview" and a.storage_key else None),
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


REVIEW_SOCIAL_PLATFORMS = frozenset(("x", "facebook", "instagram", "threads"))


def _review_social_allowed(email: str) -> bool:
    allowed = {value.strip().casefold() for value in settings.social_review_allowed_emails.split(",") if value.strip()}
    return "*" in allowed or email.strip().casefold() in allowed


def _require_review_social_access(ctx: Ctx, platform: str) -> None:
    if platform in REVIEW_SOCIAL_PLATFORMS and not _review_social_allowed(ctx.user.email):
        raise HTTPException(403, {"code": "not_available", "message": "This channel is not available yet."})


def _account(ctx: Ctx, account_id: uuid.UUID | None, platform: str) -> SocialAccount | None:
    _require_review_social_access(ctx, platform)
    if not account_id:
        return None
    account = ctx.db.scalar(select(SocialAccount).where(SocialAccount.id == account_id,
                                                        SocialAccount.workspace_id == ctx.workspace.id))
    if not account or account.platform != platform:
        raise HTTPException(400, "That account does not match the platform")
    return account


CONNECTED_ONLY = ("x", "facebook", "instagram", "threads", "linkedin")


def can_post_media(a: SocialAccount) -> bool:
    return {"x": x.can_post_media, "facebook": facebook.can_post_media,
            "instagram": instagram.can_post_media, "threads": threads.can_post_media,
            "linkedin": linkedin.can_post_media}.get(a.platform, lambda _: False)(a)


def _require_connected(platform: str, account: SocialAccount | None, artifact: Artifact | None) -> None:
    """Auto-post platforms need a matching live connection and, for media, the platform's required permissions."""
    if platform not in CONNECTED_ONLY:
        return
    label = PLATFORM_LABELS[platform]
    if not account or account.status != "active":
        raise HTTPException(409, {"code": "not_connected",
                                  "message": f"Connect {label} to schedule posts there."
                                  if not account else f"Your {label} connection is down. Reconnect {label} first."})
    if platform == "instagram" and not carries_media(artifact):
        raise HTTPException(422, {"code": "media_required",
                                  "message": "Instagram needs an image or video. Attach one before scheduling."})
    if artifact and media_count(artifact) and not can_post_media(account):
        raise HTTPException(409, {"code": "media_hosting",
                                  "message": f"Configure HTTPS-accessible media storage before posting media through {label}."})


def _require_words(posts: list[str], artifact: Artifact | None) -> None:
    """A post needs words, unless it carries images or a video (those can go out without a caption)."""
    if not any(p.strip() for p in posts) and not carries_media(artifact):
        raise HTTPException(422, {"code": "no_text", "message": "Write something to post, or attach an image or video."})


def _validate_lengths(platform: str, posts: list[str]) -> None:
    limit = LIMITS.get(platform)
    if platform in ("x", "threads", "bluesky") and limit:
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


@router.post("/launchpad/assist")
def assist_post(body: PostAssistIn, ctx: Ctx = Depends(get_ctx)):
    """Generate a post from a brief, or reshape the active draft without adding new facts."""
    prompt = body.prompt.strip()
    current = body.text.strip()
    if body.action == "generate" and not prompt:
        raise HTTPException(422, {"code": "no_prompt", "message": "Describe what you want the post to say."})
    if body.action != "generate" and not current:
        raise HTTPException(422, {"code": "no_text", "message": "Write something before asking AI to rework it."})
    limit = min(LIMITS.get(body.platform, 3000), 3000)
    result = llm_run.predict(
        SocialPostAssistant,
        db=ctx.db,
        workspace_id=ctx.workspace.id,
        platform=PLATFORM_LABELS.get(body.platform, body.platform),
        action=body.action,
        brief=prompt,
        current_text=current,
        voice_profile=voice_text(ctx.db, ctx.workspace.id),
        character_limit=limit,
    )
    text = (result.get("text") or "").strip()
    if not text:
        raise HTTPException(502, {"code": "empty_generation", "message": "AI did not return any text. Try again."})
    return {"text": text[:limit].rstrip()}


@router.post("/calendar")
def create_item(body: ItemIn, ctx: Ctx = Depends(get_ctx)):
    _require_review_social_access(ctx, body.platform)
    when = datetime.now(UTC) if body.publish_now else body.utc()
    if when is None:
        raise HTTPException(422, {"code": "no_time", "message": "Pick when it goes out."})
    account = _account(ctx, body.social_account_id, body.platform)
    _validate_lengths(body.platform, [body.content, *body.thread])
    artifact = _postable(ctx, body.artifact_id, body.platform) if body.artifact_id else None
    _require_words([body.content, *body.thread], artifact)
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
        remind_by_email=(False if body.platform in CONNECTED_ONLY
                          else body.remind_by_email or body.platform not in AUTO_POST or not account),
        status="draft" if body.draft else "publishing" if body.publish_now else "scheduled",
    )
    ctx.db.add(item)
    ctx.db.commit()
    if body.publish_now:
        _go_now(ctx, item)
    return _enrich(ctx, [item])[0]


def _go_now(ctx: Ctx, item: CalendarItem) -> None:
    """Publish an item claimed for it ("publishing") now: with images or a video through a job (uploading takes a
    while; the page follows its status), anything else right here."""
    if lp.has_media(ctx.db, item):
        lp.queue_publish(ctx.db, item)
    else:
        lp.publish_item(ctx.db, item)


@router.patch("/calendar/{item_id}")
def update_item(item_id: uuid.UUID, body: ItemPatch, ctx: Ctx = Depends(get_ctx)):
    item = _item(ctx, item_id)
    if item.status in ("posted", "publishing"):
        raise HTTPException(409, "This post already went out.")
    old_account = ctx.db.get(SocialAccount, item.social_account_id) if item.social_account_id else None
    new_account = (_account(ctx, body.social_account_id, item.platform)
                   if "social_account_id" in body.model_fields_set else old_account)
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
        item.social_account_id = new_account.id if new_account else None
    if body.remind_by_email is not None:
        item.remind_by_email = body.remind_by_email
    if item.platform in CONNECTED_ONLY and item.social_account_id:
        item.remind_by_email = False
    elif not item.social_account_id or item.platform not in AUTO_POST:
        item.remind_by_email = True
    account = ctx.db.get(SocialAccount, item.social_account_id) if item.social_account_id else None
    artifact = ctx.db.get(Artifact, item.artifact_id) if item.artifact_id else None
    if body.status == "paused":
        item.status = "paused"  # held by hand: never attempted until resumed
    elif body.status is not None or item.status in ("failed", "reminded", "paused"):
        # Going out (again), rescheduled: only through a live connection, and only at a time still ahead (a failed or
        # reminded post's old time has passed, and it would otherwise go out at the very next run).
        _require_connected(item.platform, account, artifact)
        if (body.status or "scheduled") == "scheduled" and _aware(item.scheduled_at) <= datetime.now(UTC):
            raise HTTPException(409, {"code": "missed", "message": "Pick a time that is still ahead."})
        item.status = body.status or "scheduled"
    elif item.platform in CONNECTED_ONLY and body.model_fields_set & {"social_account_id", "artifact_id"}:
        _require_connected(item.platform, account, artifact)
    item.error = None
    item.attempts = 0
    _require_words([item.content or "", *(item.thread or [])], artifact)  # e.g. the caption emptied, or the video removed
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
def publish_now(item_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    """Publish a scheduled post now. A plain (threadpool) endpoint: its database calls and an inline publish must
    never hold up the event loop, and with it every other request."""
    item = _item(ctx, item_id)
    if item.status in ("posted", "publishing"):
        raise HTTPException(409, "This post already went out.")
    item.status = "publishing"
    item.attempts = 0
    ctx.db.commit()
    _go_now(ctx, item)
    return _enrich(ctx, [item])[0]


class UploadIn(BaseModel):
    upload_id: uuid.UUID | None = None
    upload_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)
    duration_s: float | None = Field(None, ge=0, le=24 * 3600)  # a video's length, read by the browser


@router.post("/launchpad/uploads")
def register_upload(body: UploadIn, ctx: Ctx = Depends(get_ctx)):
    """A file the user uploaded from their computer (through /api/storage/uploads), made postable: it becomes an
    `upload` artifact. Several images become one carousel and are posted together."""
    if body.upload_id and body.upload_ids:
        raise HTTPException(400, "Send one upload or a list of uploads, not both.")
    ids = [body.upload_id] if body.upload_id else body.upload_ids
    if not ids:
        raise HTTPException(400, "Choose at least one file.")
    if len(ids) != len(set(ids)):
        raise HTTPException(400, "Choose each file once.")
    found = ctx.db.scalars(select(Upload).where(Upload.id.in_(ids), Upload.workspace_id == ctx.workspace.id)).all()
    uploads = [next((upload for upload in found if upload.id == upload_id), None) for upload_id in ids]
    if any(upload is None for upload in uploads):
        raise HTTPException(404, "Upload not found")
    checked: list[tuple[Upload, str, int]] = []
    for upload in uploads:
        assert upload is not None
        if upload.status != "complete":
            raise HTTPException(409, f"{upload.filename} hasn't finished uploading.")
        kind = UPLOAD_TYPES.get(upload.content_type)
        if not kind:
            raise HTTPException(415, "Posts take JPG, PNG or GIF images and MP4 videos.")
        if len(uploads) > 1 and kind != "image":
            raise HTTPException(415, "A multi-file post can contain images only. Add a video on its own.")
        low, high = SIZE_LIMITS[("linkedin", kind)]
        size = upload.size_bytes or 0
        if size > high:
            raise HTTPException(413, f"{upload.filename} is {size / MB:.0f} MB; images take up to {high // MB} MB.")
        if size < low:
            raise HTTPException(400, f"{upload.filename} is too small (at least {low // 1024} KB).")
        checked.append((upload, kind, size))
    if len(checked) > 1:
        files = [{"key": upload.key, "filename": upload.filename, "content_type": upload.content_type,
                  "size_bytes": size} for upload, _kind, size in checked]
        a = Artifact(workspace_id=ctx.workspace.id, type="carousel", status="ready", content_json={
            "title": f"{len(files)} uploaded images", "slide_keys": [item["key"] for item in files],
            "slide_files": files, "upload_ids": [str(upload.id) for upload, _kind, _size in checked],
        })
        ctx.db.add(a)
        ctx.db.commit()
        return artifact_brief(a)
    upload, kind, size = checked[0]
    title = upload.filename.rsplit(".", 1)[0] if "." in upload.filename else upload.filename
    a = Artifact(workspace_id=ctx.workspace.id, type="upload", status="ready", storage_key=upload.key,
                 content_json={"title": title[:200] or "Upload", "filename": upload.filename,
                               "content_type": upload.content_type, "media": kind, "size_bytes": size,
                               **({"duration_s": body.duration_s} if body.duration_s else {})})
    ctx.db.add(a)
    ctx.db.commit()
    return artifact_brief(a)


@router.get("/launchpad/postable/{artifact_id}")
def postable_one(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    """One item to attach (the Library's Post button), however old: as the picker lists it."""
    a = ctx.db.scalar(select(Artifact).where(Artifact.id == artifact_id, Artifact.workspace_id == ctx.workspace.id,
                                             Artifact.type.in_(LISTED)))
    ready = a is not None and (a.status == "ready" or (is_blog2video(a) and (bool((a.content_json or {}).get("video_url"))
                                                                              or a.status == "rendering")))
    if not ready:
        raise HTTPException(404, "Nothing to attach")
    return artifact_brief(a)


# The picker's kind chips, as artifact types ("video" is the video service's own videos, any type).
LIBRARY_KINDS = {"kits": ("launch_kit",), "decks": ("slide_deck",), "reports": ("report",),
                 "infographics": ("infographic",), "audio": ("audio_overview",), "uploads": ("upload",)}


def _postable_query(ctx: Ctx, q: str = "", kind: str = "all", kits: bool = True):
    """What can be attached to a post, filtered in the database: finished items, plus blog2video videos made (rendered
    or not) or mid-render, of one kind (or all), whose title has `q`. Newest first."""
    content = Artifact.content_json
    b2v = content["provider"].as_string() == "blog2video"
    ready = or_(Artifact.status == "ready",
                and_(b2v, or_(func.coalesce(content["video_url"].as_string(), "") != "", Artifact.status == "rendering")))
    types = LIBRARY_KINDS.get(kind, LISTED)
    if not kits and kind != "kits":
        types = tuple(t for t in types if t != "launch_kit")
    query = select(Artifact).where(Artifact.workspace_id == ctx.workspace.id, Artifact.type.in_(types), ready)
    if kind == "video":
        query = query.where(b2v)
    if needle := q.strip().lower():
        query = query.where(func.lower(func.coalesce(content["title"].as_string(), "")).contains(needle, autoescape=True))
    return query.order_by(Artifact.created_at.desc())


def _with_schedule(ctx: Ctx, out: list[dict]) -> list[dict]:
    """What each one already has coming up (scheduled, still ahead), soonest first: the list offers to reschedule it."""
    upcoming = ctx.db.scalars(select(CalendarItem).where(
        CalendarItem.workspace_id == ctx.workspace.id, CalendarItem.status == "scheduled",
        CalendarItem.scheduled_at > datetime.now(UTC),
        CalendarItem.artifact_id.in_([uuid.UUID(b["id"]) for b in out])).order_by(CalendarItem.scheduled_at))
    by_artifact: dict[str, list[dict]] = {}
    for it in upcoming:
        by_artifact.setdefault(str(it.artifact_id), []).append(
            {"id": str(it.id), "scheduled_at": _aware(it.scheduled_at).isoformat(),
             "platform_label": PLATFORM_LABELS.get(it.platform, it.platform)})
    for b in out:
        b["scheduled"] = by_artifact.get(b["id"], [])
    return out


@router.get("/launchpad/postable")
def postable(ctx: Ctx = Depends(get_ctx), q: str = "", limit: int = 60):
    """What can be attached to a post: finished videos, quote cards, carousels, summaries, launch kits, mind maps,
    slide decks, reports and infographics, newest first, and audio overviews (listed to download: they can't be posted). Videos made but not
    rendered yet are listed too, flagged needs_render (they can only be posted once rendered), and so are videos being
    rendered, flagged rendering."""
    rows = ctx.db.scalars(_postable_query(ctx, q).limit(min(limit, 200)))
    return _with_schedule(ctx, [artifact_brief(a) for a in rows])


@router.get("/launchpad/library")
def library_page(ctx: Ctx = Depends(get_ctx), q: str = "", kind: str = "all", kits: bool = True,
                 limit: int = 10, offset: int = 0):
    """One page of the attach picker (the same items as /launchpad/postable), of one kind, with the total for its pager.
    `kits=false` leaves launch kits out (the composer attaches; only the Schedule a launch page opens kits)."""
    query = _postable_query(ctx, q, kind, kits)
    total = ctx.db.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0
    rows = ctx.db.scalars(query.limit(max(1, min(limit, 50))).offset(max(0, offset)))
    return {"items": _with_schedule(ctx, [artifact_brief(a) for a in rows]), "total": total}


# Social accounts


def serialize_account(a: SocialAccount) -> dict:
    return {"id": str(a.id), "platform": a.platform, "platform_label": PLATFORM_LABELS[a.platform],
            "handle": a.handle, "status": a.status, "avatar_url": a.avatar_url,
            "can_post_media": can_post_media(a),
            # No refresh token and the connection ends within a week (LinkedIn's 60 day tokens).
            "expires_soon": bool(a.expires_at and not a.refresh_token
                                 and _aware(a.expires_at) - datetime.now(UTC) < timedelta(days=7)),
            "expires_at": _aware(a.expires_at).isoformat() if a.expires_at else None,
            # X/LinkedIn media permission comes from OAuth. Threads media uses public hosting, so missing hosting does
            # not mean its otherwise healthy connection needs reconnecting.
            "needs_reconnect": a.status != "active" or (a.platform in ("x", "linkedin") and not can_post_media(a)),
            "connected_at": a.created_at.isoformat() if a.created_at else None}


@router.get("/social/accounts")
def list_accounts(ctx: Ctx = Depends(get_ctx)):
    review_visible = _review_social_allowed(ctx.user.email)
    # One the user disconnected is gone from the list: the platform offers a fresh Connect, for any account.
    accounts = ctx.db.scalars(select(SocialAccount).where(SocialAccount.workspace_id == ctx.workspace.id,
                                                          SocialAccount.status != "disconnected")
                              .order_by(SocialAccount.created_at)).all()
    accounts = [a for a in accounts if a.platform not in REVIEW_SOCIAL_PLATFORMS or review_visible]
    return {
        "accounts": [serialize_account(a) for a in accounts],
        "available": {"x": review_visible and x.configured(),
                      "facebook": review_visible and facebook.configured(),
                      "instagram": review_visible and instagram.configured(),
                      "threads": review_visible and threads.configured(),
                      "linkedin": linkedin.configured(),
                      "bluesky": True},
        "visible": {"x": review_visible, "facebook": review_visible, "instagram": review_visible,
                    "threads": review_visible, "linkedin": True, "bluesky": True},
        "redirect_uris": {"x": x.redirect_uri(), "facebook": facebook.redirect_uri(),
                          "instagram": instagram.redirect_uri(),
                          "threads": threads.redirect_uri(), "linkedin": linkedin.redirect_uri()},
    }


@router.delete("/social/accounts/{account_id}")
def disconnect(account_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    account = ctx.db.scalar(select(SocialAccount).where(SocialAccount.id == account_id,
                                                        SocialAccount.workspace_id == ctx.workspace.id))
    if not account:
        raise HTTPException(404, "Account not found")
    # Disconnected by the user: no longer listed (the platform shows a plain Connect again), tokens gone, its posts
    # paused. The row stays only so those posts keep their account: whichever account is connected next for this
    # platform takes them over and resumes them (see _upsert_account).
    account.status = "disconnected"
    account.access_token = ""  # no usable token kept
    account.refresh_token = None
    label = PLATFORM_LABELS[account.platform]
    pause_account_posts(ctx.db, account, f"{label} disconnected. Connect {label} to resume.")
    ctx.db.commit()
    return {"ok": True}


def _upsert_account(db: Session, workspace_id: uuid.UUID, platform: str, info: dict, secret: str,
                    refresh: str | None = None, expires_in: int | None = None, scopes: str | None = None) -> None:
    lookup = select(SocialAccount).where(SocialAccount.workspace_id == workspace_id,
                                         SocialAccount.platform == platform,
                                         SocialAccount.external_id == info["external_id"])
    account = db.scalar(lookup)
    if not account:
        candidate = SocialAccount(workspace_id=workspace_id, platform=platform, external_id=info["external_id"],
                                  handle=info["handle"], access_token="")
        try:
            # React development can complete one callback twice at the same moment. The unique key is the authority;
            # a savepoint lets the losing request load and update the row created by the winner instead of returning 500.
            with db.begin_nested():
                db.add(candidate)
                db.flush()
            account = candidate
        except IntegrityError:
            account = db.scalar(lookup)
            if not account:
                raise
    account.handle = info["handle"]
    account.avatar_url = info.get("avatar_url")
    account.authorization_user_id = info.get("authorization_user_id") or account.authorization_user_id
    account.access_token = encrypt(secret)
    account.refresh_token = encrypt(refresh) if refresh else account.refresh_token
    account.expires_at = datetime.now(UTC) + timedelta(seconds=int(expires_in)) if expires_in else None
    account.scopes = scopes
    account.status = "active"
    # Posts paused when the user disconnected an account of this platform (this one, or another) are this one's now.
    db.flush()  # a new account needs its id first
    gone = select(SocialAccount.id).where(SocialAccount.workspace_id == workspace_id, SocialAccount.platform == platform,
                                          SocialAccount.status == "disconnected", SocialAccount.id != account.id)
    for item in db.scalars(select(CalendarItem).where(CalendarItem.social_account_id.in_(gone),
                                                      CalendarItem.status == "paused")):
        item.social_account_id = account.id
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


# OAuth (X, Facebook, Instagram, Threads and LinkedIn). The signed state carries the workspace. X derives its
# verifier from the signed nonce so its state stays under X's 500-character limit. The
# callback hands a short lived encrypted ticket back to the SPA, which completes the link as the signed in user.

STATE_TTL = timedelta(minutes=10)
LINK_FIELDS = ("access_token", "refresh_token", "expires_in", "scope", "external_id", "handle", "avatar_url")


# The mobile app's own address for the end of the flow. Fixed here, never taken from the request, so the ticket
# can only go to the web app or to the Notestack app.
APP_LAUNCHPAD_URL = "notestack://launchpad"


def _launchpad_redirect(client: str = "web", **params: str) -> RedirectResponse:
    base = APP_LAUNCHPAD_URL if client == "app" else f"{settings.frontend_url.rstrip('/')}/app/launchpad"
    return RedirectResponse(f"{base}?{urlencode(params)}", 302)


def _instagram_connected(handle: str | None = None) -> HTMLResponse:
    account = html.escape(f"@{str(handle).lstrip('@')}" if handle else "Instagram account")
    launchpad = html.escape(f"{settings.frontend_url.rstrip('/')}/app/launchpad", quote=True)
    return HTMLResponse(
        """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark">
<title>Instagram connected</title><style>
*{box-sizing:border-box}html,body{min-height:100%;margin:0}body{display:grid;place-items:center;padding:24px;color:#f7f7fb;
font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#08090d;
background-image:radial-gradient(circle at 18% 12%,rgba(131,58,180,.22),transparent 32%),
radial-gradient(circle at 86% 82%,rgba(253,29,29,.13),transparent 34%),
radial-gradient(circle at 72% 10%,rgba(252,176,69,.1),transparent 24%)}
.card{position:relative;width:min(100%,480px);overflow:hidden;padding:34px;border:1px solid rgba(255,255,255,.11);border-radius:26px;
background:linear-gradient(145deg,rgba(24,25,32,.96),rgba(13,14,19,.98));box-shadow:0 30px 90px rgba(0,0,0,.48)}
.card:before{content:"";position:absolute;inset:0 0 auto;height:3px;background:linear-gradient(90deg,#833ab4,#fd1d1d,#fcb045)}
.brand{display:flex;align-items:center;gap:10px;color:#b9bbc6;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.brand-mark{display:grid;place-items:center;width:26px;height:26px;border:1px solid rgba(255,255,255,.14);
border-radius:9px;color:#fff;background:#181a22}
.hero{display:grid;place-items:center;margin:38px 0 25px}.ig{display:grid;place-items:center;width:82px;height:82px;border-radius:25px;
background:linear-gradient(145deg,#833ab4 5%,#c13584 38%,#e1306c 57%,#f77737 78%,#fcaf45);box-shadow:0 18px 44px rgba(193,53,132,.3)}
.check{position:absolute;transform:translate(31px,31px);display:grid;place-items:center;width:29px;height:29px;border:4px solid #111219;
border-radius:50%;background:#3ddc97;color:#07150f;font-size:15px;font-weight:900}
h1{margin:0;text-align:center;font-size:clamp(28px,7vw,38px);line-height:1.08;letter-spacing:-.04em}
p{margin:13px 0 0;text-align:center;color:#a9abb7;line-height:1.6}
.account{display:flex;align-items:center;justify-content:center;gap:9px;width:max-content;max-width:100%;
margin:24px auto 0;padding:10px 15px;border:1px solid rgba(255,255,255,.1);border-radius:999px;
background:rgba(255,255,255,.045);color:#f0f0f5;font-weight:650;overflow-wrap:anywhere}
.dot{width:7px;height:7px;border-radius:50%;background:#3ddc97;box-shadow:0 0 0 5px rgba(61,220,151,.1)}
.rule{height:1px;margin:28px 0 22px;background:rgba(255,255,255,.08)}
button{width:100%;padding:13px 18px;border:1px solid rgba(255,255,255,.12);border-radius:13px;
color:#f7f7fb;background:#242630;font:inherit;font-weight:700;cursor:pointer;
transition:transform .15s ease,background .15s ease}
button:hover{background:#2c2e39;transform:translateY(-1px)}button:focus-visible{outline:3px solid rgba(252,176,69,.55);outline-offset:2px}
.return{display:block;margin-top:12px;text-align:center;color:#d6c1ff;font-weight:700;text-decoration:none}
.return:hover{text-decoration:underline}.return:focus-visible{outline:3px solid rgba(252,176,69,.55);outline-offset:3px}
.hint{min-height:20px;margin-top:11px;font-size:12px;color:#777a87}
@media(max-width:520px){.card{padding:27px 22px;border-radius:22px}.hero{margin-top:31px}}
@media(prefers-reduced-motion:reduce){button{transition:none}}
</style></head><body><main class="card"><div class="brand"><span class="brand-mark">N</span><span>Notestack</span></div>
<div class="hero"><div class="ig" aria-hidden="true">
<svg width="45" height="45" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8">
<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/>
<circle cx="17.4" cy="6.7" r="1" fill="white" stroke="none"/></svg></div>
<span class="check" aria-hidden="true">✓</span></div><h1>Instagram connected</h1>
<p>The account is securely connected to the requesting Notestack workspace.</p><div class="account"><span class="dot"></span>""" +
        account +
        """</div><div class="rule"></div><button type="button" onclick="closeTab()">Close this tab</button>
""" + '<a class="return" href="' + launchpad + '">Return to Notestack</a>' + """
<p class="hint" id="hint">Setup is complete. No further action is needed.</p></main><script>
function closeTab(){window.close();setTimeout(()=>{
document.getElementById('hint').textContent='You can close this tab from your browser.'
},180)}
</script></body></html>"""
    )


def _instagram_expired(state: str) -> HTMLResponse:
    """Explain an expired signed link without trusting or accepting it for authorization."""
    expires_at: datetime | None = None
    try:
        saved = jwt.decode(state, settings.jwt_secret, algorithms=[settings.jwt_algorithm],
                           options={"verify_exp": False})
        if saved.get("typ") == "social_state" and saved.get("platform") == "instagram":
            expires_at = datetime.fromtimestamp(float(saved["exp"]), UTC)
    except (jwt.PyJWTError, KeyError, TypeError, ValueError, OverflowError):
        pass

    when = ""
    if expires_at:
        iso = expires_at.isoformat()
        when = (f'<p>This connection link expired at <time id="expiry" datetime="{iso}">{iso}</time>.</p>'
                "<script>const e=document.getElementById('expiry');"
                "e.textContent=new Date(e.dateTime).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'});</script>")
    return HTMLResponse(
        """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Instagram link expired</title></head><body style="font-family:system-ui;max-width:36rem;margin:12vh auto;padding:2rem">
<h1>Instagram connection link expired</h1>""" + when +
        "<p>Ask the Notestack workspace owner to create and send you a new link.</p></body></html>",
        status_code=410,
    )


def _facebook_connected(handle: str | None = None) -> HTMLResponse:
    page = html.escape(str(handle) if handle else "Facebook Page")
    launchpad = html.escape(f"{settings.frontend_url.rstrip('/')}/app/launchpad", quote=True)
    return HTMLResponse(
        """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark">
<title>Facebook connected</title><style>
*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:#08090d;
color:#f7f7fb;font-family:Inter,system-ui,sans-serif}.card{width:min(100%,460px);padding:34px;border:1px solid #ffffff1c;
border-radius:24px;background:#15171d;box-shadow:0 30px 90px #0008}.mark{display:grid;place-items:center;width:72px;height:72px;
margin:0 auto 24px;border-radius:22px;background:#1877f2;color:white;font:bold 56px/1 Arial}h1,p{text-align:center}h1{margin:0}
p{color:#a9abb7;line-height:1.6}.page{margin:22px auto;padding:10px 15px;width:max-content;max-width:100%;border-radius:999px;
background:#ffffff0c;color:#f5f6fa;font-weight:650;overflow-wrap:anywhere}button{width:100%;margin-top:12px;padding:13px;
border:1px solid #ffffff1f;border-radius:13px;background:#242630;color:white;font:inherit;font-weight:700;cursor:pointer}
a{display:block;margin-top:12px;text-align:center;color:#8dbdff;font-weight:700}</style></head><body><main class="card">
<div class="mark" aria-hidden="true">f</div><h1>Facebook connected</h1>
<p>The Page is securely connected to the requesting Notestack workspace.</p>
<div class="page">""" + page + """</div><button type="button" onclick="window.close()">Close this tab</button>
""" + '<a href="' + launchpad + '">Return to Notestack</a>' + """</main></body></html>"""
    )


def _client_of(state: str | None) -> str:
    """Who started the flow (the web app or the mobile app), read from its signed state; the web when unknown."""
    if not state:
        return "web"
    try:
        return "app" if decode_token_full(state, expected_type="social_state").get("client") == "app" else "web"
    except HTTPException:
        return "web"


@router.post("/social/{platform}/start")
def oauth_start(platform: Literal["x", "facebook", "instagram", "threads", "linkedin"], client: Literal["web", "app"] = "web",
                ctx: Ctx = Depends(get_ctx)):
    """Returns the provider URL. The SPA (or the mobile app, `client=app`) calls this with its bearer token, then opens
    `url`; the callback sends the ticket back to whichever started it."""
    _require_review_social_access(ctx, platform)
    mod = {"x": x, "facebook": facebook, "instagram": instagram, "threads": threads,
           "linkedin": linkedin}[platform]
    if not mod.configured():
        raise HTTPException(503, {"code": "not_configured",
                                  "message": f"Set {platform.upper()}_CLIENT_ID and {platform.upper()}_CLIENT_SECRET."})
    nonce = secrets.token_urlsafe(24)
    expires_at = datetime.now(UTC) + STATE_TTL
    payload = {"typ": "social_state", "nonce": nonce, "ws": str(ctx.workspace.id), "platform": platform, "client": client}
    if platform == "x":
        _, challenge = x.pkce_pair(nonce)
        state = encode_signed(payload, STATE_TTL)
        url = x.authorize_url(state, challenge)
    else:
        state = encode_signed(payload, STATE_TTL)
        url = mod.authorize_url(state)
    return {"url": url, "nonce": nonce, "expires_at": expires_at.isoformat()}


@router.get("/social/{platform}/callback")
def oauth_callback(platform: Literal["x", "facebook", "instagram", "threads", "linkedin"], code: str | None = None,
                   state: str | None = None,
                   error: str | None = None, db: Session = Depends(get_db)):
    label = PLATFORM_LABELS[platform]
    client = _client_of(state)
    if error:
        message = (f"{label} connection was cancelled." if error in ("access_denied", "user_cancelled")
                   else f"{label} authorization failed ({error}). Check its OAuth settings and try again.")
        return _launchpad_redirect(client, error=message)
    if not code or not state:
        return _launchpad_redirect(client, error=f"{label} connection was cancelled.")
    try:
        saved = decode_token_full(state, expected_type="social_state")
    except HTTPException:
        if platform == "instagram":
            return _instagram_expired(state)
        return _launchpad_redirect(client, error=f"{label} connection expired. Try again.")
    if saved.get("platform") != platform:
        return _launchpad_redirect(client, error=f"{label} connection failed.")
    try:
        if platform == "x":
            verifier = x.pkce_verifier(saved["nonce"])
            info = x.exchange_code(code, verifier)
        elif platform == "facebook":
            info = facebook.exchange_code(code)
        elif platform == "instagram":
            info = instagram.exchange_code(code)
        elif platform == "threads":
            info = threads.exchange_code(code)
        else:
            info = linkedin.exchange_code(code)
    except SocialError as exc:
        return _launchpad_redirect(client, error=str(exc))
    except Exception:
        return _launchpad_redirect(client, error=f"{label} connection failed. Try again.")
    # Meta asset links are intentionally shareable: a workspace owner can send the short-lived provider URL to the
    # person who controls the Page or Instagram account. The signed state is the authority for the destination, so
    # the recipient does not need a Notestack login and cannot choose a different workspace.
    if platform in ("facebook", "instagram"):
        try:
            workspace_id = uuid.UUID(saved["ws"])
        except (KeyError, TypeError, ValueError):
            return _launchpad_redirect(client, error=f"{label} connection failed.")
        if not db.get(Workspace, workspace_id):
            return _launchpad_redirect(client, error="The Notestack workspace no longer exists.")
        _upsert_account(db, workspace_id, platform, info, info["access_token"], info.get("refresh_token"),
                        info.get("expires_in"), info.get("scope"))
        return _instagram_connected(info.get("handle")) if platform == "instagram" else _facebook_connected(info.get("handle"))

    # Other providers still finish in the signed-in SPA, and only for the workspace that started the flow.
    # Only the fields the link needs: the ticket rides in the Location header, and LinkedIn's id_token
    # alone pushes it past the reverse proxy's header buffer (Nginx answers 502).
    info = {k: info[k] for k in LINK_FIELDS if info.get(k) is not None}
    ticket = encode_signed({"typ": "social_link", "ws": saved["ws"], "platform": platform,
                            "data": encrypt(json.dumps(info))}, timedelta(minutes=10))
    return _launchpad_redirect(client, link=ticket, platform=platform)


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

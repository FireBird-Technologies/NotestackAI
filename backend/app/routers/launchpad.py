"""Launchpad: the calendar, connected social accounts (OAuth / app password) and tracked short links."""

import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import Ctx, decode_token_full, encode_signed, get_ctx
from app.config import settings
from app.db import get_db
from app.models import Artifact, CalendarItem, Document, EngagementEvent, SocialAccount, TrackedLink
from app.services import launchpad as lp
from app.services.crypto import decrypt, encrypt
from app.services.social import AUTO_POST, LIMITS, PLATFORM_LABELS, SocialError, bluesky, linkedin, x

router = APIRouter(prefix="/api", tags=["launchpad"])

Platform = Literal["x", "linkedin", "bluesky", "substack_notes"]


# Calendar


class ItemIn(BaseModel):
    platform: Platform
    scheduled_at: datetime
    content: str = Field(min_length=1, max_length=10000)
    thread: list[str] = Field(default_factory=list, max_length=25)
    artifact_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    social_account_id: uuid.UUID | None = None
    remind_by_email: bool = False
    draft: bool = False


class ItemPatch(BaseModel):
    scheduled_at: datetime | None = None
    content: str | None = Field(None, min_length=1, max_length=10000)
    thread: list[str] | None = None
    social_account_id: uuid.UUID | None = None
    remind_by_email: bool | None = None
    status: Literal["scheduled", "draft"] | None = None


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def serialize_item(item: CalendarItem, account: SocialAccount | None = None, clicks: int = 0) -> dict:
    return {
        "id": str(item.id),
        "platform": item.platform,
        "platform_label": PLATFORM_LABELS.get(item.platform, item.platform),
        "scheduled_at": _aware(item.scheduled_at).isoformat(),
        "status": item.status,
        "content": item.content,
        "thread": item.thread or [],
        "artifact_id": str(item.artifact_id) if item.artifact_id else None,
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
    return [serialize_item(i, accounts.get(i.social_account_id), clicks.get(i.id, 0)) for i in items]


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
    account = _account(ctx, body.social_account_id, body.platform)
    _validate_lengths(body.platform, [body.content, *body.thread])
    for model, value in ((Artifact, body.artifact_id), (Document, body.document_id)):
        if value and not ctx.db.scalar(select(model.id).where(model.id == value,
                                                              model.workspace_id == ctx.workspace.id)):
            raise HTTPException(404, f"{model.__name__} not found")
    item = CalendarItem(
        workspace_id=ctx.workspace.id, platform=body.platform, scheduled_at=_aware(body.scheduled_at),
        content=body.content, thread=[t for t in body.thread if t.strip()], artifact_id=body.artifact_id,
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
    if body.scheduled_at is not None:
        item.scheduled_at = _aware(body.scheduled_at)
    if body.content is not None:
        item.content = body.content
    if body.thread is not None:
        item.thread = [t for t in body.thread if t.strip()]
    if "social_account_id" in body.model_fields_set:
        item.social_account_id = (_account(ctx, body.social_account_id, item.platform).id
                                  if body.social_account_id else None)
    if body.remind_by_email is not None:
        item.remind_by_email = body.remind_by_email
    if not item.social_account_id or item.platform not in AUTO_POST:
        item.remind_by_email = True
    if body.status is not None:
        item.status = body.status
    elif item.status in ("failed", "reminded"):
        item.status = "scheduled"
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
    await run_in_threadpool(lp.publish_item, ctx.db, item)
    return _enrich(ctx, [item])[0]


# Social accounts


def serialize_account(a: SocialAccount) -> dict:
    return {"id": str(a.id), "platform": a.platform, "platform_label": PLATFORM_LABELS[a.platform],
            "handle": a.handle, "status": a.status, "avatar_url": a.avatar_url,
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
    for item in ctx.db.scalars(select(CalendarItem).where(CalendarItem.social_account_id == account.id,
                                                          CalendarItem.status == "scheduled")):
        item.social_account_id = None
        item.remind_by_email = True
    ctx.db.delete(account)
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

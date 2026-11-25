"""Guests: the iOS app used without an account (App Store 5.1.1(v)).

A guest is a real user with a workspace and no personal details, so everything works on it unchanged. What it may use
for free belongs to the device (guest_devices): it is counted there, never resets, and is not given back by deleting
things, deleting the guest, reinstalling, or signing up. A guest who subscribes has that plan's own limits instead.
"""

import hashlib
import hmac
import logging
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.models import AuthProvider, Document, GuestDevice, Job, Subscription, User, Workspace
from app.services import device_check
from app.services.plans import GUEST_PLAN, effective_plan, plan_limit_error

log = logging.getLogger(__name__)

PLATFORM_HEADER = "x-client-platform"
EMAIL_DOMAIN = "guest.invalid"  # .invalid never resolves: nothing can be mailed there

# Free uses per device. The plan's own limits come from GUEST_PLAN; the ones after them have no plan limit at all.
LIMITS = {
    "chat_messages": GUEST_PLAN.chat_messages,
    "audio_overviews": GUEST_PLAN.audio_overviews,
    "reports": GUEST_PLAN.reports,
    "infographics": GUEST_PLAN.infographics,
    "launch_kits": GUEST_PLAN.launch_kits,
    "videos": GUEST_PLAN.videos,
    "video_edits": GUEST_PLAN.video_limits["ai_edits"],
    "voice_designs": 1,
    "voice_tries": 3,  # each makes three previews; the one voice is picked from them
    "study_items": 3,  # quizzes, flashcards, mind maps, slide decks and everything else made from posts
    "extras": 20,  # voice previews and post writing help
}
KINDS = {"audio_overview": "audio_overviews", "report": "reports", "infographic": "infographics", "launch_kit": "launch_kits"}
RESERVED = "guest_reserved"  # job param: what the job took from the allowance, given back if it fails

VERIFIED_PER_IP_HOUR, UNVERIFIED_PER_IP_HOUR = 500, 50
INACTIVE_AFTER = timedelta(days=90)

_made: dict[str, deque] = defaultdict(deque)


def from_ios(request: Request) -> bool:
    return request.headers.get(PLATFORM_HEADER, "").strip().lower() == "ios"


def client_ip(request: Request) -> str:
    """The caller's address. nginx appends the address it saw to X-Forwarded-For, so only the last entry is ours: the
    ones before it are whatever the caller sent."""
    forwarded = [p.strip() for p in (request.headers.get("x-forwarded-for") or "").split(",") if p.strip()]
    return forwarded[-1] if forwarded else (request.client.host if request.client else "?")


def is_guest(user: User | None) -> bool:
    return bool(user and user.auth_provider == AuthProvider.GUEST)


def _hash(device_id: str) -> str:
    return hmac.new(settings.jwt_secret.encode(), f"guest-device:{device_id}".encode(), hashlib.sha256).hexdigest()


# Opening a guest session


@dataclass
class Opened:
    user: User
    created: bool
    allowance: bool  # False: this device's free allowance was taken before
    verified: bool


def _check_caps(db: Session, ip: str, verified: bool) -> None:
    """New guests from one address an hour, and in all a day: what an unverified device could cost is kept small."""
    # Local development only (a server given a DeviceCheck key is not): the simulator is never verified.
    if settings.env == "development" and not settings.devicecheck_configured:
        return
    now, window = time.monotonic(), _made[ip]
    while window and now - window[0] > 3600:
        window.popleft()
    day = datetime.now(UTC) - timedelta(days=1)
    today = select(func.count()).select_from(GuestDevice).where(GuestDevice.created_at > day)
    if verified:
        per_ip, full = VERIFIED_PER_IP_HOUR, (db.scalar(today) or 0) >= settings.guest_daily_cap
    else:
        per_ip = UNVERIFIED_PER_IP_HOUR
        full = (db.scalar(today.where(GuestDevice.verified.is_(False))) or 0) >= settings.guest_daily_cap_unverified
    if full or len(window) >= per_ip:
        log.warning("guest refused: %s", "daily cap" if full else "too many from one address")
        raise HTTPException(429, {"code": "guest_busy",
                                  "message": "Guest access is busy right now. Try again later, or create a free account."})
    window.append(now)


def _ask_apple(device_token: str | None) -> tuple[bool, int]:
    """(verified, the epoch Apple has for this device)."""
    if not device_token:
        return False, 0
    try:
        return True, device_check.read(device_token)
    except device_check.DeviceCheckInvalid as exc:
        log.warning("guest refused: DeviceCheck token not valid (%s)", exc)
        raise HTTPException(403, {"code": "device_invalid", "message": "This device could not be confirmed."}) from exc
    except device_check.DeviceCheckUnavailable as exc:
        log.error("DeviceCheck unavailable, falling back to the device id: %s", exc)
        return False, 0


def _indexed_posts(db: Session, owner_id: uuid.UUID | None) -> int:
    if not owner_id:
        return 0
    return db.scalar(select(func.count()).select_from(Document).join(Workspace, Workspace.id == Document.workspace_id)
                     .where(Workspace.owner_id == owner_id, Document.path.is_not(None))) or 0


def _live_guest(db: Session, device: GuestDevice) -> User | None:
    user = db.get(User, device.guest_id) if device.guest_id else None
    return user if is_guest(user) and user.is_active and not user.deleted_at else None


def open_guest(db: Session, *, device_id: str, device_token: str | None, ip: str) -> Opened:
    """The guest of this device: the one it had, else a new one, with the free allowance only the first time."""
    from app.services.auth_identity import create_guest_user

    device_hash = _hash(device_id)
    verified, apple_epoch = _ask_apple(device_token)
    epoch = settings.guest_epoch
    device = db.scalar(select(GuestDevice).where(GuestDevice.device_hash == device_hash))
    guest = _live_guest(db, device) if device else None
    if guest is None:
        _check_caps(db, ip, verified)
    if device is None:
        device = GuestDevice(device_hash=device_hash, epoch=epoch, exhausted=apple_epoch >= epoch)
        db.add(device)
        try:
            db.flush()
        except IntegrityError:  # the same phone asked twice at once: the other request made it
            db.rollback()
            raise HTTPException(409, {"code": "guest_retry", "message": "Try again."}) from None
    elif device.epoch < epoch:  # a new round of allowances (GUEST_EPOCH was raised), unless Apple says it was taken
        for kind in LIMITS:
            setattr(device, kind, 0)
        device.posts = -_indexed_posts(db, device.guest_id if guest else None)  # what is stored now does not count
        device.epoch, device.exhausted = epoch, apple_epoch >= epoch
    elif guest is None:
        device.exhausted = True  # its guest was deleted or became an account: the allowance went with it
    device.verified = device.verified or verified
    created = guest is None
    if guest is None:
        guest = create_guest_user(db)
        device.guest_id = guest.id
    guest.last_login_at = datetime.now(UTC)
    db.commit()
    if verified and apple_epoch < epoch:
        try:
            device_check.write(device_token or "", epoch)
        except (device_check.DeviceCheckInvalid, device_check.DeviceCheckUnavailable) as exc:
            # Written the next time this device opens a guest session; its row here still holds the allowance.
            log.error("DeviceCheck could not be written: %s", exc)
            verified = False
    if not created:
        _recheck_plan(db, guest)
    return Opened(guest, created, not device.exhausted, verified)


def _recheck_plan(db: Session, guest: User) -> None:
    """A guest coming back may have moved their subscription to an account meanwhile (Restore purchases there)."""
    from app.services import revenuecat
    from app.services.billing import billed_by

    sub = db.scalar(select(Subscription).join(Workspace, Workspace.id == Subscription.workspace_id)
                    .where(Workspace.owner_id == guest.id))
    if sub and billed_by(sub) and settings.billing_enabled and settings.revenuecat_secret_key:
        revenuecat.recheck(db, sub.workspace_id)


# The allowance


def device_of(db: Session, workspace_id: uuid.UUID) -> GuestDevice | None:
    return db.scalar(select(GuestDevice).join(Workspace, Workspace.owner_id == GuestDevice.guest_id)
                     .where(Workspace.id == workspace_id).execution_options(populate_existing=True))


def used(device: GuestDevice | None, kind: str) -> int:
    limit = LIMITS[kind]
    return limit if device is None or device.exhausted else min(getattr(device, kind), limit)


def reserve(db: Session, workspace: Workspace, kind: str) -> bool:
    """Take one from the allowance, in one statement so two requests at once can't both take the last. The caller
    commits (or rolls back, which gives it back)."""
    column = getattr(GuestDevice, kind)
    result = db.execute(
        update(GuestDevice)
        .where(GuestDevice.guest_id == workspace.owner_id, GuestDevice.exhausted.is_(False), column < LIMITS[kind])
        .values({kind: column + 1}).execution_options(synchronize_session=False)
    )
    return bool(result.rowcount)


def limit_error(kind: str) -> HTTPException:
    label = {"study_items": "study items", "extras": "previews", "video_edits": "AI video edits",
             "voice_designs": "voice designs", "voice_tries": "voice designs"}.get(kind, kind.replace("_", " "))
    err = plan_limit_error(GUEST_PLAN, kind, f"You have used all the free {label} on this iPhone.")
    err.detail["limit"] = LIMITS[kind]
    return err


def take(db: Session, workspace: Workspace, kind: str) -> dict:
    """For things with no plan limit: an unpaid guest takes one from the allowance (402 when none is left), anyone else
    nothing. Returns the job params that record it."""
    if effective_plan(db, workspace).id != GUEST_PLAN.id:
        return {}
    if not reserve(db, workspace, kind):
        raise limit_error(kind)
    return {RESERVED: kind}


def reserved(db: Session, workspace: Workspace, artifact_type: str) -> dict:
    """The job params for an artifact whose allowance check_limit has already taken; takes it for the types with no
    plan limit of their own."""
    kind = KINDS.get(artifact_type)
    if kind is None:
        return take(db, workspace, "study_items")
    return {RESERVED: kind} if effective_plan(db, workspace).id == GUEST_PLAN.id else {}


def retry_params(db: Session, workspace: Workspace, params: dict) -> dict:
    """Running a job again takes from the allowance again (a failed run gave its own back)."""
    kind = (params or {}).get(RESERVED)
    clean = {k: v for k, v in (params or {}).items() if k != RESERVED}
    return {**clean, **take(db, workspace, kind)} if kind else clean


def give_back(db: Session, job: Job) -> None:
    """A generation that failed for good does not use up the allowance."""
    kind = (job.params or {}).get(RESERVED)
    if kind in LIMITS:
        unreserve(db, job.workspace_id, kind)
        db.commit()


def unreserve(db: Session, workspace_id: uuid.UUID, kind: str) -> None:
    """Give one back to the workspace's device. Nothing for anyone but a guest. The caller commits."""
    column = getattr(GuestDevice, kind)
    owner = select(Workspace.owner_id).where(Workspace.id == workspace_id).scalar_subquery()
    db.execute(update(GuestDevice).where(GuestDevice.guest_id == owner, column > 0).values({kind: column - 1})
               .execution_options(synchronize_session=False))


def on_guest_plan(db: Session, workspace_id: uuid.UUID) -> bool:
    """A guest with no subscription: what they use is the device's."""
    workspace = db.get(Workspace, workspace_id)
    return bool(workspace) and effective_plan(db, workspace).id == GUEST_PLAN.id


def posts_removed(db: Session, workspace: Workspace, count: int) -> None:
    """Removing an indexed post does not make room for another one."""
    if count and effective_plan(db, workspace).id == GUEST_PLAN.id:
        db.execute(update(GuestDevice).where(GuestDevice.guest_id == workspace.owner_id)
                   .values(posts=GuestDevice.posts + count).execution_options(synchronize_session=False))


def post_limit(db: Session, workspace_id: uuid.UUID) -> int:
    """How many indexed posts this guest may hold now: the allowance less what was indexed and removed."""
    device = device_of(db, workspace_id)
    if device is None or device.exhausted:
        return 0
    return max(GUEST_PLAN.indexed_posts - device.posts, 0)


# Leaving


def release(db: Session, user: User) -> None:
    """The guest is now an account: the device keeps what it used, and no longer points at anyone."""
    db.execute(update(GuestDevice).where(GuestDevice.guest_id == user.id).values(guest_id=None, exhausted=True)
               .execution_options(synchronize_session=False))


def retire_inactive(db: Session, now: datetime | None = None) -> int:
    """Guests nobody came back to: erased like a deletion from the app. One with a paid plan is left alone."""
    from app.services.auth_identity import soft_delete

    cutoff = (now or datetime.now(UTC)) - INACTIVE_AFTER
    paid = select(Workspace.owner_id).join(Subscription, Subscription.workspace_id == Workspace.id).where(
        Subscription.plan != "free", Subscription.status.in_(("active", "trialing", "past_due")))
    stale = db.scalars(select(User).where(
        User.auth_provider == AuthProvider.GUEST, User.deleted_at.is_(None), User.last_login_at < cutoff,
        User.id.not_in(paid))).all()
    for user in stale:
        soft_delete(db, user)
        user.erase_requested_at = datetime.now(UTC)
    db.commit()
    return len(stale)

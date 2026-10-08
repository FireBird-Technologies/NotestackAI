"""Launchpad: publishes due calendar items (with the images or video of the artifact they were made from), emails
reminders for platforms without an API, rewrites links to tracked short links and pulls engagement back in.

Due items are published by a "publish_post" job each, not inside the worker's 30 second tick: a video upload and the
platform's processing can take minutes."""

import logging
import re
import secrets
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.models import Artifact, CalendarItem, Document, EngagementEvent, SocialAccount, TrackedLink, User, Workspace
from app.services.email import email_service
from app.services.jobs import create_job
from app.services.social import AUTO_POST, PLATFORM_LABELS, SocialError, module
from app.services.social.health import mark_down
from app.services.social.media import carries_media, media_count, media_for

log = logging.getLogger("notestack.launchpad")
_URL = re.compile(r"https?://[^\s)\]>]+")
MAX_ATTEMPTS = 3
STUCK_AFTER = timedelta(minutes=30)  # longer than a video upload and the platform's processing take


def _public_api() -> bool:
    return not re.search(r"//(localhost|127\.0\.0\.1|api)(:|/|$)", settings.api_url)


def track_links(db: Session, item: CalendarItem, text: str) -> str:
    """Swap outbound links for {API_URL}/l/{slug} so clicks are counted. Skipped when the API is not public."""
    if not _public_api():
        return text
    base = f"{settings.api_url.rstrip('/')}/l/"

    def swap(m: re.Match) -> str:
        url = m.group(0)
        if url.startswith(base):
            return url
        link = TrackedLink(workspace_id=item.workspace_id, slug=secrets.token_urlsafe(5)[:7], target_url=url,
                           calendar_item_id=item.id)
        db.add(link)
        return base + link.slug

    return _URL.sub(swap, text)


def owner_email(db: Session, workspace_id) -> str | None:
    ws = db.get(Workspace, workspace_id)
    user = db.get(User, ws.owner_id) if ws else None
    return user.email if user and user.is_active else None


def publish_item(db: Session, item: CalendarItem) -> CalendarItem:
    """Publish or remind now. Leaves the item posted, reminded, failed, or scheduled again for a retry."""
    posts = [p for p in [item.content, *(item.thread or [])] if p and p.strip()]
    if not posts and carries_media(db.get(Artifact, item.artifact_id) if item.artifact_id else None):
        posts = [""]  # a video or images on their own: the post goes out without a caption
    if not posts:
        item.status, item.error = "failed", "Nothing to post."
        db.commit()
        return item
    account = db.get(SocialAccount, item.social_account_id) if item.social_account_id else None
    label = PLATFORM_LABELS.get(item.platform, item.platform)
    if item.platform in ("x", "linkedin") and not item.remind_by_email and (not account or account.status != "active"):
        # The connection is down: never attempted; it resumes when the account is reconnected.
        item.status, item.error = "paused", f"{label} disconnected. Reconnect {label} to resume."
        db.commit()
        return item
    if item.platform not in AUTO_POST or item.remind_by_email or not account:
        to = owner_email(db, item.workspace_id)
        sent = bool(to) and email_service.send_post_reminder(
            to, label, "\n\n".join(posts), f"{settings.frontend_url}/app/launchpad?item={item.id}")
        item.status = "reminded" if sent else "failed"
        item.error = None if sent else "Could not send the reminder email."
        item.posted_at = datetime.now(UTC)
        db.commit()
        return item
    item.attempts += 1
    try:
        tracked = [track_links(db, item, p) for p in posts]
        db.flush()
        artifact = db.get(Artifact, item.artifact_id) if item.artifact_id else None
        if artifact and media_count(artifact) and item.platform in ("x", "linkedin") \
                and not module(item.platform).can_post_media(account):
            # Scheduled before the account lost the right to post media: held, not attempted, until reconnected.
            item.status, item.error = "paused", f"Reconnect {label} to post images and videos."
            db.commit()
            return item
        with media_for(artifact, item.platform) as media:  # temporary video files go when this ends
            external_id, url = module(item.platform).publish(db, account, tracked, media)
    except SocialError as exc:
        if exc.reconnect:  # the platform refused the connection: it is down, and its posts pause
            mark_down(db, account, "expired", str(exc))
            item.status, item.error = "paused", str(exc)[:1000]
            db.commit()
            return item
        _fail_or_retry(db, item, str(exc), exc.permanent)
        return item
    except Exception as exc:  # network trouble: retry
        log.exception("publish failed for %s", item.id)
        _fail_or_retry(db, item, f"{type(exc).__name__}: {exc}", False)
        return item
    item.status, item.error = "posted", None
    item.external_id, item.external_url, item.posted_at = external_id, url, datetime.now(UTC)
    if item.document_id:
        doc = db.get(Document, item.document_id)
        if doc:
            doc.last_resurfaced_at = item.posted_at
    db.commit()
    return item


def _fail_or_retry(db: Session, item: CalendarItem, error: str, permanent: bool) -> None:
    item.error = error[:1000]
    if permanent or item.attempts >= MAX_ATTEMPTS:
        item.status = "failed"
    else:
        item.status = "scheduled"
        item.scheduled_at = datetime.now(UTC) + timedelta(minutes=5 * item.attempts)
    db.commit()


def has_media(db: Session, item: CalendarItem) -> bool:
    """The post uploads images or a video (slow: it goes through a job, also for Publish now)."""
    artifact = db.get(Artifact, item.artifact_id) if item.artifact_id else None
    return bool(artifact) and item.platform in ("x", "linkedin") and media_count(artifact) > 0


def queue_publish(db: Session, item: CalendarItem) -> None:
    """Hand the (already claimed, "publishing") item to a worker job."""
    create_job(db, item.workspace_id, "publish_post", {"item_id": str(item.id)}, max_attempts=1)


def publish_job(db: Session, item_id: str) -> CalendarItem | None:
    """The publish_post job: publish the item if it is still waiting for it."""
    item = db.get(CalendarItem, uuid.UUID(str(item_id)))
    if not item or item.status != "publishing":
        return item
    item.updated_at = datetime.now(UTC)  # the stuck limit counts from the job's start, not the claim
    db.commit()
    return publish_item(db, item)


def publish_due(session_factory: Callable[[], Session] = SessionLocal) -> int:
    """Claim the due items and queue a publish_post job for each. Returns how many were queued."""
    now = datetime.now(UTC)
    with session_factory() as db:
        # A job that died mid publish leaves its item in "publishing"; put it back once that has clearly happened.
        for stuck in db.scalars(select(CalendarItem).where(
                CalendarItem.status == "publishing", CalendarItem.updated_at < now - STUCK_AFTER)):
            stuck.status = "scheduled"
        due = db.scalars(
            select(CalendarItem).where(CalendarItem.status == "scheduled", CalendarItem.scheduled_at <= now)
            .order_by(CalendarItem.scheduled_at).limit(50)
        ).all()
        for item in due:
            item.status = "publishing"  # claim, so an overlapping tick skips it
        db.commit()
        for item in due:
            queue_publish(db, item)
        return len(due)


def clicks_by_item(db: Session, item_ids: list) -> dict:
    if not item_ids:
        return {}
    rows = db.execute(
        select(TrackedLink.calendar_item_id, func.count(EngagementEvent.id))
        .join(EngagementEvent, EngagementEvent.tracked_link_id == TrackedLink.id)
        .where(TrackedLink.calendar_item_id.in_(item_ids), EngagementEvent.kind == "click")
        .group_by(TrackedLink.calendar_item_id)
    ).all()
    return {item_id: n for item_id, n in rows}


def sync_engagement(session_factory: Callable[[], Session] = SessionLocal) -> int:
    since = datetime.now(UTC) - timedelta(days=30)
    updated = 0
    with session_factory() as db:
        items = db.scalars(
            select(CalendarItem).where(CalendarItem.status == "posted", CalendarItem.posted_at >= since,
                                       CalendarItem.external_id.is_not(None))
        ).all()
        for item in items:
            account = db.get(SocialAccount, item.social_account_id) if item.social_account_id else None
            if not account:
                continue
            try:
                data = module(item.platform).metrics(db, account, item.external_id)
            except Exception:
                log.warning("metrics failed for %s", item.id, exc_info=True)
                continue
            if data:
                item.metrics = {**(item.metrics or {}), **data, "synced_at": datetime.now(UTC).isoformat()}
                updated += 1
        db.commit()
    return updated

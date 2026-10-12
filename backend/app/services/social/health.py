"""Keeping X and LinkedIn connected, and what happens to scheduled posts when a connection goes down.

A connection that is down (expired, revoked on the platform, or disconnected here) pauses every post scheduled through
it: paused posts are never attempted (publish_due only takes "scheduled" ones). Reconnecting the same account resumes
the ones still ahead; posts whose time passed meanwhile stay paused, for a new time to be picked.

social_health (every 10 minutes, worker.PERIODIC) refreshes X tokens before they expire, refreshes LinkedIn tokens
where LinkedIn gave a refresh token, marks expired LinkedIn connections down, and every 6 hours asks each platform
once whether the connection still works (it catches access revoked on x.com or linkedin.com)."""

import logging
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import CalendarItem, SocialAccount
from app.services.social import PLATFORM_LABELS, SocialError, module

log = logging.getLogger("notestack.social")

ACTIVE_STATES = ("scheduled", "draft", "failed")  # what a dropped connection pauses
LIVENESS_EVERY = 6 * 3600  # seconds between "is this connection still accepted" calls per account
X_REFRESH_AHEAD = timedelta(minutes=15)  # X access tokens last 2 hours: refresh before they lapse
LINKEDIN_REFRESH_AHEAD = timedelta(days=7)
_last_checked: dict[uuid.UUID, float] = {}  # account id -> monotonic time of its last liveness call


def _aware(dt: datetime | None) -> datetime | None:
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=UTC)


def pause_account_posts(db: Session, account: SocialAccount, reason: str) -> int:
    """Pause every post still to go out through this account. The caller commits."""
    items = db.scalars(select(CalendarItem).where(CalendarItem.social_account_id == account.id,
                                                  CalendarItem.status.in_(ACTIVE_STATES))).all()
    for item in items:
        item.status, item.error = "paused", reason
    return len(items)


def mark_down(db: Session, account: SocialAccount, status: str, reason: str | None = None) -> None:
    """The connection is gone (expired | revoked): mark it and pause its posts."""
    label = PLATFORM_LABELS.get(account.platform, account.platform)
    account.status = status
    paused = pause_account_posts(db, account, reason or f"{label} disconnected. Reconnect {label} to resume.")
    db.commit()
    log.info("%s account %s is %s; paused %d posts", account.platform, account.id, status, paused)


def resume_account_posts(db: Session, account: SocialAccount) -> None:
    """After a reconnect: paused posts still ahead go back to scheduled; missed ones stay paused. Caller commits."""
    now = datetime.now(UTC)
    for item in db.scalars(select(CalendarItem).where(CalendarItem.social_account_id == account.id,
                                                      CalendarItem.status == "paused")):
        if _aware(item.scheduled_at) > now:
            item.status, item.error, item.attempts = "scheduled", None, 0
        else:
            item.error = "Missed while disconnected: pick a new time."


def _due_for_refresh(account: SocialAccount) -> bool:
    expires = _aware(account.expires_at)
    if not expires:
        return False
    ahead = X_REFRESH_AHEAD if account.platform == "x" else LINKEDIN_REFRESH_AHEAD
    return expires - ahead <= datetime.now(UTC)


def check_account(db: Session, account: SocialAccount) -> None:
    """Refresh what is about to expire, mark down what is gone, and now and then ask the platform."""
    mod = module(account.platform)
    expires = _aware(account.expires_at)
    try:
        if _due_for_refresh(account):
            if account.refresh_token:
                mod.refresh(db, account)
            elif expires and expires <= datetime.now(UTC):
                raise SocialError("expired", reconnect=True)
        if time.monotonic() - _last_checked.get(account.id, -LIVENESS_EVERY) >= LIVENESS_EVERY:
            mod.check_alive(db, account)
            _last_checked[account.id] = time.monotonic()
    except SocialError as exc:
        if exc.reconnect:
            mark_down(db, account, "revoked" if "no longer accepts" in str(exc) else "expired")
        else:
            log.warning("%s check for %s: %s", account.platform, account.id, exc)
    except Exception:  # network trouble: try again next round
        log.warning("%s check for %s failed", account.platform, account.id, exc_info=True)


def social_health(session_factory: Callable[[], Session] = SessionLocal) -> int:
    """Every active X and LinkedIn connection, checked. Returns how many were looked at."""
    with session_factory() as db:
        accounts = db.scalars(select(SocialAccount).where(SocialAccount.status == "active",
                                                          SocialAccount.platform.in_(("x", "linkedin")))).all()
        for account in accounts:
            check_account(db, account)
        return len(accounts)

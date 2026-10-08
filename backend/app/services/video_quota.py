"""Video allowance, kept on the workspace's subscriptions row and enforced only by us.

blog2video charges every video to our own account; it does not know our workspaces. So we:
- reserve one video (videos_used + 1, only while below video_limit) before asking blog2video for it;
- refund it exactly once if the create is refused or generation fails (the b2v_videos row records which);
- keep video_plan and video_limit equal to the effective plan, and set videos_used back to 0 each month on plans
  with a monthly allowance: on Stripe renewal (invoice.paid, see stripe_billing.handle_event), and monthly for
  workspaces with no renewal to wait for (billing disabled, annual plans between renewals).
- Free's allowance is a lifetime total (plan.videos_monthly False): never reset. When a workspace drops to such a
  plan, videos_used becomes its lifetime count of videos that were not refunded.

videos_used is only ever written with a single SQL UPDATE here, never through the ORM, so a sync can not
overwrite a concurrent reserve or refund.
"""

import calendar
import logging
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import case, func, select, update
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal
from app.models import Artifact, B2VVideo, Subscription, Workspace
from app.services import blog2video as b2v
from app.services.plans import PLANS, effective_plan

log = logging.getLogger(__name__)

LIVE = {"active", "trialing", "past_due"}
RENEWAL_WINDOW = timedelta(days=45)  # a Stripe renewal this close to the period start does the reset instead
FAILED = {"failed", "error"}
FINISHED = {"generated", "done"}
SWEEP_AFTER = timedelta(minutes=30)  # the sweep only looks at videos older than this (users who closed the tab)


def add_month(when: datetime) -> datetime:
    year, month = (when.year + 1, 1) if when.month == 12 else (when.year, when.month + 1)
    return when.replace(year=year, month=month, day=min(when.day, calendar.monthrange(year, month)[1]))


def _aware(when: datetime | None) -> datetime | None:
    return when.replace(tzinfo=UTC) if when and when.tzinfo is None else when


def _row(db: Session, workspace_id: uuid.UUID) -> Subscription:
    sub = db.scalar(select(Subscription).where(Subscription.workspace_id == workspace_id))
    if not sub:
        sub = Subscription(workspace_id=workspace_id, plan="free", status="active")
        db.add(sub)
        db.flush()
    return sub


def sync_video_quota(db: Session, workspace: Workspace) -> Subscription:
    """Make video_plan and video_limit match the workspace's effective plan. Cheap when nothing changed."""
    plan = effective_plan(db, workspace)
    sub = _row(db, workspace.id)
    changed = False
    if sub.video_plan != plan.id and not plan.videos_monthly:
        # Onto a lifetime allowance: everything made so far counts (a Writer who made 10 can't make more on Free).
        made = db.scalar(select(func.count(B2VVideo.id)).where(B2VVideo.workspace_id == workspace.id,
                                                               B2VVideo.quota_state != "refunded")) or 0
        db.execute(update(Subscription).where(Subscription.id == sub.id).values(videos_used=made))
        changed = True
    if sub.video_plan != plan.id or sub.video_limit != plan.videos:
        sub.video_plan, sub.video_limit = plan.id, plan.videos
        changed = True
    if sub.videos_period_start is None:
        sub.videos_period_start = datetime.now(UTC)
        changed = True
    if changed:
        db.commit()
    return sub


def _renews_by_stripe(sub: Subscription) -> bool:
    start, end = _aware(sub.videos_period_start), _aware(sub.current_period_end)
    return bool(sub.provider_subscription_id and sub.status in LIVE and start and end
                and end <= start + RENEWAL_WINDOW)


def monthly(sub: Subscription) -> bool:
    plan = PLANS.get(sub.video_plan)
    return plan.videos_monthly if plan else True


def resets_at(sub: Subscription) -> datetime | None:
    start = _aware(sub.videos_period_start)
    if not start or not monthly(sub):
        return None
    return _aware(sub.current_period_end) if _renews_by_stripe(sub) else add_month(start)


def video_usage(db: Session, workspace: Workspace) -> dict:
    sub = sync_video_quota(db, workspace)
    db.refresh(sub)  # videos_used changes under us (reserves and refunds from other requests)
    reset = resets_at(sub)
    start = _aware(sub.videos_period_start)
    return {"used": sub.videos_used, "limit": sub.video_limit, "plan": sub.video_plan,
            "period_start": start.isoformat() if start else None, "resets_at": reset.isoformat() if reset else None}


def reset_videos(db: Session, workspace_id: uuid.UUID, at: datetime | None = None) -> None:
    db.execute(update(Subscription).where(Subscription.workspace_id == workspace_id)
               .values(videos_used=0, videos_period_start=at or datetime.now(UTC)))
    db.commit()


def reset_due_video_periods(session_factory: Callable[[], Session] = SessionLocal) -> int:
    """Monthly reset for workspaces a Stripe renewal will not reset in time. Runs from the worker's PERIODIC list."""
    now = datetime.now(UTC)
    count = 0
    with session_factory() as db:
        for sub in db.scalars(select(Subscription)):
            start = _aware(sub.videos_period_start)
            if start is None or _renews_by_stripe(sub) or not monthly(sub):
                continue
            if add_month(start) <= now:
                reset_videos(db, sub.workspace_id, now)
                count += 1
    return count


def reserve(db: Session, workspace_id: uuid.UUID) -> bool:
    """Take one video from the allowance, atomically: two requests can not both take the last one.
    False = none left (do not call blog2video)."""
    taken = db.execute(update(Subscription)
                       .where(Subscription.workspace_id == workspace_id,
                              Subscription.videos_used < Subscription.video_limit)
                       .values(videos_used=Subscription.videos_used + 1)).rowcount
    db.commit()
    return taken == 1


def unreserve(db: Session, workspace_id: uuid.UUID) -> None:
    """Give back a reservation that never got a b2v_videos row."""
    db.execute(update(Subscription).where(Subscription.workspace_id == workspace_id)
               .values(videos_used=case((Subscription.videos_used > 0, Subscription.videos_used - 1), else_=0)))
    db.commit()


def refund(db: Session, row: B2VVideo, status: str | None = None) -> bool:
    """Give the workspace its video back, exactly once per row, however many callers race here, and never once
    it finished generating ('kept'). True if this call did the refund."""
    values = {"quota_state": "refunded", "updated_at": datetime.now(UTC)}
    if status:
        values["status"] = status
    won = db.execute(update(B2VVideo).where(B2VVideo.id == row.id, B2VVideo.quota_state == "charged")
                     .values(**values)).rowcount == 1
    if won:
        db.execute(update(Subscription).where(Subscription.workspace_id == row.workspace_id)
                   .values(videos_used=case((Subscription.videos_used > 0, Subscription.videos_used - 1),
                                            else_=0)))
    db.commit()
    db.refresh(row)
    return won


def record_status(db: Session, row: B2VVideo, status: str) -> None:
    """Remember blog2video's latest status, refunding when it says the video failed. Once generation finished the
    charge is kept (quota_state 'kept'): a later failed edit does not give the video back."""
    if status in FAILED:
        refund(db, row, "failed")
    elif status and row.status != status:
        values = {"status": status, "updated_at": datetime.now(UTC)}
        if status in FINISHED:
            values["quota_state"] = case((B2VVideo.quota_state == "charged", "kept"), else_=B2VVideo.quota_state)
        db.execute(update(B2VVideo).where(B2VVideo.id == row.id).values(**values))
        db.commit()
        db.refresh(row)


def sweep_failed_videos(session_factory: Callable[[], Session] = SessionLocal) -> int:
    """Refund videos that failed while nobody was polling (the user closed the tab). Runs from PERIODIC."""
    if not b2v.configured():
        return 0
    cutoff = datetime.now(UTC) - SWEEP_AFTER
    refunded = 0
    with session_factory() as db:
        rows = db.scalars(select(B2VVideo).where(B2VVideo.quota_state == "charged",
                                                 B2VVideo.status.not_in(FINISHED),
                                                 B2VVideo.created_at < cutoff)).all()
        for row in rows:
            if row.b2v_video_id is None:
                # The create never got an answer and the request died before refunding.
                refunded += refund(db, row, "failed")
                continue
            try:
                s = b2v.status(row.b2v_video_id, row.created_via)
            except b2v.NotFound:
                s = {"status": "failed", "error": "Video not found"}
            except b2v.B2VError as e:
                log.warning("video sweep: status of %s failed: %s", row.b2v_video_id, e)
                continue
            raw = str(s.get("status") or "")
            if s.get("error") and raw not in FAILED:
                raw = "failed"
            if raw in FAILED:
                refunded += refund(db, row, "failed")
                if row.artifact_id and (a := db.get(Artifact, row.artifact_id)):
                    a.status = "failed"
                    a.content_json = {**(a.content_json or {}), "b2v_status": raw, "error": s.get("error")}
                    db.commit()
            elif raw:
                record_status(db, row, raw)
    return refunded


AI_EDITS_ALERT_BELOW = 200
TEMPLATE_SLOTS_ALERT_BELOW = 3


def check_capacity() -> dict | None:
    """Alert when our blog2video account runs low: our workspaces' limits added up can exceed it. Hourly."""
    if not b2v.configured():
        return None
    try:
        account = b2v.account() or {}
    except b2v.B2VError as e:
        log.error("ALERT blog2video capacity check failed: %s", e)
        return None
    low = []
    limit, used = account.get("video_limit"), account.get("videos_used_this_period")
    if not account.get("can_create_video") or (
            limit is not None and used is not None and limit - used < settings.b2v_capacity_alert_below):
        low.append(f"videos {used}/{limit} used")
    ai = (account.get("ai_edit_allowance_remaining") or 0) + (account.get("ai_edit_credits") or 0)
    if ai < AI_EDITS_ALERT_BELOW:
        low.append(f"{ai} AI edits left")
    slots, made = account.get("custom_template_limit"), account.get("custom_templates_created")
    if slots is not None and made is not None and slots - made < TEMPLATE_SLOTS_ALERT_BELOW:
        low.append(f"template slots {made}/{slots} used")
    if low:
        log.error("ALERT blog2video account (plan %s) is running low: %s", account.get("plan"), "; ".join(low))
    return account

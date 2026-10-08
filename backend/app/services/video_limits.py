"""Per-workspace shares of what blog2video only limits account-wide: AI edits, custom templates, template AI
operations (plans.VIDEO_LIMITS).

blog2video checks every limit against our own (Pro) account, so every workspace passes its checks. These counters
stop a workspace before it uses up everyone's share. Videos themselves are counted in video_quota.py.

A take is one conditional UPDATE (used + n <= limit), so two requests can not both take the last unit.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import case, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import UsageCounter, Workspace
from app.services.plans import VIDEO_LIMITS, Plan, effective_plan, plan_limit_error

LABELS = {
    "ai_edits": ("AI edits", "this month"),
    "templates": ("custom templates", "in total"),
    "template_ai_daily": ("AI template steps", "today"),
}


def period_key(metric: str, now: datetime | None = None) -> str:
    now = now or datetime.now(UTC)
    kind = VIDEO_LIMITS[metric]
    return now.strftime("%Y-%m-%d") if kind == "day" else now.strftime("%Y-%m") if kind == "month" else "all"


def _ensure_row(db: Session, workspace_id: uuid.UUID, period: str, metric: str) -> None:
    key = {"workspace_id": workspace_id, "period": period, "metric": metric}
    if db.get(UsageCounter, key) is not None:
        return
    db.add(UsageCounter(**key, used=0))
    try:
        db.commit()
    except IntegrityError:  # a concurrent request made it first
        db.rollback()


def used(db: Session, workspace_id: uuid.UUID, metric: str) -> int:
    row = db.get(UsageCounter, {"workspace_id": workspace_id, "period": period_key(metric), "metric": metric})
    return row.used if row else 0


def take(db: Session, workspace: Workspace, metric: str, n: int = 1, plan: Plan | None = None) -> None:
    """Use n units of metric, or raise the 402 that opens the upgrade popup."""
    plan = plan or effective_plan(db, workspace)
    limit = int(plan.video_limits.get(metric, 0))
    period = period_key(metric)
    _ensure_row(db, workspace.id, period, metric)
    where = [UsageCounter.workspace_id == workspace.id, UsageCounter.period == period, UsageCounter.metric == metric]
    if limit >= 0:  # -1 = unlimited, still counted
        where.append(UsageCounter.used + n <= limit)
    taken = db.execute(update(UsageCounter).where(*where).values(used=UsageCounter.used + n)).rowcount
    db.commit()
    if taken != 1:
        label, when = LABELS[metric]
        message = (f"Your plan does not include {label}." if limit == 0
                   else f"You have used all {limit} {label} {when}.")
        raise plan_limit_error(plan, f"video_limits.{metric}", message)


def give_back(db: Session, workspace_id: uuid.UUID, metric: str, n: int = 1) -> None:
    """Undo a take whose blog2video call failed."""
    db.execute(update(UsageCounter)
               .where(UsageCounter.workspace_id == workspace_id, UsageCounter.period == period_key(metric),
                      UsageCounter.metric == metric)
               .values(used=case((UsageCounter.used > n, UsageCounter.used - n), else_=0)))
    db.commit()


def report(db: Session, workspace: Workspace) -> dict:
    """What the wizard shows: each counter's used / limit."""
    plan = effective_plan(db, workspace)
    rows = {(r.period, r.metric): r.used for r in db.scalars(
        select(UsageCounter).where(UsageCounter.workspace_id == workspace.id))}
    return {"limits": {m: {"used": rows.get((period_key(m), m), 0), "limit": int(plan.video_limits.get(m, 0))}
                       for m in VIDEO_LIMITS}}

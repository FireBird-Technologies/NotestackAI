"""Monthly usage against plan limits, from usage_events."""

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Artifact, Document, UsageEvent, Workspace
from app.services.plans import Plan, effective_plan, plan_limit_error
from app.services.video_quota import video_usage


def month_start(now: datetime | None = None) -> datetime:
    now = now or datetime.now(UTC)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def month_usage(db: Session, workspace_id, lifetime: bool = False) -> dict:
    """What this month has used. With `lifetime` (the Free plan) Launch Kits, infographics and audio overviews are
    counted over all time instead, not counting the ones that failed (a failed one never uses up an allowance)."""
    since = month_start()

    def total(kind: str, unit: str) -> float:
        return float(db.scalar(
            select(func.coalesce(func.sum(UsageEvent.quantity), 0)).where(
                UsageEvent.workspace_id == workspace_id, UsageEvent.kind == kind,
                UsageEvent.unit == unit, UsageEvent.created_at >= since,
            )
        ) or 0)

    def made(type_: str, *, always_month: bool = False) -> int:
        q = select(func.count()).select_from(Artifact).where(Artifact.workspace_id == workspace_id, Artifact.type == type_)
        if lifetime and not always_month:
            q = q.where(Artifact.status != "failed")
        else:
            q = q.where(Artifact.created_at >= since)
        return db.scalar(q) or 0

    return {
        "audio_minutes": round(total("tts", "seconds") / 60, 1),
        "audio_overviews": made("audio_overview"),
        "launch_kits": made("launch_kit"),
        "reports": made("report", always_month=True),  # reports stay monthly on every plan
        "infographics": made("infographic"),
        "llm_tokens": int(total("llm", "tokens")),
        "since": since.isoformat(),
    }


def usage_report(db: Session, workspace: Workspace) -> dict:
    plan = effective_plan(db, workspace)
    used = month_usage(db, workspace.id, plan.lifetime)
    videos = video_usage(db, workspace)
    used["videos"] = videos["used"]
    used["indexed_posts"] = db.scalar(
        select(func.count()).select_from(Document).where(Document.workspace_id == workspace.id, Document.path.is_not(None))
    ) or 0
    return {
        "plan": plan.id,
        "used": used,
        "videos_resets_at": videos["resets_at"],
        "limits": {
            "audio_minutes": plan.audio_minutes,
            "audio_overviews": plan.audio_overviews,
            "videos": videos["limit"],
            "launch_kits": plan.launch_kits,
            "reports": plan.reports,
            "infographics": plan.infographics,
            "sources": plan.sources,
            "indexed_posts": plan.indexed_posts,
        },
    }


def check_limit(db: Session, workspace: Workspace, kind: str, amount: float = 1) -> Plan:
    """Raise 402 plan_limit when this request would go over the allowance (monthly, or in total on Free)."""
    plan = effective_plan(db, workspace)
    used = month_usage(db, workspace.id, plan.lifetime)
    limit = {"audio_minutes": plan.audio_minutes, "audio_overviews": plan.audio_overviews,
             "launch_kits": plan.launch_kits, "reports": plan.reports, "infographics": plan.infographics}[kind]
    if limit >= 0 and used[kind] + amount > limit:
        label = kind.replace("_", " ")
        total = plan.lifetime and kind != "reports"  # Free's allowances are totals, its reports are monthly
        raise plan_limit_error(plan, kind, f"This would go over your {limit} {label}{' in total' if total else ' this month'}.")
    return plan

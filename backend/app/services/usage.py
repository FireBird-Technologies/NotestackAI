"""Monthly usage against plan limits, from usage_events."""

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Artifact, UsageEvent, Workspace
from app.services.plans import Plan, effective_plan, plan_limit_error
from app.services.video_quota import video_usage


def month_start(now: datetime | None = None) -> datetime:
    now = now or datetime.now(UTC)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def month_usage(db: Session, workspace_id) -> dict:
    since = month_start()

    def total(kind: str, unit: str) -> float:
        return float(db.scalar(
            select(func.coalesce(func.sum(UsageEvent.quantity), 0)).where(
                UsageEvent.workspace_id == workspace_id, UsageEvent.kind == kind,
                UsageEvent.unit == unit, UsageEvent.created_at >= since,
            )
        ) or 0)

    kits = db.scalar(
        select(func.count()).select_from(Artifact).where(
            Artifact.workspace_id == workspace_id, Artifact.type == "launch_kit", Artifact.created_at >= since
        )
    ) or 0
    reports = db.scalar(
        select(func.count()).select_from(Artifact).where(
            Artifact.workspace_id == workspace_id, Artifact.type == "report", Artifact.created_at >= since
        )
    ) or 0
    infographics = db.scalar(
        select(func.count()).select_from(Artifact).where(
            Artifact.workspace_id == workspace_id, Artifact.type == "infographic", Artifact.created_at >= since
        )
    ) or 0
    return {
        "audio_minutes": round(total("tts", "seconds") / 60, 1),
        "launch_kits": kits,
        "reports": reports,
        "infographics": infographics,
        "llm_tokens": int(total("llm", "tokens")),
        "since": since.isoformat(),
    }


def usage_report(db: Session, workspace: Workspace) -> dict:
    plan = effective_plan(db, workspace)
    used = month_usage(db, workspace.id)
    videos = video_usage(db, workspace)
    used["videos"] = videos["used"]
    return {
        "plan": plan.id,
        "used": used,
        "videos_resets_at": videos["resets_at"],
        "limits": {
            "audio_minutes": plan.audio_minutes,
            "videos": videos["limit"],
            "launch_kits": plan.launch_kits,
            "reports": plan.reports,
            "infographics": plan.infographics,
            "sources": plan.sources,
            "indexed_posts": plan.indexed_posts,
        },
    }


def check_limit(db: Session, workspace: Workspace, kind: str, amount: float = 1) -> Plan:
    """Raise 402 plan_limit when this request would go over the monthly allowance."""
    plan = effective_plan(db, workspace)
    used = month_usage(db, workspace.id)
    limit = {"audio_minutes": plan.audio_minutes, "launch_kits": plan.launch_kits, "reports": plan.reports,
             "infographics": plan.infographics}[kind]
    if limit >= 0 and used[kind] + amount > limit:
        label = kind.replace("_", " ")
        raise plan_limit_error(plan, kind, f"This would go over your {limit} {label} this month.")
    return plan

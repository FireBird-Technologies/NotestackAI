from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.models import Document, Source
from app.routers.sources import serialize_document
from app.services.jobs import create_job, serialize_job

router = APIRouter(prefix="/api/resurface", tags=["resurface"])

COOLDOWN = timedelta(days=90)


def _aware(dt: datetime | None) -> datetime | None:
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=UTC)


@router.get("")
def suggestions(ctx: Ctx = Depends(get_ctx), limit: int = 20):
    now = datetime.now(UTC)
    rows = ctx.db.execute(
        select(Document, Source).outerjoin(Source, Source.id == Document.source_id)
        .where(Document.workspace_id == ctx.workspace.id, Document.path.is_not(None))
    ).all()
    evergreen, on_this_day = [], []
    unscored = 0
    for d, s in rows:
        published = _aware(d.published_at)
        resurfaced = _aware(d.last_resurfaced_at)
        meta = d.metadata_json or {}
        item = {**serialize_document(d, s), "reason": meta.get("evergreen_reason"), "angle": meta.get("reshare_angle"),
                "last_resurfaced_at": resurfaced.isoformat() if resurfaced else None}
        if published and published.month == now.month and published.day == now.day and published.year < now.year:
            on_this_day.append({**item, "years_ago": now.year - published.year})
        if d.evergreen_score is None:
            unscored += 1
            continue
        if resurfaced and now - resurfaced < COOLDOWN:
            continue
        age_days = (now - published).days if published else 365
        # Old, timeless and not recently reshared ranks highest; brand new posts do not need resurfacing.
        age_factor = min(age_days / 365, 2.0) if age_days > 30 else 0.1
        evergreen.append({**item, "rank": round(d.evergreen_score * (0.5 + age_factor / 2), 3)})
    evergreen.sort(key=lambda x: -x["rank"])
    return {"evergreen": evergreen[: min(limit, 100)], "on_this_day": on_this_day, "unscored": unscored,
            "total_posts": len(rows)}


@router.post("/scan")
def scan(ctx: Ctx = Depends(get_ctx)):
    return serialize_job(create_job(ctx.db, ctx.workspace.id, "resurface_scan", {}, max_attempts=2))

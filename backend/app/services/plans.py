"""Plans live in the `plans` table (edit a row to change limits or prices; it takes effect within a minute).
DEFAULT_PLANS below seeds that table and is used whenever it is empty or unreachable.
While BILLING_ENABLED is false every workspace gets Studio limits for free."""

import logging
import threading
import time
from collections.abc import Iterator, Mapping
from dataclasses import asdict, dataclass, field

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import settings
from app.models import PlanRecord, Subscription, Workspace

log = logging.getLogger(__name__)

ANNUAL_DISCOUNT = 0.25  # annual billing: 25% off the monthly price


@dataclass(frozen=True)
class Plan:
    id: str
    name: str
    tagline: str
    price_monthly_usd: float
    sources: int
    indexed_posts: int
    audio_minutes: int
    videos: int  # blog2video videos per month, or in total when videos_monthly is False
    launch_kits: int  # -1 = unlimited
    voice_cloning: bool
    brand_kit: bool
    features: tuple[str, ...]
    # Premium (★) video options: long durations, paid and custom voices, voice tuning and samples, AI script
    # rewrites, AI chat editing, avatars, the Remotion source download.
    video_premium: bool = False
    # Per-workspace shares of what blog2video only limits account-wide (keys in VIDEO_LIMITS; 0 = none).
    video_limits: dict = field(default_factory=dict)
    videos_monthly: bool = True
    reports: int = 0  # reports a month; -1 = unlimited
    infographics: int = 0  # infographics a month; -1 = unlimited


# metric -> period it counts over (app/services/video_limits.py)
VIDEO_LIMITS = {
    "ai_edits": "month",  # scene regenerate/add, AI images, stock clips, AI chat, template AI edits, avatars
    "templates": "all",  # custom templates: blog2video's slots are lifetime, never given back
    "template_ai_daily": "day",  # template theme extraction from a prompt or document, code generation
    "voice_designs_daily": "day",
    "voice_samples_daily": "day",
    "custom_voices": "all",  # kept voices; deleting one frees its place
}

FREE_VIDEO_LIMITS = {"ai_edits": 20, "templates": 0, "template_ai_daily": 0, "voice_designs_daily": 0,
                     "voice_samples_daily": 0, "custom_voices": 0}
WRITER_VIDEO_LIMITS = {"ai_edits": 300, "templates": 2, "template_ai_daily": 3, "voice_designs_daily": 5,
                       "voice_samples_daily": 20, "custom_voices": 3}
STUDIO_VIDEO_LIMITS = {"ai_edits": 1000, "templates": 5, "template_ai_daily": 5, "voice_designs_daily": 10,
                       "voice_samples_daily": 40, "custom_voices": 10}


DEFAULT_PLANS: dict[str, Plan] = {
    "free": Plan(
        id="free",
        name="Free",
        tagline="For trying Notestack on your archive",
        price_monthly_usd=0,
        sources=1,
        indexed_posts=5,
        audio_minutes=3,
        videos=1,
        launch_kits=2,
        reports=2,
        infographics=2,
        voice_cloning=False,
        brand_kit=False,
        features=(
            "1 source, your latest 5 posts indexed",
            "Grounded research chat with citations",
            "3 min of audio overviews a month",
            "1 video to try it",
            "2 Launch Kits a month",
            "2 reports a month",
            "2 infographics a month",
        ),
        video_limits=FREE_VIDEO_LIMITS,
        videos_monthly=False,
    ),
    "writer": Plan(
        id="writer",
        name="Writer",
        tagline="For writers publishing every week",
        price_monthly_usd=24.99,
        sources=3,
        indexed_posts=500,
        audio_minutes=60,
        videos=10,
        launch_kits=50,
        reports=30,
        infographics=30,
        voice_cloning=True,
        brand_kit=True,
        features=(
            "3 sources, 500 indexed posts",
            "60 min of audio overviews a month",
            "10 videos a month",
            "50 Launch Kits a month",
            "30 reports a month",
            "30 infographics a month",
            "Voice cloning with consent",
            "Your brand colors and logo",
        ),
        video_premium=True,
        video_limits=WRITER_VIDEO_LIMITS,
    ),
    "studio": Plan(
        id="studio",
        name="Studio",
        tagline="For publications and power users",
        price_monthly_usd=48.99,
        sources=10,
        indexed_posts=5000,
        audio_minutes=240,
        videos=20,
        launch_kits=-1,
        reports=-1,
        infographics=-1,
        voice_cloning=True,
        brand_kit=True,
        features=(
            "10 sources, 5,000 indexed posts",
            "240 min of audio overviews a month",
            "20 videos a month",
            "Unlimited Launch Kits",
            "Unlimited reports",
            "Unlimited infographics",
            "Launchpad calendar and resurfacing",
            "Priority rendering",
        ),
        video_premium=True,
        video_limits=STUDIO_VIDEO_LIMITS,
    ),
}


CACHE_SECONDS = 60


def _plan_from_row(row: PlanRecord) -> Plan:
    return Plan(id=row.id, name=row.name, tagline=row.tagline or "",
                price_monthly_usd=float(row.price_monthly_usd or 0), sources=row.sources,
                indexed_posts=row.indexed_posts, audio_minutes=row.audio_minutes,
                videos=row.videos, launch_kits=row.launch_kits, reports=row.reports, infographics=row.infographics,
                voice_cloning=bool(row.voice_cloning),
                brand_kit=bool(row.brand_kit), features=tuple(row.features or ()),
                video_premium=bool(row.video_premium), videos_monthly=bool(row.videos_monthly),
                video_limits={**{k: 0 for k in VIDEO_LIMITS}, **(row.video_limits or {})})


def _read_table() -> dict[str, Plan] | None:
    from app.db import SessionLocal

    try:
        with SessionLocal() as db:
            rows = db.scalars(select(PlanRecord).order_by(PlanRecord.sort_order, PlanRecord.price_monthly_usd)).all()
            plans = {r.id: _plan_from_row(r) for r in rows}
    except SQLAlchemyError as e:
        log.warning("plans table unreadable, using built-in plans: %s", type(e).__name__)
        return None
    if plans and "free" not in plans:
        log.error("plans table has no 'free' row, using built-in plans")
        return None
    return plans or None


class PlanCatalog(Mapping[str, Plan]):
    """PLANS: the plans table, cheapest first, cached for CACHE_SECONDS."""

    def __init__(self) -> None:
        self._plans: dict[str, Plan] | None = None
        self._loaded_at = 0.0
        self._lock = threading.Lock()

    def _current(self) -> dict[str, Plan]:
        now = time.monotonic()
        if self._plans is None or now - self._loaded_at >= CACHE_SECONDS:
            with self._lock:
                if self._plans is None or now - self._loaded_at >= CACHE_SECONDS:
                    self._plans = _read_table() or DEFAULT_PLANS
                    self._loaded_at = now
        return self._plans

    def reload(self) -> None:
        """Drop the cache so the next read sees table edits immediately."""
        self._plans = None

    def order(self) -> list[str]:
        return list(self._current())

    def __getitem__(self, plan_id: str) -> Plan:
        return self._current()[plan_id]

    def __iter__(self) -> Iterator[str]:
        return iter(self._current())

    def __len__(self) -> int:
        return len(self._current())


PLANS = PlanCatalog()


def to_99(amount: float) -> float:
    """Nearest price ending in .99 (18.74 -> 18.99, 36.74 -> 36.99)."""
    return 0.0 if amount <= 0 else round(max(0.99, round(amount + 0.01) - 0.01), 2)


def annual_prices(plan: Plan) -> tuple[float, float]:
    """(effective monthly price, total billed per year) on annual billing, shown as .99 prices."""
    per_month = to_99(plan.price_monthly_usd * (1 - ANNUAL_DISCOUNT))
    return per_month, round(per_month * 12, 2)


def annual_savings_pct(plan: Plan) -> int:
    if not plan.price_monthly_usd:
        return 0
    per_month, _ = annual_prices(plan)
    return round((1 - per_month / plan.price_monthly_usd) * 100)


def plan_dict(plan: Plan) -> dict:
    data = asdict(plan)
    data["features"] = list(plan.features)
    data["price_annual_monthly_usd"], data["price_annual_usd"] = annual_prices(plan)
    data["annual_discount"] = ANNUAL_DISCOUNT
    data["annual_savings_pct"] = annual_savings_pct(plan)
    return data


def effective_plan(db: Session, workspace: Workspace) -> Plan:
    if not settings.billing_enabled:
        return PLANS["studio"]
    sub = db.query(Subscription).filter_by(workspace_id=workspace.id).one_or_none()
    # past_due keeps the plan while Stripe retries the card (grace period); unpaid or canceled drop to Free.
    if not sub or sub.status not in {"active", "trialing", "past_due"}:
        return PLANS["free"]
    return PLANS.get(sub.plan, PLANS["free"])


def plan_order() -> list[str]:
    return PLANS.order()


def next_plan(plan: Plan) -> Plan | None:
    order = plan_order()
    i = order.index(plan.id)
    return PLANS[order[i + 1]] if i + 1 < len(order) else None


def upgrade_for(plan: Plan, kind: str | None = None) -> str | None:
    """Cheapest plan above this one that raises the limit named by kind (or simply the next tier)."""
    order = plan_order()
    for pid in order[order.index(plan.id) + 1:]:
        candidate = PLANS[pid]
        if kind is None:
            return pid
        current, better = plan_value(plan, kind), plan_value(candidate, kind)
        if isinstance(better, bool):
            if better and not current:
                return pid
        elif isinstance(better, int | float) and (better < 0 or better > current):
            return pid
    return None


def plan_value(plan: Plan, kind: str):
    """A plan's limit or flag by name; "video_limits.<metric>" reads the per-metric video limits."""
    if kind.startswith("video_limits."):
        return plan.video_limits.get(kind.removeprefix("video_limits."), 0)
    return getattr(plan, kind, 0)


def plan_limit_error(plan: Plan, kind: str, message: str) -> HTTPException:
    """402 the frontend turns into the out of fuel popup."""
    return HTTPException(402, {"code": "plan_limit", "message": message, "kind": kind,
                               "plan": plan.id, "upgrade_to": upgrade_for(plan, kind)})

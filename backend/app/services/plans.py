"""Three tiers. While BILLING_ENABLED is false every workspace gets Studio limits for free."""

from dataclasses import asdict, dataclass

from sqlalchemy.orm import Session

from app.config import settings
from app.models import Subscription, Workspace

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
    video_minutes: int
    launch_kits: int  # -1 = unlimited
    voice_cloning: bool
    brand_kit: bool
    features: tuple[str, ...]


PLANS: dict[str, Plan] = {
    "free": Plan(
        id="free",
        name="Free",
        tagline="For trying Notestack on your archive",
        price_monthly_usd=0,
        sources=1,
        indexed_posts=5,
        audio_minutes=3,
        video_minutes=1,
        launch_kits=2,
        voice_cloning=False,
        brand_kit=False,
        features=(
            "1 source, your 5 latest posts",
            "Grounded research chat with citations",
            "3 min of audio overviews a month",
            "1 min of video a month",
            "2 Launch Kits a month",
        ),
    ),
    "writer": Plan(
        id="writer",
        name="Writer",
        tagline="For writers publishing every week",
        price_monthly_usd=24.99,
        sources=3,
        indexed_posts=500,
        audio_minutes=60,
        video_minutes=30,
        launch_kits=50,
        voice_cloning=True,
        brand_kit=True,
        features=(
            "3 sources, 500 indexed posts",
            "60 min of audio overviews a month",
            "30 min of video renders a month",
            "50 Launch Kits a month",
            "Voice cloning with consent",
            "Your brand colors and logo",
        ),
    ),
    "studio": Plan(
        id="studio",
        name="Studio",
        tagline="For publications and power users",
        price_monthly_usd=48.99,
        sources=10,
        indexed_posts=5000,
        audio_minutes=240,
        video_minutes=120,
        launch_kits=-1,
        voice_cloning=True,
        brand_kit=True,
        features=(
            "10 sources, 5,000 indexed posts",
            "240 min of audio overviews a month",
            "120 min of video renders a month",
            "Unlimited Launch Kits",
            "Launchpad calendar and resurfacing",
            "Priority rendering",
        ),
    ),
}


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
    if not sub or sub.status not in {"active", "trialing"}:
        return PLANS["free"]
    return PLANS.get(sub.plan, PLANS["free"])

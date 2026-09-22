"""Three tiers. While BILLING_ENABLED is false every workspace gets Studio limits for free."""

from dataclasses import asdict, dataclass

from sqlalchemy.orm import Session

from app.config import settings
from app.models import Subscription, Workspace


@dataclass(frozen=True)
class Plan:
    id: str
    name: str
    tagline: str
    price_monthly_usd: int
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
        indexed_posts=50,
        audio_minutes=10,
        video_minutes=3,
        launch_kits=5,
        voice_cloning=False,
        brand_kit=False,
        features=(
            "1 source, 50 indexed posts",
            "Grounded research chat with citations",
            "10 min of audio overviews a month",
            "5 Launch Kits a month",
        ),
    ),
    "writer": Plan(
        id="writer",
        name="Writer",
        tagline="For writers publishing every week",
        price_monthly_usd=19,
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
        price_monthly_usd=49,
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


def plan_dict(plan: Plan) -> dict:
    data = asdict(plan)
    data["features"] = list(plan.features)
    return data


def effective_plan(db: Session, workspace: Workspace) -> Plan:
    if not settings.billing_enabled:
        return PLANS["studio"]
    sub = db.query(Subscription).filter_by(workspace_id=workspace.id).one_or_none()
    if not sub or sub.status not in {"active", "trialing"}:
        return PLANS["free"]
    return PLANS.get(sub.plan, PLANS["free"])

"""starter plan, exact annual prices, and updated Writer/Studio allowances

Revision ID: 0033_starter_plan
Revises: 0032_plan_chat_messages
Create Date: 2026-10-29
"""

from datetime import UTC, datetime

import sqlalchemy as sa

from alembic import op

revision = "0033_starter_plan"
down_revision = "0032_plan_chat_messages"
branch_labels = None
depends_on = None


STARTER_FEATURES = [
    "Up to 30 posts indexed, from any source",
    "Unlimited research chat",
    "5x more audio overviews than Free",
    "5 videos a month",
    "20 Launch Kits a month",
    "20 reports a month",
    "20 infographics a month",
]


def _replace(features: list[str] | None, old: str, new: str) -> list[str]:
    return [new if item == old else item for item in (features or [])]


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("plans")}
    if "price_annual_usd" not in columns:
        op.add_column("plans", sa.Column("price_annual_usd", sa.Float(), nullable=True))

    plans = sa.table(
        "plans",
        sa.column("id", sa.String),
        sa.column("sort_order", sa.Integer),
        sa.column("name", sa.String),
        sa.column("tagline", sa.String),
        sa.column("price_monthly_usd", sa.Float),
        sa.column("price_annual_usd", sa.Float),
        sa.column("sources", sa.Integer),
        sa.column("indexed_posts", sa.Integer),
        sa.column("audio_minutes", sa.Integer),
        sa.column("audio_overviews", sa.Integer),
        sa.column("videos", sa.Integer),
        sa.column("launch_kits", sa.Integer),
        sa.column("reports", sa.Integer),
        sa.column("infographics", sa.Integer),
        sa.column("chat_messages", sa.Integer),
        sa.column("voice_cloning", sa.Boolean),
        sa.column("features", sa.JSON),
        sa.column("videos_monthly", sa.Boolean),
        sa.column("video_limits", sa.JSON),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )

    exists = bind.execute(sa.select(plans.c.id).where(plans.c.id == "starter")).scalar()
    if not exists:
        now = datetime.now(UTC)
        op.bulk_insert(plans, [{
            "id": "starter",
            "sort_order": 1,
            "name": "Starter",
            "tagline": "For writers growing a focused archive",
            "price_monthly_usd": 14.99,
            "price_annual_usd": 137.88,
            "sources": -1,
            "indexed_posts": 30,
            "audio_minutes": 30,
            "audio_overviews": -1,
            "videos": 5,
            "launch_kits": 20,
            "reports": 20,
            "infographics": 20,
            "chat_messages": -1,
            "voice_cloning": False,
            "features": STARTER_FEATURES,
            "videos_monthly": True,
            "video_limits": {"ai_edits": 100, "templates": 0, "template_ai_daily": 0},
            "created_at": now,
            "updated_at": now,
        }])

    op.execute(plans.update().where(plans.c.id == "starter").values(price_monthly_usd=14.99,
                                                                       price_annual_usd=137.88))
    op.execute(plans.update().where(plans.c.id == "writer").values(sort_order=2, price_annual_usd=227.99,
                                                                      launch_kits=40, reports=50, infographics=50))
    op.execute(plans.update().where(plans.c.id == "studio").values(sort_order=3, price_annual_usd=443.99,
                                                                      launch_kits=-1))

    for plan_id, replacements in {
        "writer": (("20 Launch Kits a month", "40 Launch Kits a month"),
                   ("30 reports a month", "50 reports a month"),
                   ("30 infographics a month", "50 infographics a month")),
        "studio": (("50 Launch Kits a month", "Unlimited Launch Kits"),),
    }.items():
        features = bind.execute(sa.select(plans.c.features).where(plans.c.id == plan_id)).scalar()
        for old, new in replacements:
            features = _replace(features, old, new)
        op.execute(plans.update().where(plans.c.id == plan_id).values(features=features))


def downgrade() -> None:
    plans = sa.table("plans", sa.column("id", sa.String), sa.column("sort_order", sa.Integer),
                     sa.column("launch_kits", sa.Integer), sa.column("reports", sa.Integer),
                     sa.column("infographics", sa.Integer), sa.column("features", sa.JSON))
    bind = op.get_bind()
    for plan_id, replacements in {
        "writer": (("40 Launch Kits a month", "20 Launch Kits a month"),
                   ("50 reports a month", "30 reports a month"),
                   ("50 infographics a month", "30 infographics a month")),
        "studio": (("Unlimited Launch Kits", "50 Launch Kits a month"),),
    }.items():
        features = bind.execute(sa.select(plans.c.features).where(plans.c.id == plan_id)).scalar()
        for old, new in replacements:
            features = _replace(features, old, new)
        op.execute(plans.update().where(plans.c.id == plan_id).values(features=features))
    op.execute(plans.update().where(plans.c.id == "writer").values(sort_order=1, launch_kits=20, reports=30,
                                                                      infographics=30))
    op.execute(plans.update().where(plans.c.id == "studio").values(sort_order=2, launch_kits=50))
    op.execute(plans.delete().where(plans.c.id == "starter"))
    op.drop_column("plans", "price_annual_usd")

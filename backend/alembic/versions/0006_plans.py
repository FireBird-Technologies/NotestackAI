"""plans: one row per plan (limits, price, pricing-page copy), editable without a deploy

Seeded with the plans that were hard-coded in app/services/plans.py. Rows that already exist are left alone.

Revision ID: 0006_plans
Revises: 0005_video_quota
Create Date: 2026-09-29
"""
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision = "0006_plans"
down_revision = "0005_video_quota"
branch_labels = None
depends_on = None

SEED = [
    {"id": "free", "sort_order": 0, "name": "Free", "tagline": "For trying Notestack on your archive",
     "price_monthly_usd": 0, "sources": 1, "indexed_posts": 5, "audio_minutes": 3, "videos": 1, "launch_kits": 2,
     "voice_cloning": False, "brand_kit": False,
     "features": ["1 source, your latest 5 posts indexed", "Grounded research chat with citations",
                  "3 min of audio overviews a month", "1 video a month", "2 Launch Kits a month"]},
    {"id": "writer", "sort_order": 1, "name": "Writer", "tagline": "For writers publishing every week",
     "price_monthly_usd": 24.99, "sources": 3, "indexed_posts": 500, "audio_minutes": 60, "videos": 10,
     "launch_kits": 50, "voice_cloning": True, "brand_kit": True,
     "features": ["3 sources, 500 indexed posts", "60 min of audio overviews a month", "10 videos a month",
                  "50 Launch Kits a month", "Voice cloning with consent", "Your brand colors and logo"]},
    {"id": "studio", "sort_order": 2, "name": "Studio", "tagline": "For publications and power users",
     "price_monthly_usd": 48.99, "sources": 10, "indexed_posts": 5000, "audio_minutes": 240, "videos": 30,
     "launch_kits": -1, "voice_cloning": True, "brand_kit": True,
     "features": ["10 sources, 5,000 indexed posts", "240 min of audio overviews a month", "30 videos a month",
                  "Unlimited Launch Kits", "Launchpad calendar and resurfacing", "Priority rendering"]},
]


def upgrade() -> None:
    bind = op.get_bind()
    # 0001 builds from the live models, so a fresh database may already have the table (empty).
    if "plans" not in sa.inspect(bind).get_table_names():
        op.create_table(
            "plans",
            sa.Column("id", sa.String(20), primary_key=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("name", sa.String(50), nullable=False),
            sa.Column("tagline", sa.String(200), nullable=False, server_default=""),
            sa.Column("price_monthly_usd", sa.Float(), nullable=False, server_default="0"),
            sa.Column("sources", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("indexed_posts", sa.Integer(), nullable=False, server_default="5"),
            sa.Column("audio_minutes", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("videos", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("launch_kits", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("voice_cloning", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("brand_kit", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("features", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
    # Columns a later migration drops (brand_kit) are not in a table 0001 built from today's models: seed what exists.
    have = {c["name"] for c in sa.inspect(bind).get_columns("plans")}
    seed = [{k: v for k, v in p.items() if k in have} for p in SEED]
    types = {"features": sa.JSON(), "voice_cloning": sa.Boolean(), "brand_kit": sa.Boolean(),
             "created_at": sa.DateTime(timezone=True), "updated_at": sa.DateTime(timezone=True)}
    plans = sa.table("plans", *(sa.column(k, types.get(k)) for k in [*seed[0], "created_at", "updated_at"]))
    existing = {row[0] for row in bind.execute(sa.text("SELECT id FROM plans"))}
    now = datetime.now(UTC)
    missing = [{**p, "created_at": now, "updated_at": now} for p in seed if p["id"] not in existing]
    if missing:
        op.bulk_insert(plans, missing)


def downgrade() -> None:
    op.drop_table("plans")

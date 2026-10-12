"""plan_limits: posts indexed across every source, Free allowances that are totals, new Writer and Studio numbers

Revision ID: 0024_plan_limits
Revises: 0023_drop_brand_kit
Create Date: 2026-10-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0024_plan_limits"
down_revision = "0023_drop_brand_kit"
branch_labels = None
depends_on = None

PLANS = {
    "free": dict(sources=-1, indexed_posts=5, audio_minutes=-1, audio_overviews=1, videos=2, launch_kits=2, reports=2,
                 infographics=2, videos_monthly=False, features=[
                     "Up to 5 posts indexed, from any source", "Grounded research chat with citations",
                     "1 audio overview, any length", "2 videos", "2 Launch Kits", "2 infographics", "2 reports a month"]),
    "writer": dict(sources=-1, indexed_posts=100, audio_minutes=60, audio_overviews=-1, videos=10, launch_kits=20,
                   reports=30, infographics=30, features=[
                       "Up to 100 posts indexed, from any source", "60 min of audio overviews a month", "10 videos a month",
                       "20 Launch Kits a month", "30 reports a month", "30 infographics a month",
                       "Voice cloning with consent"]),
    "studio": dict(sources=-1, indexed_posts=250, audio_minutes=240, audio_overviews=-1, videos=20, launch_kits=50,
                   reports=-1, infographics=-1, features=[
                       "Up to 250 posts indexed, from any source", "240 min of audio overviews a month",
                       "20 videos a month", "50 Launch Kits a month", "Unlimited reports", "Unlimited infographics",
                       "Launchpad calendar and resurfacing", "Priority rendering"]),
}


def upgrade() -> None:
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("plans")}
    if "audio_overviews" not in columns:
        op.add_column("plans", sa.Column("audio_overviews", sa.Integer(), nullable=False, server_default="-1"))
    plans = sa.table("plans", sa.column("id", sa.String), sa.column("sources", sa.Integer),
                     sa.column("indexed_posts", sa.Integer), sa.column("audio_minutes", sa.Integer),
                     sa.column("audio_overviews", sa.Integer), sa.column("videos", sa.Integer),
                     sa.column("launch_kits", sa.Integer), sa.column("reports", sa.Integer),
                     sa.column("infographics", sa.Integer), sa.column("videos_monthly", sa.Boolean),
                     sa.column("features", sa.JSON))
    for plan_id, values in PLANS.items():
        op.execute(plans.update().where(plans.c.id == plan_id).values(**values))


def downgrade() -> None:
    with op.batch_alter_table("plans") as batch:
        batch.drop_column("audio_overviews")

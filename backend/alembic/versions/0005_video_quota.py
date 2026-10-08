"""subscriptions.video_plan / videos_used / video_limit / videos_period_start: the video allowance

Revision ID: 0005_video_quota
Revises: 0004_archive_notebook
Create Date: 2026-09-29
"""
import sqlalchemy as sa
from alembic import op

revision = "0005_video_quota"
down_revision = "0004_archive_notebook"
branch_labels = None
depends_on = None

COLUMNS = ("video_plan", "videos_used", "video_limit", "videos_period_start")


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have the columns.
    existing = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("subscriptions")}
    new = {
        "video_plan": sa.Column("video_plan", sa.String(20), nullable=False, server_default="free"),
        "videos_used": sa.Column("videos_used", sa.Integer(), nullable=False, server_default="0"),
        "video_limit": sa.Column("video_limit", sa.Integer(), nullable=False, server_default="0"),
        "videos_period_start": sa.Column("videos_period_start", sa.DateTime(timezone=True), nullable=True),
    }
    missing = [new[name] for name in COLUMNS if name not in existing]
    if missing:
        with op.batch_alter_table("subscriptions") as batch:
            for column in missing:
                batch.add_column(column)
    # Same limits as app/services/plans.py; the app re-syncs on first use (billing disabled -> studio).
    op.execute("""
        UPDATE subscriptions SET
          video_plan = CASE WHEN status IN ('active', 'trialing', 'past_due') AND plan IN ('writer', 'studio')
                            THEN plan ELSE 'free' END
    """)
    op.execute("""
        UPDATE subscriptions SET
          video_limit = CASE video_plan WHEN 'studio' THEN 30 WHEN 'writer' THEN 10 ELSE 1 END,
          videos_period_start = COALESCE(videos_period_start, CURRENT_TIMESTAMP)
    """)


def downgrade() -> None:
    with op.batch_alter_table("subscriptions") as batch:
        for name in reversed(COLUMNS):
            batch.drop_column(name)

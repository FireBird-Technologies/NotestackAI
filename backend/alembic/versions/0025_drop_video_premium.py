"""drop_video_premium: the premium video options are gone, so is the plan flag for them

Revision ID: 0025_drop_video_premium
Revises: 0024_plan_limits
Create Date: 2026-10-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0025_drop_video_premium"
down_revision = "0024_plan_limits"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "video_premium" in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("plans")}:
        with op.batch_alter_table("plans") as batch:
            batch.drop_column("video_premium")


def downgrade() -> None:
    if "video_premium" not in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("plans")}:
        op.add_column("plans", sa.Column("video_premium", sa.Boolean(), nullable=False, server_default=sa.false()))

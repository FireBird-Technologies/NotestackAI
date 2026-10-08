"""b2v_videos: which workspace owns each blog2video video, and whether its allowance is still charged

blog2video now only takes our account's API key, so this table is our access control and refund ledger.
blog2video no longer connects to this database: drop the role it used (see docs/BLOG2VIDEO.md).

Revision ID: 0008_b2v_videos
Revises: 0007_subscription_plan_fk
Create Date: 2026-09-30
"""
import sqlalchemy as sa
from alembic import op

revision = "0008_b2v_videos"
down_revision = "0007_subscription_plan_fk"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have the table.
    if sa.inspect(op.get_bind()).has_table("b2v_videos"):
        return
    op.create_table(
        "b2v_videos",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("artifact_id", sa.Uuid(), sa.ForeignKey("artifacts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("b2v_video_id", sa.Integer(), nullable=True, unique=True),
        sa.Column("idempotency_key", sa.String(100), nullable=False, unique=True),
        sa.Column("quota_state", sa.String(20), nullable=False, server_default="charged"),
        sa.Column("status", sa.String(40), nullable=False, server_default="queued"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_b2v_videos_ws_created", "b2v_videos", ["workspace_id", "created_at"])
    op.create_index("ix_b2v_videos_artifact_id", "b2v_videos", ["artifact_id"])


def downgrade() -> None:
    op.drop_table("b2v_videos")

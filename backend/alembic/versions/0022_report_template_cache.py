"""report_template_cache: suggested report templates kept, so the Create report dialog is instant

Revision ID: 0022_report_template_cache
Revises: 0021_artifact_feedback
Create Date: 2026-10-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0022_report_template_cache"
down_revision = "0021_artifact_feedback"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have the table.
    if "report_template_cache" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "report_template_cache",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("templates", sa.JSON(), nullable=False),
        sa.UniqueConstraint("workspace_id", "key"),
    )
    op.create_index("ix_report_template_cache_workspace_id", "report_template_cache", ["workspace_id"])


def downgrade() -> None:
    op.drop_table("report_template_cache")

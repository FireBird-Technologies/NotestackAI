"""report_sharing: public links to reports, and a workspace switch that turns them off

Revision ID: 0018_report_sharing
Revises: 0017_reports_limit
Create Date: 2026-10-07
"""
import sqlalchemy as sa
from alembic import op

revision = "0018_report_sharing"
down_revision = "0017_reports_limit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have these.
    inspector = sa.inspect(op.get_bind())
    if "artifact_shares" not in inspector.get_table_names():
        op.create_table(
            "artifact_shares",
            sa.Column("id", sa.Uuid(), primary_key=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
            sa.Column("artifact_id", sa.Uuid(), sa.ForeignKey("artifacts.id", ondelete="CASCADE"), nullable=False,
                      unique=True),
            sa.Column("token", sa.String(64), nullable=False),
            sa.Column("show_sources", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
        op.create_index("ix_artifact_shares_workspace_id", "artifact_shares", ["workspace_id"])
        op.create_index("ix_artifact_shares_token", "artifact_shares", ["token"], unique=True)
    if "allow_public_links" not in {c["name"] for c in inspector.get_columns("workspaces")}:
        op.add_column("workspaces", sa.Column("allow_public_links", sa.Boolean(), nullable=False,
                                              server_default=sa.true()))


def downgrade() -> None:
    with op.batch_alter_table("workspaces") as batch:
        batch.drop_column("allow_public_links")
    op.drop_table("artifact_shares")

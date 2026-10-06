"""workspace_memory: one row of standing notes per workspace, stored as JSON

Revision ID: 0013_workspace_memory
Revises: 0012_artifact_status_len
Create Date: 2026-09-30
"""
import sqlalchemy as sa
from alembic import op

revision = "0013_workspace_memory"
down_revision = "0012_artifact_status_len"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have the table.
    if "workspace_memory" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "workspace_memory",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("facts", sa.JSON(), nullable=False, server_default="{}"),
    )
    op.create_index("ix_workspace_memory_workspace_id", "workspace_memory", ["workspace_id"], unique=True)


def downgrade() -> None:
    op.drop_table("workspace_memory")

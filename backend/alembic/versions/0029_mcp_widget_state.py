"""persist the artifact created by each MCP generation widget

Revision ID: 0029_mcp_widget_state
Revises: 0028_mcp_oauth
Create Date: 2026-10-13
"""

import sqlalchemy as sa

from alembic import op

revision = "0029_mcp_widget_state"
down_revision = "0028_mcp_oauth"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "mcp_widget_states" in set(sa.inspect(op.get_bind()).get_table_names()):
        return
    op.create_table(
        "mcp_widget_states",
        sa.Column("state_id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("artifact_id", sa.Uuid(), sa.ForeignKey("artifacts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(30), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_mcp_widget_states_user_id", "mcp_widget_states", ["user_id"])
    op.create_index("ix_mcp_widget_states_workspace_id", "mcp_widget_states", ["workspace_id"])
    op.create_index("ix_mcp_widget_states_artifact_id", "mcp_widget_states", ["artifact_id"])


def downgrade() -> None:
    op.drop_table("mcp_widget_states")

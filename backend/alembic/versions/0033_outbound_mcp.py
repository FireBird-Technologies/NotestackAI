"""Read-only outbound MCP connections and call audit log.

Revision ID: 0033_outbound_mcp
Revises: 0032_plan_chat_messages
Create Date: 2026-10-26
"""

import sqlalchemy as sa

from alembic import op

revision = "0033_outbound_mcp"
down_revision = "0032_plan_chat_messages"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "outbound_mcp_connections" not in tables:
        op.create_table(
            "outbound_mcp_connections",
            sa.Column("workspace_id", sa.Uuid(), nullable=False),
            sa.Column("user_id", sa.Uuid(), nullable=False),
            sa.Column("name", sa.String(length=100), nullable=False),
            sa.Column("server_url", sa.Text(), nullable=False),
            sa.Column("auth_type", sa.String(length=20), nullable=False),
            sa.Column("access_token_encrypted", sa.Text(), nullable=True),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            sa.Column("enabled_tools", sa.JSON(), nullable=False),
            sa.Column("discovered_tools", sa.JSON(), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("last_checked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("workspace_id", "user_id", "name"),
        )
        op.create_index("ix_outbound_mcp_connections_workspace_id", "outbound_mcp_connections", ["workspace_id"])
        op.create_index("ix_outbound_mcp_connections_user_id", "outbound_mcp_connections", ["user_id"])
    if "outbound_mcp_audits" not in tables:
        op.create_table(
            "outbound_mcp_audits",
            sa.Column("connection_id", sa.Uuid(), nullable=True),
            sa.Column("workspace_id", sa.Uuid(), nullable=False),
            sa.Column("user_id", sa.Uuid(), nullable=False),
            sa.Column("tool_name", sa.String(length=200), nullable=False),
            sa.Column("arguments_hash", sa.String(length=64), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column("duration_ms", sa.Integer(), nullable=False),
            sa.Column("result_preview", sa.Text(), nullable=True),
            sa.Column("error", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.ForeignKeyConstraint(["connection_id"], ["outbound_mcp_connections.id"], ondelete="SET NULL"),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_outbound_mcp_audits_connection_id", "outbound_mcp_audits", ["connection_id"])
        op.create_index("ix_outbound_mcp_audits_workspace_id", "outbound_mcp_audits", ["workspace_id"])
        op.create_index("ix_outbound_mcp_audits_user_id", "outbound_mcp_audits", ["user_id"])


def downgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "outbound_mcp_audits" in tables:
        op.drop_table("outbound_mcp_audits")
    if "outbound_mcp_connections" in tables:
        op.drop_table("outbound_mcp_connections")

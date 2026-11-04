"""Add notebook-level outbound MCP connector switches.

Revision ID: 0037_notebook_mcp_connections
Revises: 0036_oauth_client_callback
Create Date: 2026-10-28
"""

import sqlalchemy as sa

from alembic import op

revision = "0037_notebook_mcp_connections"
down_revision = "0036_oauth_client_callback"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "notebook_mcp_connections",
        sa.Column("notebook_id", sa.Uuid(), nullable=False),
        sa.Column("connection_id", sa.Uuid(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["notebook_id"], ["notebooks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["connection_id"], ["outbound_mcp_connections.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("notebook_id", "connection_id"),
    )
    op.create_index(
        "ix_notebook_mcp_connections_connection_id",
        "notebook_mcp_connections",
        ["connection_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_notebook_mcp_connections_connection_id", table_name="notebook_mcp_connections")
    op.drop_table("notebook_mcp_connections")

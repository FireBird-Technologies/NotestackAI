"""Store a brand icon with each outbound MCP connection.

Revision ID: 0039_outbound_mcp_icon
Revises: 0037_notebook_mcp_connections
Create Date: 2026-10-30
"""

import sqlalchemy as sa

from alembic import op

revision = "0039_outbound_mcp_icon"
down_revision = "0037_notebook_mcp_connections"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("outbound_mcp_connections", sa.Column("icon_url", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("outbound_mcp_connections", "icon_url")

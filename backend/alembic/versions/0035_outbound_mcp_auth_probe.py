"""Remember the standards-based OAuth metadata probe for outbound MCP connections.

Revision ID: 0035_outbound_mcp_auth_probe
Revises: 0034_outbound_mcp_oauth
Create Date: 2026-10-27
"""

import sqlalchemy as sa

from alembic import op

revision = "0035_outbound_mcp_auth_probe"
down_revision = "0034_outbound_mcp_oauth"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("outbound_mcp_connections")}
    if "oauth_metadata_checked_at" not in columns:
        op.add_column(
            "outbound_mcp_connections",
            sa.Column("oauth_metadata_checked_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("outbound_mcp_connections")}
    if "oauth_metadata_checked_at" in columns:
        op.drop_column("outbound_mcp_connections", "oauth_metadata_checked_at")

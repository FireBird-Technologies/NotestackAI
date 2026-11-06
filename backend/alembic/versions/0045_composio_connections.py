"""Replace Pipedream managed email connections with Composio.

Revision ID: 0045_composio_connections
Revises: 0044_plan_connector_copy
Create Date: 2026-11-05
"""

import sqlalchemy as sa

from alembic import op

revision = "0045_composio_connections"
down_revision = "0044_plan_connector_copy"
branch_labels = None
depends_on = None

connections = sa.table(
    "outbound_mcp_connections",
    sa.column("provider", sa.String),
    sa.column("server_url", sa.Text),
    sa.column("canonical_resource", sa.Text),
    sa.column("auth_status", sa.String),
    sa.column("account_label", sa.String),
    sa.column("enabled_tools", sa.JSON),
    sa.column("discovered_tools", sa.JSON),
    sa.column("status", sa.String),
    sa.column("last_error", sa.Text),
)


def upgrade() -> None:
    # Credentials previously held by Pipedream cannot be transferred. Preserve each local row so the user sees the
    # same Gmail/Outlook choice, but require one deliberate Composio authorization before any tool can run.
    op.execute(
        connections.update().where(connections.c.provider == "pipedream").values(
            provider="composio",
            server_url="https://connect.composio.dev/mcp",
            auth_status="authorization_required",
            account_label=None,
            enabled_tools=[],
            discovered_tools=[],
            status="error",
            last_error="Reconnect this email account with Composio.",
        )
    )
    op.execute(
        connections.update().where(
            connections.c.provider == "composio",
            connections.c.canonical_resource == "microsoft_outlook",
        ).values(canonical_resource="outlook")
    )


def downgrade() -> None:
    op.execute(
        connections.update().where(
            connections.c.provider == "composio",
            connections.c.canonical_resource == "outlook",
        ).values(canonical_resource="microsoft_outlook")
    )
    op.execute(
        connections.update().where(connections.c.provider == "composio").values(
            provider="pipedream",
            server_url="https://remote.mcp.pipedream.net/v3",
            auth_status="authorization_required",
            account_label=None,
            enabled_tools=[],
            discovered_tools=[],
            status="error",
            last_error="Reconnect this email account with Pipedream Connect.",
        )
    )

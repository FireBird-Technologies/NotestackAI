"""mcp_oauth: apps that connect over MCP, the sign-ins they start, and the grants a writer gives them

Revision ID: 0027_mcp_oauth
Revises: 0026_plan_copy
Create Date: 2026-10-09
"""
import sqlalchemy as sa

from alembic import op

revision = "0027_mcp_oauth"
down_revision = "0026_plan_copy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # A fresh database is built from the models by 0001, so the tables may already be there.
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "mcp_clients" not in existing:
        _create_clients()
    if "mcp_auth_requests" not in existing:
        _create_auth_requests()
    if "mcp_grants" not in existing:
        _create_grants()


def _create_clients() -> None:
    op.create_table(
        "mcp_clients",
        sa.Column("client_id", sa.String(100), primary_key=True),
        sa.Column("info", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def _create_auth_requests() -> None:
    op.create_table(
        "mcp_auth_requests",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("client_id", sa.String(100), sa.ForeignKey("mcp_clients.client_id", ondelete="CASCADE"), nullable=False),
        sa.Column("redirect_uri", sa.Text(), nullable=False),
        sa.Column("redirect_uri_provided_explicitly", sa.Boolean(), nullable=False),
        sa.Column("code_challenge", sa.String(200), nullable=False),
        sa.Column("state", sa.Text()),
        sa.Column("scopes", sa.JSON(), nullable=False),
        sa.Column("resource", sa.Text()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE")),
        sa.Column("code_hash", sa.String(64)),
        sa.Column("code_used", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_mcp_auth_requests_client_id", "mcp_auth_requests", ["client_id"])
    op.create_index("ix_mcp_auth_requests_code_hash", "mcp_auth_requests", ["code_hash"])


def _create_grants() -> None:
    op.create_table(
        "mcp_grants",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("client_id", sa.String(100), sa.ForeignKey("mcp_clients.client_id", ondelete="CASCADE"), nullable=False),
        sa.Column("scopes", sa.JSON(), nullable=False),
        sa.Column("resource", sa.Text()),
        sa.Column("refresh_hash", sa.String(64), nullable=False),
        sa.Column("previous_refresh_hash", sa.String(64)),
        sa.Column("refresh_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_mcp_grants_user_id", "mcp_grants", ["user_id"])
    op.create_index("ix_mcp_grants_client_id", "mcp_grants", ["client_id"])
    op.create_index("ix_mcp_grants_refresh_hash", "mcp_grants", ["refresh_hash"])
    op.create_index("ix_mcp_grants_previous_refresh_hash", "mcp_grants", ["previous_refresh_hash"])


def downgrade() -> None:
    op.drop_table("mcp_grants")
    op.drop_table("mcp_auth_requests")
    op.drop_table("mcp_clients")

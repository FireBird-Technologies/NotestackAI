"""OAuth grants for outbound MCP connections.

Revision ID: 0034_outbound_mcp_oauth
Revises: 0033_outbound_mcp
Create Date: 2026-10-27
"""

import sqlalchemy as sa

from alembic import op

revision = "0034_outbound_mcp_oauth"
down_revision = "0033_outbound_mcp"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    columns = {column["name"] for column in inspector.get_columns("outbound_mcp_connections")}
    additions = (
        ("provider", sa.String(length=80), True),
        ("canonical_resource", sa.Text(), True),
        ("authorization_issuer", sa.Text(), True),
        ("auth_status", sa.String(length=30), False),
        ("account_label", sa.String(length=250), True),
        ("granted_scopes", sa.JSON(), False),
    )
    for name, kind, nullable in additions:
        if name not in columns:
            if name == "auth_status":
                op.add_column("outbound_mcp_connections", sa.Column(name, kind, nullable=nullable,
                              server_default="not_required"))
            elif name == "granted_scopes":
                op.add_column("outbound_mcp_connections", sa.Column(name, kind, nullable=nullable,
                              server_default="[]"))
            else:
                op.add_column("outbound_mcp_connections", sa.Column(name, kind, nullable=nullable))

    if "outbound_mcp_oauth_clients" not in tables:
        op.create_table(
            "outbound_mcp_oauth_clients",
            sa.Column("issuer", sa.Text(), nullable=False), sa.Column("resource", sa.Text(), nullable=False),
            sa.Column("registration_type", sa.String(length=30), nullable=False),
            sa.Column("client_id", sa.Text(), nullable=False),
            sa.Column("client_secret_encrypted", sa.Text(), nullable=True),
            sa.Column("registration_token_encrypted", sa.Text(), nullable=True),
            sa.Column("metadata_json", sa.JSON(), nullable=False), sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"), sa.UniqueConstraint("issuer", "resource"),
        )
    if "outbound_mcp_grants" not in tables:
        op.create_table(
            "outbound_mcp_grants",
            sa.Column("connection_id", sa.Uuid(), nullable=False), sa.Column("workspace_id", sa.Uuid(), nullable=False),
            sa.Column("user_id", sa.Uuid(), nullable=False), sa.Column("oauth_client_id", sa.Uuid(), nullable=False),
            sa.Column("issuer", sa.Text(), nullable=False), sa.Column("resource", sa.Text(), nullable=False),
            sa.Column("access_token_encrypted", sa.Text(), nullable=False),
            sa.Column("refresh_token_encrypted", sa.Text(), nullable=True),
            sa.Column("token_type", sa.String(length=30), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True), sa.Column("scopes", sa.JSON(), nullable=False),
            sa.Column("account_id", sa.String(length=250), nullable=True),
            sa.Column("account_label", sa.String(length=250), nullable=True),
            sa.Column("status", sa.String(length=30), nullable=False),
            sa.Column("refreshed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True), sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["connection_id"], ["outbound_mcp_connections.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["oauth_client_id"], ["outbound_mcp_oauth_clients.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"), sa.UniqueConstraint("connection_id"),
        )
        for column in ("connection_id", "workspace_id", "user_id", "oauth_client_id"):
            op.create_index(f"ix_outbound_mcp_grants_{column}", "outbound_mcp_grants", [column])
    if "outbound_mcp_auth_attempts" not in tables:
        op.create_table(
            "outbound_mcp_auth_attempts",
            sa.Column("connection_id", sa.Uuid(), nullable=False), sa.Column("workspace_id", sa.Uuid(), nullable=False),
            sa.Column("user_id", sa.Uuid(), nullable=False), sa.Column("oauth_client_id", sa.Uuid(), nullable=False),
            sa.Column("state_hash", sa.String(length=64), nullable=False),
            sa.Column("pkce_verifier_encrypted", sa.Text(), nullable=False),
            sa.Column("issuer", sa.Text(), nullable=False), sa.Column("resource", sa.Text(), nullable=False),
            sa.Column("scopes", sa.JSON(), nullable=False), sa.Column("redirect_uri", sa.Text(), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("used_at", sa.DateTime(timezone=True), nullable=True), sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["connection_id"], ["outbound_mcp_connections.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["oauth_client_id"], ["outbound_mcp_oauth_clients.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"), sa.UniqueConstraint("state_hash"),
        )
        for column in ("connection_id", "workspace_id", "user_id", "oauth_client_id", "state_hash"):
            op.create_index(f"ix_outbound_mcp_auth_attempts_{column}", "outbound_mcp_auth_attempts", [column])


def downgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "outbound_mcp_auth_attempts" in tables:
        op.drop_table("outbound_mcp_auth_attempts")
    if "outbound_mcp_grants" in tables:
        op.drop_table("outbound_mcp_grants")
    if "outbound_mcp_oauth_clients" in tables:
        op.drop_table("outbound_mcp_oauth_clients")
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("outbound_mcp_connections")}
    for name in ("granted_scopes", "account_label", "auth_status", "authorization_issuer", "canonical_resource", "provider"):
        if name in columns:
            op.drop_column("outbound_mcp_connections", name)

"""Key outbound OAuth clients by their callback URI.

Revision ID: 0036_oauth_client_callback
Revises: 0035_outbound_mcp_auth_probe
Create Date: 2026-10-27
"""

import json

import sqlalchemy as sa

from alembic import op

revision = "0036_oauth_client_callback"
down_revision = "0035_outbound_mcp_auth_probe"
branch_labels = None
depends_on = None

TABLE = "outbound_mcp_oauth_clients"
NEW_UNIQUE = "uq_outbound_mcp_oauth_clients_issuer_resource_redirect"


def _legacy_redirect(client_id, metadata) -> str:
    """Recover the redirect registered by DCR; keep other legacy clients addressable but never reusable."""
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except json.JSONDecodeError:
            metadata = {}
    registration = metadata.get("registration") if isinstance(metadata, dict) else None
    redirects = registration.get("redirect_uris") if isinstance(registration, dict) else None
    if isinstance(redirects, list) and redirects and isinstance(redirects[0], str) and redirects[0]:
        return redirects[0]
    return f"urn:notestack:legacy-oauth-client:{client_id}"


def _old_unique() -> dict | None:
    for constraint in sa.inspect(op.get_bind()).get_unique_constraints(TABLE):
        if constraint.get("column_names") == ["issuer", "resource"]:
            return constraint
    return None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns(TABLE)}
    if "redirect_uri" not in columns:
        op.add_column(TABLE, sa.Column("redirect_uri", sa.Text(), nullable=True))

    clients = sa.table(
        TABLE,
        sa.column("id"),
        sa.column("metadata_json"),
        sa.column("redirect_uri"),
    )
    bind = op.get_bind()
    for row in bind.execute(sa.select(clients.c.id, clients.c.metadata_json, clients.c.redirect_uri)).mappings():
        if not row["redirect_uri"]:
            bind.execute(
                clients.update().where(clients.c.id == row["id"]).values(
                    redirect_uri=_legacy_redirect(row["id"], row["metadata_json"])
                )
            )

    old = _old_unique()
    if old:
        if op.get_bind().dialect.name == "sqlite":
            # SQLite creates unnamed UNIQUE constraints. A reflection naming convention gives batch mode a stable name.
            convention = {"uq": "uq_%(table_name)s_%(column_0_name)s"}
            with op.batch_alter_table(TABLE, naming_convention=convention) as batch:
                batch.drop_constraint(old.get("name") or f"uq_{TABLE}_issuer", type_="unique")
        else:
            op.drop_constraint(old["name"], TABLE, type_="unique")

    uniques = sa.inspect(op.get_bind()).get_unique_constraints(TABLE)
    if not any(constraint.get("name") == NEW_UNIQUE for constraint in uniques):
        with op.batch_alter_table(TABLE) as batch:
            batch.alter_column("redirect_uri", existing_type=sa.Text(), nullable=False)
            batch.create_unique_constraint(NEW_UNIQUE, ["issuer", "resource", "redirect_uri"])


def downgrade() -> None:
    bind = op.get_bind()
    duplicates = bind.execute(sa.text(
        f"SELECT issuer, resource FROM {TABLE} GROUP BY issuer, resource HAVING COUNT(*) > 1 LIMIT 1"
    )).first()
    if duplicates:
        raise RuntimeError("Cannot downgrade while OAuth clients exist for multiple callback URIs.")
    with op.batch_alter_table(TABLE) as batch:
        batch.drop_constraint(NEW_UNIQUE, type_="unique")
        batch.drop_column("redirect_uri")
        batch.create_unique_constraint("uq_outbound_mcp_oauth_clients_issuer_resource", ["issuer", "resource"])

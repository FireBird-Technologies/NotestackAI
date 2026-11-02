"""Retain removed outbound MCP connections without retaining authorization.

Revision ID: 0040_outbound_mcp_soft_delete
Revises: 0039_outbound_mcp_icon
Create Date: 2026-11-01
"""

import sqlalchemy as sa

from alembic import op

revision = "0040_outbound_mcp_soft_delete"
down_revision = "0039_outbound_mcp_icon"
branch_labels = None
depends_on = None

TABLE = "outbound_mcp_connections"
ACTIVE_NAME_INDEX = "uq_outbound_mcp_connections_active_name"


def _old_unique() -> dict | None:
    for constraint in sa.inspect(op.get_bind()).get_unique_constraints(TABLE):
        if constraint.get("column_names") == ["workspace_id", "user_id", "name"]:
            return constraint
    return None


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(op.f("ix_outbound_mcp_connections_deleted_at"), TABLE, ["deleted_at"], unique=False)

    old = _old_unique()
    if old:
        if op.get_bind().dialect.name == "sqlite":
            convention = {"uq": "uq_%(table_name)s_%(column_0_name)s_%(column_1_name)s_%(column_2_name)s"}
            fallback = "uq_outbound_mcp_connections_workspace_id_user_id_name"
            with op.batch_alter_table(TABLE, naming_convention=convention) as batch:
                batch.drop_constraint(old.get("name") or fallback, type_="unique")
        else:
            op.drop_constraint(old["name"], TABLE, type_="unique")

    op.create_index(
        ACTIVE_NAME_INDEX,
        TABLE,
        ["workspace_id", "user_id", "name"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
        sqlite_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    # The previous schema cannot represent multiple lifecycles with the same name. Keep the newest active rows and
    # discard only retained removal-history rows when explicitly downgrading.
    op.execute(sa.text(f"DELETE FROM {TABLE} WHERE deleted_at IS NOT NULL"))
    op.drop_index(ACTIVE_NAME_INDEX, table_name=TABLE)
    op.drop_index(op.f("ix_outbound_mcp_connections_deleted_at"), table_name=TABLE)
    with op.batch_alter_table(TABLE) as batch:
        batch.create_unique_constraint(
            "uq_outbound_mcp_connections_workspace_user_name", ["workspace_id", "user_id", "name"]
        )
        batch.drop_column("deleted_at")

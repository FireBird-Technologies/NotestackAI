"""Enable discovered read-only MCP tools by default.

Revision ID: 0041_auto_enable_read_tools
Revises: 0040_outbound_mcp_soft_delete
Create Date: 2026-11-01
"""

import sqlalchemy as sa

from alembic import op

revision = "0041_auto_enable_read_tools"
down_revision = "0040_outbound_mcp_soft_delete"
branch_labels = None
depends_on = None


def _has_ref(value) -> bool:
    if isinstance(value, dict):
        return "$ref" in value or any(_has_ref(child) for child in value.values())
    if isinstance(value, list):
        return any(_has_ref(child) for child in value)
    return False


def upgrade() -> None:
    table = sa.table(
        "outbound_mcp_connections",
        sa.column("id"),
        sa.column("enabled_tools", sa.JSON()),
        sa.column("discovered_tools", sa.JSON()),
        sa.column("deleted_at", sa.DateTime(timezone=True)),
    )
    bind = op.get_bind()
    rows = bind.execute(
        sa.select(table.c.id, table.c.enabled_tools, table.c.discovered_tools)
        .where(table.c.deleted_at.is_(None))
    ).mappings()
    for row in rows:
        discovered = row["discovered_tools"] or []
        selected = list(dict.fromkeys(row["enabled_tools"] or []))
        selected_set = set(selected)
        for tool in discovered:
            if not isinstance(tool, dict):
                continue
            name = tool.get("name")
            schema = tool.get("input_schema") or {"type": "object", "properties": {}}
            if (
                isinstance(name, str)
                and name
                and tool.get("read_only") is True
                and isinstance(schema, dict)
                and not _has_ref(schema)
                and name not in selected_set
            ):
                selected.append(name)
                selected_set.add(name)
        if selected != (row["enabled_tools"] or []):
            bind.execute(table.update().where(table.c.id == row["id"]).values(enabled_tools=selected))


def downgrade() -> None:
    # Existing explicit and automatically selected tools are indistinguishable, so a downgrade must preserve access.
    pass

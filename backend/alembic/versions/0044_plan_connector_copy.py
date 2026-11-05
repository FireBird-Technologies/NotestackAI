"""Split the pricing connector benefit into Notestack MCP and external tools.

Revision ID: 0044_plan_connector_copy
Revises: 0043_plan_entitlements
Create Date: 2026-11-04
"""

import sqlalchemy as sa

from alembic import op

revision = "0044_plan_connector_copy"
down_revision = "0043_plan_entitlements"
branch_labels = None
depends_on = None

OLD = "MCP and connectors"
NEW = (
    "Use Notestack in ChatGPT, Claude, and more via MCP",
    "Connect Notion, Zapier, and more to your notebooks",
)

plans = sa.table("plans", sa.column("id", sa.String), sa.column("features", sa.JSON))


def _features(plan_id: str) -> list[str] | None:
    value = op.get_bind().execute(sa.select(plans.c.features).where(plans.c.id == plan_id)).scalar()
    return list(value) if value is not None else None


def upgrade() -> None:
    for plan_id in ("free", "starter", "writer", "studio"):
        features = _features(plan_id)
        if features is None or OLD not in features:
            continue
        updated: list[str] = []
        for feature in features:
            updated.extend(NEW if feature == OLD else (feature,))
        op.execute(plans.update().where(plans.c.id == plan_id).values(features=updated))


def downgrade() -> None:
    for plan_id in ("free", "starter", "writer", "studio"):
        features = _features(plan_id)
        if features is None or not any(feature in NEW for feature in features):
            continue
        updated: list[str] = []
        inserted = False
        for feature in features:
            if feature in NEW:
                if not inserted:
                    updated.append(OLD)
                    inserted = True
            else:
                updated.append(feature)
        op.execute(plans.update().where(plans.c.id == plan_id).values(features=updated))

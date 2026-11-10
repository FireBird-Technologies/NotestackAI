"""Make the Free plan's two-report allowance a lifetime total.

Revision ID: 0046_free_reports_lifetime
Revises: 0045_composio_connections
Create Date: 2026-11-10
"""

import sqlalchemy as sa

from alembic import op

revision = "0046_free_reports_lifetime"
down_revision = "0045_composio_connections"
branch_labels = None
depends_on = None

OLD = "2 reports a month"
NEW = "2 reports in total"

plans = sa.table("plans", sa.column("id", sa.String), sa.column("features", sa.JSON))


def _replace(old: str, new: str) -> None:
    features = op.get_bind().execute(sa.select(plans.c.features).where(plans.c.id == "free")).scalar()
    if features is None or old not in features:
        return
    op.execute(
        plans.update().where(plans.c.id == "free").values(
            features=[new if feature == old else feature for feature in features]
        )
    )


def upgrade() -> None:
    _replace(OLD, NEW)


def downgrade() -> None:
    _replace(NEW, OLD)

"""set Starter annual price to 136.99

Revision ID: 0034_starter_annual_price
Revises: 0033_starter_plan
Create Date: 2026-10-29
"""

import sqlalchemy as sa

from alembic import op

revision = "0034_starter_annual_price"
down_revision = "0033_starter_plan"
branch_labels = None
depends_on = None


def upgrade() -> None:
    plans = sa.table(
        "plans",
        sa.column("id", sa.String),
        sa.column("price_annual_usd", sa.Float),
    )
    op.execute(plans.update().where(plans.c.id == "starter").values(price_annual_usd=136.99))


def downgrade() -> None:
    plans = sa.table(
        "plans",
        sa.column("id", sa.String),
        sa.column("price_annual_usd", sa.Float),
    )
    op.execute(plans.update().where(plans.c.id == "starter").values(price_annual_usd=137.88))

"""billing events: Stripe webhook deliveries already handled

Revision ID: 0003_billing_events
Revises: 0002_build_out
Create Date: 2026-09-27
"""
import sqlalchemy as sa
from alembic import op

revision = "0003_billing_events"
down_revision = "0002_build_out"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have the table.
    if "billing_events" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "billing_events",
        sa.Column("id", sa.String(100), primary_key=True),
        sa.Column("type", sa.String(80), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("billing_events")

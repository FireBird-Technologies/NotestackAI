"""users.purged_at: when a deleted account's data was removed for good (the row itself is kept)

Revision ID: 0047_user_purged_at
Revises: 0046_free_reports_lifetime
Create Date: 2026-11-10
"""

import sqlalchemy as sa

from alembic import op

revision = "0047_user_purged_at"
down_revision = "0046_free_reports_lifetime"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("purged_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "purged_at")

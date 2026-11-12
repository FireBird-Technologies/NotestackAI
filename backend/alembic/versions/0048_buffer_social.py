"""Compatibility bridge for a retired social integration revision.

Revision ID: 0048_buffer_social
Revises: 0047_user_purged_at
Create Date: 2026-11-12

Some databases were stamped with this short-lived revision before the integration was removed. Keeping the revision
identifier lets Alembic advance those databases without recreating the retired schema on new installations.
"""

revision = "0048_buffer_social"
down_revision = "0047_user_purged_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass

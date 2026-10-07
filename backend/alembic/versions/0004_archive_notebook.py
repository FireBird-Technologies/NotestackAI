"""notebooks.is_archive: the workspace's always-present "All posts" notebook

Revision ID: 0004_archive_notebook
Revises: 0003_billing_events
Create Date: 2026-09-28
"""
import sqlalchemy as sa
from alembic import op

revision = "0004_archive_notebook"
down_revision = "0003_billing_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have the column.
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("notebooks")}
    if "is_archive" not in columns:
        op.add_column("notebooks", sa.Column("is_archive", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("notebooks", "is_archive")

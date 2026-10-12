"""drop_brand_kit: the brand kit (workspace colors and logo, and the plan flag for it) is gone

Revision ID: 0023_drop_brand_kit
Revises: 0022_report_template_cache
Create Date: 2026-10-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0023_drop_brand_kit"
down_revision = "0022_report_template_cache"
branch_labels = None
depends_on = None


def _has(table: str, column: str) -> bool:
    return column in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    for table, column in (("plans", "brand_kit"), ("workspaces", "brand_json")):
        if _has(table, column):
            with op.batch_alter_table(table) as batch:
                batch.drop_column(column)


def downgrade() -> None:
    if not _has("plans", "brand_kit"):
        op.add_column("plans", sa.Column("brand_kit", sa.Boolean(), nullable=False, server_default=sa.false()))
    if not _has("workspaces", "brand_json"):
        op.add_column("workspaces", sa.Column("brand_json", sa.JSON(), nullable=True))

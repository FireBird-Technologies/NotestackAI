"""infographics_limit: a monthly infographic allowance on each plan

Revision ID: 0019_infographics_limit
Revises: 0018_report_sharing
Create Date: 2026-10-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0019_infographics_limit"
down_revision = "0018_report_sharing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have the column.
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("plans")}
    if "infographics" not in columns:
        op.add_column("plans", sa.Column("infographics", sa.Integer(), nullable=False, server_default="0"))
    op.execute("UPDATE plans SET infographics = CASE id WHEN 'studio' THEN -1 WHEN 'writer' THEN 30 ELSE 2 END")


def downgrade() -> None:
    with op.batch_alter_table("plans") as batch:
        batch.drop_column("infographics")

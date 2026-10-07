"""reports_limit: a monthly report allowance on each plan

Revision ID: 0017_reports_limit
Revises: 0016_support_chat
Create Date: 2026-10-07
"""
import sqlalchemy as sa
from alembic import op

revision = "0017_reports_limit"
down_revision = "0016_support_chat"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have the column.
    columns = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("plans")}
    if "reports" not in columns:
        op.add_column("plans", sa.Column("reports", sa.Integer(), nullable=False, server_default="0"))
    op.execute("UPDATE plans SET reports = CASE id WHEN 'studio' THEN -1 WHEN 'writer' THEN 30 ELSE 2 END")


def downgrade() -> None:
    with op.batch_alter_table("plans") as batch:
        batch.drop_column("reports")

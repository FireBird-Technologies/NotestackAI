"""users.apple_id and users.apple_refresh_token: Sign in with Apple

Revision ID: 0035_apple_sign_in
Revises: 0034_starter_annual_price
Create Date: 2026-10-28
"""

import sqlalchemy as sa

from alembic import op

revision = "0035_apple_sign_in"
down_revision = "0034_starter_annual_price"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # auth_provider is a plain string column (non-native enum), so "apple" needs no type change.
    op.add_column("users", sa.Column("apple_id", sa.String(64), nullable=True))
    op.add_column("users", sa.Column("apple_refresh_token", sa.Text(), nullable=True))
    op.create_unique_constraint("uq_users_apple_id", "users", ["apple_id"])


def downgrade() -> None:
    op.drop_constraint("uq_users_apple_id", "users", type_="unique")
    op.drop_column("users", "apple_refresh_token")
    op.drop_column("users", "apple_id")

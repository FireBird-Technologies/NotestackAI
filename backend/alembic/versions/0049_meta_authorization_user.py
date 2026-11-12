"""Remember the Meta authorization identity for lifecycle callbacks.

Revision ID: 0049_meta_authorization_user
Revises: 0048_buffer_social
Create Date: 2026-11-12
"""

import sqlalchemy as sa

from alembic import op

revision = "0049_meta_authorization_user"
down_revision = "0048_buffer_social"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "social_accounts" in tables:
        columns = {column["name"] for column in inspector.get_columns("social_accounts")}
        indexes = {index["name"] for index in inspector.get_indexes("social_accounts")}
        with op.batch_alter_table("social_accounts") as b:
            if "authorization_user_id" not in columns:
                b.add_column(sa.Column("authorization_user_id", sa.String(200)))
            if "ix_social_accounts_authorization_user_id" not in indexes:
                b.create_index("ix_social_accounts_authorization_user_id", ["authorization_user_id"])
            if "ix_social_accounts_buffer_connection_id" in indexes:
                b.drop_index("ix_social_accounts_buffer_connection_id")
            for name in ("provider", "buffer_connection_id", "organization_id"):
                if name in columns:
                    b.drop_column(name)
    if "buffer_connections" in tables:
        op.drop_table("buffer_connections")


def downgrade() -> None:
    with op.batch_alter_table("social_accounts") as b:
        b.drop_index("ix_social_accounts_authorization_user_id")
        b.drop_column("authorization_user_id")

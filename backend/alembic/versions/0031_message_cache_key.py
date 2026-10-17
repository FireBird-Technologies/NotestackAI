"""messages.cache_key: exact repeats of a chat's first question reuse the saved answer

Revision ID: 0031_message_cache_key
Revises: 0030_thumbs_up_is_one
Create Date: 2026-10-14
"""

import sqlalchemy as sa

from alembic import op

revision = "0031_message_cache_key"
down_revision = "0030_thumbs_up_is_one"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("cache_key", sa.String(64), nullable=True))
    op.create_index("ix_messages_cache_key", "messages", ["cache_key"])


def downgrade() -> None:
    op.drop_index("ix_messages_cache_key", table_name="messages")
    op.drop_column("messages", "cache_key")

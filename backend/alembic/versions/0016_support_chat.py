"""support_chat: conversations and messages for the in app help bot

Revision ID: 0016_support_chat
Revises: 0015_message_feedback
Create Date: 2026-10-06
"""
import sqlalchemy as sa
from alembic import op

revision = "0016_support_chat"
down_revision = "0015_message_feedback"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have these.
    if "support_conversations" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "support_conversations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(200)),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("session_state", sa.JSON(), nullable=False),
        sa.Column("escalation_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_index("ix_support_conversations_user_id", "support_conversations", ["user_id"])
    op.create_table(
        "support_messages",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "conversation_id", sa.Uuid(), sa.ForeignKey("support_conversations.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("page_path", sa.String(300)),
        sa.Column("cited_docs", sa.JSON()),
    )
    op.create_index("ix_support_messages_conversation_id", "support_messages", ["conversation_id"])


def downgrade() -> None:
    op.drop_table("support_messages")
    op.drop_table("support_conversations")

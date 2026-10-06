"""message_feedback: thumbs up/down on chat answers, plus messages.recall_json (how the answer was produced)

Revision ID: 0015_message_feedback
Revises: 0014_chat_citations
Create Date: 2026-10-02
"""
import sqlalchemy as sa
from alembic import op

revision = "0015_message_feedback"
down_revision = "0014_chat_citations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have these.
    insp = sa.inspect(op.get_bind())
    if "recall_json" not in {c["name"] for c in insp.get_columns("messages")}:
        with op.batch_alter_table("messages") as b:
            b.add_column(sa.Column("recall_json", sa.JSON(), nullable=True))
    if "message_feedback" in insp.get_table_names():
        return
    op.create_table(
        "message_feedback",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("notebook_id", sa.Uuid(), sa.ForeignKey("notebooks.id", ondelete="SET NULL")),
        sa.Column("chat_id", sa.Uuid(), sa.ForeignKey("chats.id", ondelete="SET NULL")),
        sa.Column("message_id", sa.Uuid(), sa.ForeignKey("messages.id", ondelete="SET NULL")),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("reasons", sa.JSON(), nullable=False),
        sa.Column("comment", sa.Text()),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column("sources", sa.JSON(), nullable=False),
        sa.Column("recall", sa.JSON(), nullable=False),
    )
    op.create_index("ix_message_feedback_workspace_id", "message_feedback", ["workspace_id"])
    op.create_index("ix_message_feedback_message_id", "message_feedback", ["message_id"], unique=True)


def downgrade() -> None:
    op.drop_table("message_feedback")
    with op.batch_alter_table("messages") as b:
        b.drop_column("recall_json")

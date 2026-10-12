"""artifact_feedback: thumbs up/down on generated reports, quizzes, flashcards and infographics

Revision ID: 0021_artifact_feedback
Revises: 0020_calendar_kit
Create Date: 2026-10-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0021_artifact_feedback"
down_revision = "0020_calendar_kit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have the table.
    if "artifact_feedback" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "artifact_feedback",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("artifact_id", sa.Uuid(), sa.ForeignKey("artifacts.id", ondelete="SET NULL")),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("artifact_type", sa.String(30), nullable=False),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("reasons", sa.JSON(), nullable=False),
        sa.Column("comment", sa.Text()),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.UniqueConstraint("artifact_id", "user_id"),
    )
    op.create_index("ix_artifact_feedback_workspace_id", "artifact_feedback", ["workspace_id"])
    op.create_index("ix_artifact_feedback_artifact_id", "artifact_feedback", ["artifact_id"])


def downgrade() -> None:
    op.drop_table("artifact_feedback")

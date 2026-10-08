"""quiz_attempts: a person's last finished run of a quiz, shown again when they reopen it

Revision ID: 0027_quiz_attempts
Revises: 0026_plan_copy
Create Date: 2026-10-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0027_quiz_attempts"
down_revision = "0026_plan_copy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have the table.
    if "quiz_attempts" in sa.inspect(op.get_bind()).get_table_names():
        return
    op.create_table(
        "quiz_attempts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("artifact_id", sa.Uuid(), sa.ForeignKey("artifacts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
        sa.Column("answers", sa.JSON(), nullable=False),
        sa.UniqueConstraint("artifact_id", "user_id"),
    )
    op.create_index("ix_quiz_attempts_workspace_id", "quiz_attempts", ["workspace_id"])
    op.create_index("ix_quiz_attempts_artifact_id", "quiz_attempts", ["artifact_id"])


def downgrade() -> None:
    op.drop_table("quiz_attempts")

"""a thumbs up is stored as 1: thumbs up saved with stars (2 to 5) become 1, like every new one

Revision ID: 0030_thumbs_up_is_one
Revises: 0029_mcp_widget_state
Create Date: 2026-10-14
"""

from alembic import op

revision = "0030_thumbs_up_is_one"
down_revision = "0029_mcp_widget_state"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE artifact_feedback SET rating = 1 WHERE rating > 1")


def downgrade() -> None:
    pass  # the stars given before are not kept

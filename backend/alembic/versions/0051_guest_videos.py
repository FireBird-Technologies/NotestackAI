"""guest_devices.videos and video_edits: a guest's one video, and the AI edits to it, count on the device too

Revision ID: 0051_guest_videos
Revises: 0050_guests_and_erase
Create Date: 2026-11-25
"""

import sqlalchemy as sa

from alembic import op

revision = "0051_guest_videos"
down_revision = "0050_guests_and_erase"
branch_labels = None
depends_on = None

COLUMNS = ("videos", "video_edits")


def upgrade() -> None:
    have = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("guest_devices")}
    for name in COLUMNS:
        if name not in have:
            op.add_column("guest_devices", sa.Column(name, sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    for name in COLUMNS:
        op.drop_column("guest_devices", name)

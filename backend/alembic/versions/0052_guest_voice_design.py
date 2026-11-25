"""guest_devices.voice_designs and voice_tries: a guest may design one voice, in up to three tries

Revision ID: 0052_guest_voice_design
Revises: 0051_guest_videos
Create Date: 2026-11-25
"""

import sqlalchemy as sa

from alembic import op

revision = "0052_guest_voice_design"
down_revision = "0051_guest_videos"
branch_labels = None
depends_on = None

COLUMNS = ("voice_designs", "voice_tries")


def upgrade() -> None:
    have = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("guest_devices")}
    for name in COLUMNS:
        if name not in have:
            op.add_column("guest_devices", sa.Column(name, sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    for name in COLUMNS:
        op.drop_column("guest_devices", name)

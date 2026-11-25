"""Guests on iOS (guest_devices), and users.erase_requested_at: deleted from the iOS app, erased at once

Revision ID: 0050_guests_and_erase
Revises: 0049_meta_authorization_user
Create Date: 2026-11-25
"""

import sqlalchemy as sa

from alembic import op

revision = "0050_guests_and_erase"
down_revision = "0049_meta_authorization_user"
branch_labels = None
depends_on = None

COUNTERS = ("chat_messages", "audio_overviews", "reports", "infographics", "launch_kits", "study_items", "extras", "posts")


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    # users.auth_provider is a plain string column, so "guest" needs no type change.
    if "erase_requested_at" not in {c["name"] for c in inspector.get_columns("users")}:
        op.add_column("users", sa.Column("erase_requested_at", sa.DateTime(timezone=True), nullable=True))
    if "guest_devices" in inspector.get_table_names():
        return
    op.create_table(
        "guest_devices",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("device_hash", sa.String(64), nullable=False),
        sa.Column("guest_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("epoch", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("exhausted", sa.Boolean(), nullable=False, server_default=sa.false()),
        *(sa.Column(name, sa.Integer(), nullable=False, server_default="0") for name in COUNTERS),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_guest_devices_device_hash", "guest_devices", ["device_hash"], unique=True)
    op.create_index("ix_guest_devices_guest_id", "guest_devices", ["guest_id"])


def downgrade() -> None:
    op.drop_table("guest_devices")
    op.drop_column("users", "erase_requested_at")

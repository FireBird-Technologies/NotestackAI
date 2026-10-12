"""Longer artifact status

A video's artifact now takes blog2video's job statuses as they are (e.g. "language_regenerating", 21 characters),
which do not fit the old 20.

Revision ID: 0012_artifact_status_len
Revises: 0011_one_archive_notebook
Create Date: 2026-10-02
"""
import sqlalchemy as sa
from alembic import op

revision = "0012_artifact_status_len"
down_revision = "0011_one_archive_notebook"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("artifacts") as batch:
        batch.alter_column("status", existing_type=sa.String(20), type_=sa.String(40), existing_nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("artifacts") as batch:
        batch.alter_column("status", existing_type=sa.String(40), type_=sa.String(20), existing_nullable=False)

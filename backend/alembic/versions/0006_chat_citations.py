"""citations.kind: a citation can point at an earlier chat (no document) as well as a post

Revision ID: 0006_chat_citations
Revises: 0005_workspace_memory
Create Date: 2026-10-01
"""
import sqlalchemy as sa
from alembic import op

revision = "0006_chat_citations"
down_revision = "0005_workspace_memory"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have the column.
    columns = {c["name"]: c for c in sa.inspect(op.get_bind()).get_columns("citations")}
    with op.batch_alter_table("citations") as b:
        if "kind" not in columns:
            b.add_column(sa.Column("kind", sa.String(10), nullable=False, server_default="post"))
        if not columns["document_id"]["nullable"]:
            b.alter_column("document_id", existing_type=sa.Uuid(), nullable=True)


def downgrade() -> None:
    op.execute("DELETE FROM citations WHERE document_id IS NULL")  # a chat citation has no document to point at
    with op.batch_alter_table("citations") as b:
        b.alter_column("document_id", existing_type=sa.Uuid(), nullable=False)
        b.drop_column("kind")

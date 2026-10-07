"""calendar_items.kit_id: the Launch Kit a scheduled post was written from, kept apart from its attachment

Revision ID: 0017_calendar_kit
Revises: 0016_support_chat
Create Date: 2026-10-06
"""
import sqlalchemy as sa
from alembic import op

revision = "0017_calendar_kit"
down_revision = "0016_support_chat"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database may already have the column.
    if "kit_id" not in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("calendar_items")}:
        with op.batch_alter_table("calendar_items") as batch:
            batch.add_column(sa.Column("kit_id", sa.Uuid(), nullable=True))
            batch.create_foreign_key("fk_calendar_items_kit_id", "artifacts", ["kit_id"], ["id"], ondelete="SET NULL")
    # Posts that carried a Launch Kit as their "attachment": the kit is where they came from, not an attachment.
    op.execute("UPDATE calendar_items SET kit_id = artifact_id, artifact_id = NULL "
               "WHERE artifact_id IN (SELECT id FROM artifacts WHERE type = 'launch_kit')")


def downgrade() -> None:
    op.execute("UPDATE calendar_items SET artifact_id = kit_id WHERE artifact_id IS NULL AND kit_id IS NOT NULL")
    # The foreign key is named here, or by the database when 0001 made the column from the models.
    fks = [fk["name"] for fk in sa.inspect(op.get_bind()).get_foreign_keys("calendar_items")
           if fk["constrained_columns"] == ["kit_id"] and fk.get("name")]
    with op.batch_alter_table("calendar_items") as batch:
        for name in fks:
            batch.drop_constraint(name, type_="foreignkey")
        batch.drop_column("kit_id")

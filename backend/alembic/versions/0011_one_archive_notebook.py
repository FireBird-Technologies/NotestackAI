"""One "All posts" notebook per workspace

Two requests opening the Notebooks page at once could each create the archive notebook. This merges the copies into
the oldest one (its posts, chats and artifacts move over) and adds a unique index so it cannot happen again.

Revision ID: 0011_one_archive_notebook
Revises: 0010_b2v_video_refs
Create Date: 2026-10-01
"""
import sqlalchemy as sa
from alembic import op

revision = "0011_one_archive_notebook"
down_revision = "0010_b2v_video_refs"
branch_labels = None
depends_on = None

INDEX = "uq_notebooks_one_archive"


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.text(
        "SELECT workspace_id, id FROM notebooks WHERE is_archive ORDER BY workspace_id, created_at, id"
    )).all()
    keep: dict = {}
    for ws, nb in rows:
        if ws not in keep:
            keep[ws] = nb
            continue
        ids = {"keep": keep[ws], "dup": nb}
        conn.execute(sa.text(
            "INSERT INTO notebook_documents (notebook_id, document_id) "
            "SELECT :keep, document_id FROM notebook_documents WHERE notebook_id = :dup AND document_id NOT IN "
            "(SELECT document_id FROM notebook_documents WHERE notebook_id = :keep)"
        ), ids)
        conn.execute(sa.text("UPDATE chats SET notebook_id = :keep WHERE notebook_id = :dup"), ids)
        conn.execute(sa.text("UPDATE artifacts SET notebook_id = :keep WHERE notebook_id = :dup"), ids)
        conn.execute(sa.text("DELETE FROM notebooks WHERE id = :dup"), ids)

    # 0001 builds from the live models, so a fresh database may already have the index.
    if INDEX not in {i["name"] for i in sa.inspect(conn).get_indexes("notebooks")}:
        op.create_index(INDEX, "notebooks", ["workspace_id"], unique=True,
                        postgresql_where=sa.text("is_archive"), sqlite_where=sa.text("is_archive"))


def downgrade() -> None:
    op.drop_index(INDEX, table_name="notebooks")

"""link_videos_to_notebooks: videos made before they were linked to their notebook get linked now

A video made from one post is linked to the notebook that post is in, when there is just one (besides the whole archive);
a post only in the archive links it to the archive. A post in several notebooks leaves the video unlinked.

Revision ID: 0027_link_videos_to_notebooks
Revises: 0026_plan_copy
Create Date: 2026-10-13
"""
import sqlalchemy as sa
from alembic import op

revision = "0027_link_videos_to_notebooks"
down_revision = "0026_plan_copy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    db = op.get_bind()
    videos = db.execute(sa.text(
        "SELECT id, workspace_id, document_id FROM artifacts "
        "WHERE type = 'video' AND notebook_id IS NULL AND document_id IS NOT NULL")).all()
    for video_id, workspace_id, document_id in videos:
        rows = db.execute(sa.text(
            "SELECT n.id, n.is_archive FROM notebooks n JOIN notebook_documents nd ON nd.notebook_id = n.id "
            "WHERE nd.document_id = :doc AND n.workspace_id = :ws"), {"doc": document_id, "ws": workspace_id}).all()
        own = [nid for nid, archive in rows if not archive]
        archive = [nid for nid, is_archive in rows if is_archive]
        target = own[0] if len(own) == 1 else (archive[0] if not own and archive else None)
        if target is not None:
            db.execute(sa.text("UPDATE artifacts SET notebook_id = :nb WHERE id = :id"), {"nb": target, "id": video_id})


def downgrade() -> None:
    pass  # the links are harmless to keep

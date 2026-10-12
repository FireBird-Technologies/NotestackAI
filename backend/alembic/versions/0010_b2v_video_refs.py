"""b2v_videos holds each video's full reference (who made it, title, source, links); video limits 1 total / 10 / 20

- b2v_videos: user_id, title, source_url, aspect_ratio, preview_url, video_url, backfilled from the workspace owner
  and the linked artifact.
- plans: videos_monthly (False on Free: 1 video in total, never refilled); Studio 20 videos a month.

Revision ID: 0010_b2v_video_refs
Revises: 0009_b2v_resources
Create Date: 2026-09-30
"""
import json

import sqlalchemy as sa
from alembic import op

revision = "0010_b2v_video_refs"
down_revision = "0009_b2v_resources"
branch_labels = None
depends_on = None

VIDEO_COLUMNS = {
    "user_id": lambda: sa.Column("user_id", sa.Uuid(), nullable=True),
    "title": lambda: sa.Column("title", sa.String(300), nullable=True),
    "source_url": lambda: sa.Column("source_url", sa.String(2000), nullable=True),
    "aspect_ratio": lambda: sa.Column("aspect_ratio", sa.String(20), nullable=True),
    "preview_url": lambda: sa.Column("preview_url", sa.String(1000), nullable=True),
    "video_url": lambda: sa.Column("video_url", sa.String(1000), nullable=True),
}

# Same as app/services/plans.py
PLAN_VIDEOS = {"free": (1, False, "1 video a month", "1 video to try it"),
               "writer": (10, True, None, None),
               "studio": (20, True, "30 videos a month", "20 videos a month")}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 0001 builds from the live models, so a fresh database may already have these columns.
    existing = {c["name"] for c in inspector.get_columns("b2v_videos")}
    missing = [make() for name, make in VIDEO_COLUMNS.items() if name not in existing]
    if missing:
        with op.batch_alter_table("b2v_videos") as batch:
            for column in missing:
                batch.add_column(column)
            if "user_id" not in existing:
                batch.create_foreign_key("fk_b2v_videos_user_id_users", "users", ["user_id"], ["id"],
                                         ondelete="SET NULL")
                batch.create_index("ix_b2v_videos_user_id", ["user_id"])

    # Backfill: the workspace owner made it; title and links come from the artifact.
    rows = bind.execute(sa.text("""
        SELECT v.id, w.owner_id, a.content_json FROM b2v_videos v
        JOIN workspaces w ON w.id = v.workspace_id
        LEFT JOIN artifacts a ON a.id = v.artifact_id
        WHERE v.user_id IS NULL
    """)).fetchall()
    for vid, owner_id, content in rows:
        c = content if isinstance(content, dict) else json.loads(content or "{}")
        bind.execute(sa.text("""
            UPDATE b2v_videos SET user_id = :u, title = COALESCE(title, :t), aspect_ratio = COALESCE(aspect_ratio, :ar),
                   preview_url = COALESCE(preview_url, :p), video_url = COALESCE(video_url, :v) WHERE id = :id
        """), {"u": owner_id, "t": (c.get("title") or None), "ar": c.get("aspect_ratio"), "p": c.get("preview_url"),
               "v": c.get("video_url"), "id": vid})

    plan_cols = {c["name"] for c in inspector.get_columns("plans")}
    if "videos_monthly" not in plan_cols:
        with op.batch_alter_table("plans") as batch:
            batch.add_column(sa.Column("videos_monthly", sa.Boolean(), nullable=False, server_default=sa.true()))
    for plan_id, (videos, monthly, old, new) in PLAN_VIDEOS.items():
        row = bind.execute(sa.text("SELECT features FROM plans WHERE id = :id"), {"id": plan_id}).fetchone()
        if row is None:
            continue
        features = row[0] if isinstance(row[0], list) else json.loads(row[0] or "[]")
        if old:
            features = [new if f == old else f for f in features]
        bind.execute(sa.text("UPDATE plans SET videos = :v, videos_monthly = :m, features = :f WHERE id = :id"),
                     {"v": videos, "m": monthly, "f": json.dumps(features), "id": plan_id})


def downgrade() -> None:
    with op.batch_alter_table("plans") as batch:
        batch.drop_column("videos_monthly")
    # A database built from the models (0001) names these differently, so look them up.
    inspector = sa.inspect(op.get_bind())
    fks = [fk["name"] for fk in inspector.get_foreign_keys("b2v_videos")
           if fk["constrained_columns"] == ["user_id"] and fk.get("name")]
    indexes = [ix["name"] for ix in inspector.get_indexes("b2v_videos") if ix["column_names"] == ["user_id"]]
    with op.batch_alter_table("b2v_videos") as batch:
        for name in indexes:
            batch.drop_index(name)
        for name in fks:
            batch.drop_constraint(name, type_="foreignkey")
        for name in reversed(list(VIDEO_COLUMNS)):
            batch.drop_column(name)

"""plan_copy: Free gets 1 video; Writer and Studio audio copy is relative to Free ("10x / 40x more audio overviews than Free")

Revision ID: 0026_plan_copy
Revises: 0025_drop_video_premium
Create Date: 2026-10-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0026_plan_copy"
down_revision = "0025_drop_video_premium"
branch_labels = None
depends_on = None

ORIGINAL = {
    "free": "2 videos",
    "writer": "60 min of audio overviews a month",
    "studio": "240 min of audio overviews a month",
}
NEW = {
    "free": "1 video",
    "writer": "10x more audio overviews than Free",
    "studio": "40x more audio overviews than Free",
}
# An earlier draft of this migration wrote the line with a bracket; a database that ran it has this text.
BRACKETED = {
    "writer": "10x more audio overviews than Free (60 min a month)",
    "studio": "40x more audio overviews than Free (240 min a month)",
}


def _swap(plan_id: str, old: list[str], new: str, videos: int | None = None) -> None:
    plans = sa.table("plans", sa.column("id", sa.String), sa.column("videos", sa.Integer), sa.column("features", sa.JSON))
    features = op.get_bind().execute(sa.select(plans.c.features).where(plans.c.id == plan_id)).scalar()
    if features is None:
        return
    values = {"features": [new if f in old else f for f in features]}
    if videos is not None:
        values["videos"] = videos
    op.execute(plans.update().where(plans.c.id == plan_id).values(**values))


def upgrade() -> None:
    _swap("free", [ORIGINAL["free"]], NEW["free"], videos=1)
    for plan_id in ("writer", "studio"):
        _swap(plan_id, [ORIGINAL[plan_id], BRACKETED[plan_id]], NEW[plan_id])


def downgrade() -> None:
    _swap("free", [NEW["free"]], ORIGINAL["free"], videos=2)
    for plan_id in ("writer", "studio"):
        _swap(plan_id, [NEW[plan_id], BRACKETED[plan_id]], ORIGINAL[plan_id])

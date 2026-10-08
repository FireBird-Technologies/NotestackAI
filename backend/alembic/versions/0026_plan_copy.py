"""plan_copy: Free gets 1 video; Writer and Studio audio copy is relative to Free

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

SWAPS = {
    "free": {"2 videos": "1 video"},
    "writer": {"60 min of audio overviews a month": "10x more audio overviews than Free (60 min a month)"},
    "studio": {"240 min of audio overviews a month": "40x more audio overviews than Free (240 min a month)"},
}


def _swap(rows: dict) -> None:
    plans = sa.table("plans", sa.column("id", sa.String), sa.column("videos", sa.Integer), sa.column("features", sa.JSON))
    bind = op.get_bind()
    for plan_id, swaps in rows.items():
        features = bind.execute(sa.select(plans.c.features).where(plans.c.id == plan_id)).scalar()
        if features is None:
            continue
        values = {"features": [swaps.get(f, f) for f in features]}
        if plan_id == "free":
            values["videos"] = 1 if "1 video" in swaps.values() else 2
        op.execute(plans.update().where(plans.c.id == plan_id).values(**values))


def upgrade() -> None:
    _swap(SWAPS)


def downgrade() -> None:
    _swap({k: {v: o for o, v in d.items()} for k, d in SWAPS.items()})

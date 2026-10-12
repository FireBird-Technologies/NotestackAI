"""blog2video resources per workspace: templates, custom voices, saved voices, styles, usage counters;
b2v_videos.created_via / template_ref; plans.video_premium / video_limits

Everything made with our blog2video key belongs to one account, so these tables are what keeps each workspace's
templates, voices and styles its own (app/services/b2v_access.py).

Revision ID: 0009_b2v_resources
Revises: 0008_b2v_videos
Create Date: 2026-09-30
"""
import json

import sqlalchemy as sa
from alembic import op

revision = "0009_b2v_resources"
down_revision = "0008_b2v_videos"
branch_labels = None
depends_on = None

# Same as app/services/plans.py
VIDEO_LIMITS = {
    "free": {"ai_edits": 20, "templates": 0, "template_ai_daily": 0, "voice_designs_daily": 0,
             "voice_samples_daily": 0, "custom_voices": 0},
    "writer": {"ai_edits": 300, "templates": 2, "template_ai_daily": 3, "voice_designs_daily": 5,
               "voice_samples_daily": 20, "custom_voices": 3},
    "studio": {"ai_edits": 1000, "templates": 5, "template_ai_daily": 5, "voice_designs_daily": 10,
               "voice_samples_daily": 40, "custom_voices": 10},
}


def _ws() -> sa.Column:
    return sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False,
                     index=True)


def _times() -> list[sa.Column]:
    return [sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # 0001 builds from the live models, so a fresh database may already have all of this.
    video_cols = {c["name"] for c in inspector.get_columns("b2v_videos")}
    with op.batch_alter_table("b2v_videos") as batch:
        if "created_via" not in video_cols:
            batch.add_column(sa.Column("created_via", sa.String(10), nullable=False, server_default="v1"))
        if "template_ref" not in video_cols:
            batch.add_column(sa.Column("template_ref", sa.String(100), nullable=True))
        batch.alter_column("idempotency_key", existing_type=sa.String(100), nullable=True)

    if not inspector.has_table("b2v_templates"):
        op.create_table("b2v_templates",
                        sa.Column("b2v_template_id", sa.Integer(), primary_key=True, autoincrement=False), _ws(),
                        sa.Column("name", sa.String(255), nullable=False),
                        sa.Column("ready", sa.Boolean(), nullable=False, server_default=sa.false()), *_times())
    if not inspector.has_table("b2v_custom_voices"):
        op.create_table("b2v_custom_voices",
                        sa.Column("b2v_custom_voice_id", sa.Integer(), primary_key=True, autoincrement=False), _ws(),
                        sa.Column("voice_id", sa.String(100), nullable=False, unique=True),
                        sa.Column("name", sa.String(255), nullable=False),
                        sa.Column("source", sa.String(20), nullable=False),
                        sa.Column("preview_url", sa.String(1000), nullable=True), *_times())
    if not inspector.has_table("user_saved_voices"):
        op.create_table("user_saved_voices",
                        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
                                  primary_key=True),
                        sa.Column("voice_id", sa.String(100), primary_key=True),
                        sa.Column("name", sa.String(255), nullable=False),
                        sa.Column("preview_url", sa.String(1000), nullable=True),
                        sa.Column("gender", sa.String(20), nullable=True),
                        sa.Column("accent", sa.String(50), nullable=True),
                        sa.Column("premium", sa.Boolean(), nullable=False, server_default=sa.false()),
                        sa.Column("is_custom", sa.Boolean(), nullable=False, server_default=sa.false()), *_times())
    if not inspector.has_table("b2v_styles"):
        op.create_table("b2v_styles",
                        sa.Column("b2v_style_id", sa.Integer(), primary_key=True, autoincrement=False), _ws(),
                        sa.Column("name", sa.String(80), nullable=False), *_times())
    if not inspector.has_table("usage_counters"):
        op.create_table("usage_counters",
                        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
                                  primary_key=True),
                        sa.Column("period", sa.String(10), primary_key=True),
                        sa.Column("metric", sa.String(30), primary_key=True),
                        sa.Column("used", sa.Integer(), nullable=False, server_default="0"))

    plan_cols = {c["name"] for c in inspector.get_columns("plans")}
    with op.batch_alter_table("plans") as batch:
        if "video_premium" not in plan_cols:
            batch.add_column(sa.Column("video_premium", sa.Boolean(), nullable=False, server_default=sa.false()))
        if "video_limits" not in plan_cols:
            batch.add_column(sa.Column("video_limits", sa.JSON(), nullable=True))
    plans = sa.table("plans", sa.column("id", sa.String), sa.column("video_premium", sa.Boolean),
                     sa.column("video_limits", sa.JSON))
    for plan_id, limits in VIDEO_LIMITS.items():
        op.execute(plans.update().where(plans.c.id == plan_id)
                   .values(video_premium=plan_id != "free", video_limits=json.loads(json.dumps(limits))))


def downgrade() -> None:
    with op.batch_alter_table("plans") as batch:
        batch.drop_column("video_limits")
        batch.drop_column("video_premium")
    for table in ("usage_counters", "b2v_styles", "user_saved_voices", "b2v_custom_voices", "b2v_templates"):
        op.drop_table(table)
    with op.batch_alter_table("b2v_videos") as batch:
        batch.drop_column("template_ref")
        batch.drop_column("created_via")

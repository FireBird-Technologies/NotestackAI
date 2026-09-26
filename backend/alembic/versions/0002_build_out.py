"""build out: social accounts, topics, launchpad fields, resurfacing, host voices

Revision ID: 0002_build_out
Revises: 0001_initial
Create Date: 2026-09-27
"""
import sqlalchemy as sa
from alembic import op

revision = "0002_build_out"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 builds from the live models, so a fresh database already has everything below.
    # Only apply what is missing, which makes this safe on both fresh and existing databases.
    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())
    if "social_accounts" in tables and "evergreen_score" in {c["name"] for c in insp.get_columns("documents")}:
        return
    op.create_table(
        "social_accounts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("platform", sa.String(20), nullable=False),
        sa.Column("handle", sa.String(200), nullable=False),
        sa.Column("external_id", sa.String(200), nullable=False),
        sa.Column("access_token", sa.Text(), nullable=False),
        sa.Column("refresh_token", sa.Text()),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("scopes", sa.String(500)),
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column("avatar_url", sa.String(1000)),
        sa.UniqueConstraint("workspace_id", "platform", "external_id"),
    )
    op.create_table(
        "topics",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("slug", sa.String(200), nullable=False),
        sa.Column("summary", sa.Text()),
        sa.Column("post_count", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("workspace_id", "slug"),
    )
    op.create_table(
        "document_topics",
        sa.Column("document_id", sa.Uuid(), sa.ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("topic_id", sa.Uuid(), sa.ForeignKey("topics.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("weight", sa.Float(), nullable=False, server_default="1"),
    )
    with op.batch_alter_table("documents") as b:
        b.add_column(sa.Column("evergreen_score", sa.Float()))
        b.add_column(sa.Column("last_resurfaced_at", sa.DateTime(timezone=True)))
    with op.batch_alter_table("voice_profiles") as b:
        b.add_column(sa.Column("host_voices", sa.JSON(), nullable=False, server_default="{}"))
    with op.batch_alter_table("calendar_items") as b:
        b.alter_column("artifact_id", existing_type=sa.Uuid(), nullable=True)
        b.add_column(sa.Column("document_id", sa.Uuid(), sa.ForeignKey(
            "documents.id", name="fk_calendar_items_document_id", ondelete="SET NULL")))
        b.add_column(sa.Column("content", sa.Text(), nullable=False, server_default=""))
        b.add_column(sa.Column("thread", sa.JSON(), nullable=False, server_default="[]"))
        b.add_column(sa.Column("social_account_id", sa.Uuid(), sa.ForeignKey(
            "social_accounts.id", name="fk_calendar_items_social_account_id", ondelete="SET NULL")))
        b.add_column(sa.Column("remind_by_email", sa.Boolean(), nullable=False, server_default=sa.false()))
        b.add_column(sa.Column("external_id", sa.String(200)))
        b.add_column(sa.Column("external_url", sa.String(1000)))
        b.add_column(sa.Column("posted_at", sa.DateTime(timezone=True)))
        b.add_column(sa.Column("error", sa.Text()))
        b.add_column(sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"))
        b.add_column(sa.Column("metrics", sa.JSON(), nullable=False, server_default="{}"))
        b.create_index("ix_calendar_items_scheduled_at", ["scheduled_at"])


def downgrade() -> None:
    with op.batch_alter_table("calendar_items") as b:
        b.drop_index("ix_calendar_items_scheduled_at")
        for col in ("metrics", "attempts", "error", "posted_at", "external_url", "external_id", "remind_by_email",
                    "social_account_id", "thread", "content", "document_id"):
            b.drop_column(col)
    with op.batch_alter_table("voice_profiles") as b:
        b.drop_column("host_voices")
    with op.batch_alter_table("documents") as b:
        b.drop_column("last_resurfaced_at")
        b.drop_column("evergreen_score")
    op.drop_table("document_topics")
    op.drop_table("topics")
    op.drop_table("social_accounts")

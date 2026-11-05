"""Expand every pricing plan with notebooks, chat, connectors and voice cloning.

Revision ID: 0043_plan_entitlements
Revises: 0042_apple_sign_in
Create Date: 2026-11-04
"""

import sqlalchemy as sa

from alembic import op

revision = "0043_plan_entitlements"
down_revision = "0042_apple_sign_in"
branch_labels = None
depends_on = None


OLD = {
    "free": {
        "indexed_posts": 5,
        "chat_messages": 10,
        "voice_cloning": False,
        "features": [
            "Up to 5 posts indexed, from any source",
            "10 research chat messages with citations",
            "1 audio overview, any length",
            "1 video",
            "2 Launch Kits",
            "2 infographics",
            "2 reports a month",
        ],
    },
    "starter": {
        "indexed_posts": 30,
        "chat_messages": -1,
        "voice_cloning": False,
        "features": [
            "Up to 30 posts indexed, from any source",
            "Unlimited research chat",
            "5x more audio overviews than Free",
            "5 videos a month",
            "20 Launch Kits a month",
            "20 reports a month",
            "20 infographics a month",
        ],
    },
    "writer": {
        "indexed_posts": 100,
        "chat_messages": -1,
        "voice_cloning": True,
        "features": [
            "Up to 100 posts indexed, from any source",
            "Unlimited research chat",
            "10x more audio overviews than Free",
            "10 videos a month",
            "40 Launch Kits a month",
            "50 reports a month",
            "50 infographics a month",
            "Voice cloning with consent",
        ],
    },
    "studio": {
        "indexed_posts": 250,
        "chat_messages": -1,
        "voice_cloning": True,
        "features": [
            "Up to 250 posts indexed, from any source",
            "Unlimited research chat",
            "40x more audio overviews than Free",
            "20 videos a month",
            "Unlimited Launch Kits",
            "Unlimited reports",
            "Unlimited infographics",
            "Launchpad calendar and resurfacing",
            "Priority rendering",
        ],
    },
}

NEW = {
    "free": {
        "indexed_posts": 10,
        "chat_messages": 10,
        "voice_cloning": False,
        "features": [
            "Unlimited notebooks",
            "10 posts per notebook",
            "1 cinematic video",
            "Use Notestack in ChatGPT, Claude, and more via MCP",
            "Connect Notion, Zapier, and more to your notebooks",
            "1 audio overview, any length",
            "2 Launch Kits",
            "2 infographics",
            "2 reports a month",
        ],
    },
    "starter": {
        "indexed_posts": 100,
        "chat_messages": -1,
        "voice_cloning": True,
        "features": [
            "Unlimited notebooks",
            "Unlimited chats",
            "100 posts per notebook",
            "5 cinematic videos a month",
            "Use Notestack in ChatGPT, Claude, and more via MCP",
            "Connect Notion, Zapier, and more to your notebooks",
            "Unlimited voice cloning",
            "5x more audio overviews than Free",
            "20 Launch Kits a month",
            "20 reports a month",
            "20 infographics a month",
        ],
    },
    "writer": {
        "indexed_posts": 300,
        "chat_messages": -1,
        "voice_cloning": True,
        "features": [
            "Unlimited notebooks",
            "Unlimited chats",
            "300 posts per notebook",
            "10 cinematic videos a month",
            "Use Notestack in ChatGPT, Claude, and more via MCP",
            "Connect Notion, Zapier, and more to your notebooks",
            "Unlimited voice cloning",
            "10x more audio overviews than Free",
            "40 Launch Kits a month",
            "50 reports a month",
            "50 infographics a month",
        ],
    },
    "studio": {
        "indexed_posts": 500,
        "chat_messages": -1,
        "voice_cloning": True,
        "features": [
            "Unlimited notebooks",
            "Unlimited chats",
            "500 posts per notebook",
            "20 cinematic videos a month",
            "Use Notestack in ChatGPT, Claude, and more via MCP",
            "Connect Notion, Zapier, and more to your notebooks",
            "Unlimited voice cloning",
            "40x more audio overviews than Free",
            "Unlimited Launch Kits",
            "Unlimited reports",
            "Unlimited infographics",
            "Launchpad calendar and resurfacing",
            "Priority rendering",
        ],
    },
}


def _write(values: dict[str, dict]) -> None:
    plans = sa.table(
        "plans",
        sa.column("id", sa.String),
        sa.column("indexed_posts", sa.Integer),
        sa.column("chat_messages", sa.Integer),
        sa.column("voice_cloning", sa.Boolean),
        sa.column("features", sa.JSON),
    )
    for plan_id, plan in values.items():
        op.execute(plans.update().where(plans.c.id == plan_id).values(**plan))


def upgrade() -> None:
    _write(NEW)


def downgrade() -> None:
    _write(OLD)

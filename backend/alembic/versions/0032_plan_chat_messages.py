"""plans.chat_messages: Free gets 10 chat questions in total; Writer and Studio stay unlimited

Revision ID: 0032_plan_chat_messages
Revises: 0031_message_cache_key
Create Date: 2026-10-16
"""

import sqlalchemy as sa

from alembic import op

revision = "0032_plan_chat_messages"
down_revision = "0031_message_cache_key"
branch_labels = None
depends_on = None

FREE_OLD = "Grounded research chat with citations"
FREE_NEW = "10 research chat messages with citations"
PAID_LINE = "Unlimited research chat"

plans = sa.table("plans", sa.column("id", sa.String), sa.column("chat_messages", sa.Integer), sa.column("features", sa.JSON))


def _features(plan_id: str, change) -> None:
    features = op.get_bind().execute(sa.select(plans.c.features).where(plans.c.id == plan_id)).scalar()
    if features is not None:
        op.execute(plans.update().where(plans.c.id == plan_id).values(features=change(list(features))))


def upgrade() -> None:
    op.add_column("plans", sa.Column("chat_messages", sa.Integer, nullable=False, server_default="-1"))
    op.execute(plans.update().where(plans.c.id == "free").values(chat_messages=10))
    _features("free", lambda f: [FREE_NEW if x == FREE_OLD else x for x in f])
    for plan_id in ("writer", "studio"):
        _features(plan_id, lambda f: f if PAID_LINE in f else [*f[:1], PAID_LINE, *f[1:]])


def downgrade() -> None:
    _features("free", lambda f: [FREE_OLD if x == FREE_NEW else x for x in f])
    for plan_id in ("writer", "studio"):
        _features(plan_id, lambda f: [x for x in f if x != PAID_LINE])
    op.drop_column("plans", "chat_messages")

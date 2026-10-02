"""subscriptions.plan -> plans.id: the plan is picked from the plans table, not typed as free text

Unknown plan values (typos, removed plans) become 'free' first so the constraint can be added.

Revision ID: 0007_subscription_plan_fk
Revises: 0006_plans
Create Date: 2026-09-29
"""
import sqlalchemy as sa
from alembic import op

revision = "0007_subscription_plan_fk"
down_revision = "0006_plans"
branch_labels = None
depends_on = None

NAME = "fk_subscriptions_plan_plans"


def upgrade() -> None:
    bind = op.get_bind()
    # 0001 builds from the live models, so a fresh database may already have the constraint.
    if any(fk["referred_table"] == "plans" for fk in sa.inspect(bind).get_foreign_keys("subscriptions")):
        return
    op.execute("UPDATE subscriptions SET plan = 'free' WHERE plan IS NULL OR plan NOT IN (SELECT id FROM plans)")
    with op.batch_alter_table("subscriptions") as batch:
        batch.create_foreign_key(NAME, "plans", ["plan"], ["id"], onupdate="CASCADE")


def downgrade() -> None:
    fks = sa.inspect(op.get_bind()).get_foreign_keys("subscriptions")
    name = next((fk["name"] for fk in fks if fk["referred_table"] == "plans"), None)
    if not name:
        return  # unnamed (built by 0001 on SQLite): nothing we can drop by name
    with op.batch_alter_table("subscriptions") as batch:
        batch.drop_constraint(name, type_="foreignkey")

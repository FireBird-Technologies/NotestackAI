import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import IdMixin, TimestampMixin


class AuthProvider(str, enum.Enum):
    GOOGLE = "google"
    EMAIL = "email"


class User(IdMixin, TimestampMixin, Base):
    """One auth provider per account for life, no linking (same rule as blog2video)."""

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(200))
    avatar_url: Mapped[str | None] = mapped_column(String(1000))
    auth_provider: Mapped[AuthProvider] = mapped_column(Enum(AuthProvider, native_enum=False, length=16))
    google_id: Mapped[str | None] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str | None] = mapped_column(String(200))
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    email_unsubscribed: Mapped[bool] = mapped_column(Boolean, default=False)
    welcome_email_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    memberships: Mapped[list["WorkspaceMember"]] = relationship(back_populates="user")


class Workspace(IdMixin, TimestampMixin, Base):
    __tablename__ = "workspaces"

    name: Mapped[str] = mapped_column(String(200))
    owner_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"))
    training_opt_in: Mapped[bool] = mapped_column(Boolean, default=False)
    # Off: no report of this workspace can be shared by link, and existing links stop working.
    allow_public_links: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())

    members: Mapped[list["WorkspaceMember"]] = relationship(back_populates="workspace")


class WorkspaceMember(IdMixin, TimestampMixin, Base):
    __tablename__ = "workspace_members"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id"),)

    workspace_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(20), default="owner")

    workspace: Mapped[Workspace] = relationship(back_populates="members")
    user: Mapped[User] = relationship(back_populates="memberships")


class Subscription(IdMixin, TimestampMixin, Base):
    __tablename__ = "subscriptions"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"), unique=True
    )
    # A row of the plans table. Only kept while status is active/trialing/past_due (see plans.effective_plan).
    plan: Mapped[str] = mapped_column(String(20), ForeignKey("plans.id", onupdate="CASCADE"), default="free")
    status: Mapped[str] = mapped_column(String(20), default="active")
    provider: Mapped[str | None] = mapped_column(String(20))
    provider_customer_id: Mapped[str | None] = mapped_column(String(100))
    provider_subscription_id: Mapped[str | None] = mapped_column(String(100))
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Video allowance, enforced by us (see app/services/video_quota.py): +1 per video before we call blog2video,
    # -1 when it fails; video_plan/video_limit follow the effective plan and videos_used resets each period.
    video_plan: Mapped[str] = mapped_column(String(20), default="free", server_default="free")
    videos_used: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    video_limit: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    videos_period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PlanRecord(TimestampMixin, Base):
    """One row per plan: limits, price and pricing-page copy. Edit a row to change a plan without a deploy
    (app/services/plans.py reloads within a minute). Ids are fixed: Stripe prices and subscriptions use them."""

    __tablename__ = "plans"

    id: Mapped[str] = mapped_column(String(20), primary_key=True)  # free | writer | studio
    sort_order: Mapped[int] = mapped_column(Integer, default=0)  # cheapest first; upgrades go up this order
    name: Mapped[str] = mapped_column(String(50))
    tagline: Mapped[str] = mapped_column(String(200), default="")
    price_monthly_usd: Mapped[float] = mapped_column(Float, default=0)
    sources: Mapped[int] = mapped_column(Integer, default=1)
    indexed_posts: Mapped[int] = mapped_column(Integer, default=5)
    audio_minutes: Mapped[int] = mapped_column(Integer, default=0)
    videos: Mapped[int] = mapped_column(Integer, default=0)
    launch_kits: Mapped[int] = mapped_column(Integer, default=0)  # -1 = unlimited
    reports: Mapped[int] = mapped_column(Integer, default=0, server_default="0")  # per month, -1 = unlimited
    infographics: Mapped[int] = mapped_column(Integer, default=0, server_default="0")  # per month, -1 = unlimited
    audio_overviews: Mapped[int] = mapped_column(Integer, default=-1, server_default="-1")  # allowed (in total on Free); -1 = no cap
    voice_cloning: Mapped[bool] = mapped_column(Boolean, default=False)
    features: Mapped[list] = mapped_column(JSON, default=list)  # bullet points on the pricing page
    # Server defaults: 0006 seeds this table without these columns on a database 0001 built from the models.
    # False: `videos` is a lifetime total that never refills (Free). True: per month.
    videos_monthly: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    video_limits: Mapped[dict | None] = mapped_column(JSON, default=dict)  # see plans.VIDEO_LIMITS


class BillingEvent(Base):
    """Stripe webhook events already handled, so a retried delivery never sends a second email."""

    __tablename__ = "billing_events"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)  # Stripe event id (evt_...)
    type: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

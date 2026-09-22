import enum
import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint, Uuid
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
    brand_json: Mapped[dict] = mapped_column(JSON, default=dict)

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
    plan: Mapped[str] = mapped_column(String(20), default="free")  # free | writer | studio
    status: Mapped[str] = mapped_column(String(20), default="active")
    provider: Mapped[str | None] = mapped_column(String(20))
    provider_customer_id: Mapped[str | None] = mapped_column(String(100))
    provider_subscription_id: Mapped[str | None] = mapped_column(String(100))
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import IdMixin, TimestampMixin


class VerificationPurpose(str, enum.Enum):
    SIGNUP = "signup"
    PASSWORD_RESET = "password_reset"


class EmailVerificationCode(IdMixin, TimestampMixin, Base):
    __tablename__ = "email_verification_codes"

    email: Mapped[str] = mapped_column(String(320), index=True)
    purpose: Mapped[VerificationPurpose] = mapped_column(
        Enum(VerificationPurpose, native_enum=False, length=20)
    )
    code_hash: Mapped[str] = mapped_column(String(128))
    # Signup stores the pending name + password hash until the code is verified.
    pending_name: Mapped[str | None] = mapped_column(String(200))
    pending_password_hash: Mapped[str | None] = mapped_column(String(200))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UpdateEmail(IdMixin, TimestampMixin, Base):
    """Broadcast campaign. Body is plain text (it gets HTML escaped)."""

    __tablename__ = "update_emails"

    subject: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    user_filter: Mapped[str] = mapped_column(String(20), default="all")  # all | free | paid | writer | studio
    batch_size: Mapped[int] = mapped_column(Integer, default=50)
    send_hour: Mapped[int] = mapped_column(Integer, default=-1)  # -1 = config default, UTC
    total_users: Mapped[int] = mapped_column(Integer, default=0)
    sent_count: Mapped[int] = mapped_column(Integer, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(20), default="scheduled")  # scheduled | running | completed
    last_batch_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UpdateEmailSend(IdMixin, TimestampMixin, Base):
    __tablename__ = "update_email_sends"
    __table_args__ = (UniqueConstraint("update_email_id", "user_id"),)

    update_email_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("update_emails.id", ondelete="CASCADE")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(10))  # sent | failed

import uuid

from sqlalchemy import JSON, ForeignKey, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import IdMixin, TimestampMixin


class SupportConversation(IdMixin, TimestampMixin, Base):
    """One thread with the help bot. Owned by a user; the bot is only open to signed in writers."""

    __tablename__ = "support_conversations"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str | None] = mapped_column(String(200))
    # Rolling summary of turns that fell out of the recent window (see support/memory.py).
    summary: Mapped[str] = mapped_column(Text, default="")
    # Small structured facts: current page, visited pages, plan.
    session_state: Mapped[dict] = mapped_column(JSON, default=dict)
    # "Talk to a human" forms sent from this thread. Capped so the form cannot flood the inbox.
    escalation_count: Mapped[int] = mapped_column(Integer, default=0)


class SupportMessage(IdMixin, TimestampMixin, Base):
    __tablename__ = "support_messages"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("support_conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(20))  # user | assistant
    content: Mapped[str] = mapped_column(Text)
    page_path: Mapped[str | None] = mapped_column(String(300))
    cited_docs: Mapped[list | None] = mapped_column(JSON)

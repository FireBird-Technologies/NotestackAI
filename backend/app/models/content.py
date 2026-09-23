import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import IdMixin, TimestampMixin


def _ws_fk() -> Mapped[uuid.UUID]:
    return mapped_column(Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)


class Source(IdMixin, TimestampMixin, Base):
    __tablename__ = "sources"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    feed_url: Mapped[str] = mapped_column(String(1000))
    site_url: Mapped[str | None] = mapped_column(String(1000))
    platform: Mapped[str] = mapped_column(String(20), default="rss")  # substack | ghost | medium | rss | url
    title: Mapped[str | None] = mapped_column(String(500))
    sync_status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | syncing | ok | error
    sync_error: Mapped[str | None] = mapped_column(Text)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Document(IdMixin, TimestampMixin, Base):
    __tablename__ = "documents"
    __table_args__ = (UniqueConstraint("source_id", "url"),)

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    source_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("sources.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(1000))
    url: Mapped[str] = mapped_column(String(1000))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    raw_html_key: Mapped[str | None] = mapped_column(String(500))  # R2 key
    # Corpus relative path of the clean markdown file, e.g. sources/ada-substack-com/2026-03-01-pricing.md
    path: Mapped[str | None] = mapped_column(String(500), index=True)
    clean_text: Mapped[str] = mapped_column(Text, default="")
    content_hash: Mapped[str | None] = mapped_column(String(64))
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)


class Notebook(IdMixin, TimestampMixin, Base):
    __tablename__ = "notebooks"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)


class NotebookDocument(Base):
    __tablename__ = "notebook_documents"

    notebook_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("notebooks.id", ondelete="CASCADE"), primary_key=True
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True
    )


class VoiceProfile(IdMixin, TimestampMixin, Base):
    __tablename__ = "voice_profiles"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"), unique=True
    )
    profile_json: Mapped[dict] = mapped_column(JSON, default=dict)
    sample_doc_ids: Mapped[list] = mapped_column(JSON, default=list)


class VoiceConsent(IdMixin, TimestampMixin, Base):
    """Required before any voice cloning. The recorded sample lives in R2."""

    __tablename__ = "voice_consents"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"))
    sample_key: Mapped[str] = mapped_column(String(500))
    consent_text: Mapped[str] = mapped_column(Text)
    ip_address: Mapped[str | None] = mapped_column(String(64))
    elevenlabs_voice_id: Mapped[str | None] = mapped_column(String(100))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Chat(IdMixin, TimestampMixin, Base):
    __tablename__ = "chats"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    notebook_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("notebooks.id", ondelete="CASCADE"))
    title: Mapped[str | None] = mapped_column(String(300))


class Message(IdMixin, TimestampMixin, Base):
    __tablename__ = "messages"

    chat_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("chats.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20))  # user | assistant
    content: Mapped[str] = mapped_column(Text)

    citations: Mapped[list["Citation"]] = relationship(cascade="all, delete-orphan")


class Citation(IdMixin, Base):
    __tablename__ = "citations"

    message_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("messages.id", ondelete="CASCADE"))
    document_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("documents.id", ondelete="CASCADE"))
    marker: Mapped[int] = mapped_column(Integer)  # [1], [2] in the answer text
    path: Mapped[str] = mapped_column(String(500))
    line_start: Mapped[int] = mapped_column(Integer)
    line_end: Mapped[int] = mapped_column(Integer)
    span: Mapped[str | None] = mapped_column(Text)  # verified text read back from the file


class Artifact(IdMixin, TimestampMixin, Base):
    __tablename__ = "artifacts"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    notebook_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("notebooks.id", ondelete="SET NULL"))
    document_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("documents.id", ondelete="SET NULL"))
    # summary | audio_overview | video | thread | linkedin | notes | quote_card | carousel | seo
    type: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    content_json: Mapped[dict] = mapped_column(JSON, default=dict)
    storage_key: Mapped[str | None] = mapped_column(String(500))


class Job(IdMixin, TimestampMixin, Base):
    """Covers ingest, tts and render jobs. kind decides which fields matter.

    This table is also the queue: workers claim queued rows with FOR UPDATE SKIP LOCKED
    (see app/worker.py), so no separate broker is needed.
    """

    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_queue", "status", "run_after", "created_at"),)

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    kind: Mapped[str] = mapped_column(String(30))  # ingest | tts | render | generate
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued | running | done | failed
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    message: Mapped[str | None] = mapped_column(String(500))
    error: Mapped[str | None] = mapped_column(Text)
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    artifact_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("artifacts.id", ondelete="SET NULL"))
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Queue bookkeeping
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    run_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # retry backoff
    locked_by: Mapped[str | None] = mapped_column(String(100))  # worker id while running
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # stale detection


class Upload(IdMixin, TimestampMixin, Base):
    __tablename__ = "uploads"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"))
    key: Mapped[str] = mapped_column(String(500), unique=True)
    filename: Mapped[str] = mapped_column(String(300))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | complete


class CalendarItem(IdMixin, TimestampMixin, Base):
    __tablename__ = "calendar_items"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    artifact_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("artifacts.id", ondelete="CASCADE"))
    platform: Mapped[str] = mapped_column(String(30))
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20), default="scheduled")


class TrackedLink(IdMixin, TimestampMixin, Base):
    __tablename__ = "tracked_links"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    slug: Mapped[str] = mapped_column(String(32), unique=True)
    target_url: Mapped[str] = mapped_column(String(2000))
    calendar_item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("calendar_items.id", ondelete="SET NULL")
    )


class EngagementEvent(IdMixin, TimestampMixin, Base):
    __tablename__ = "engagement_events"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    tracked_link_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tracked_links.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(30))  # click | like | repost | reply | subscribe
    value: Mapped[float] = mapped_column(Float, default=1.0)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)


class DspyTrace(IdMixin, TimestampMixin, Base):
    __tablename__ = "dspy_traces"

    workspace_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("workspaces.id", ondelete="SET NULL"))
    module: Mapped[str] = mapped_column(String(60), index=True)
    model: Mapped[str] = mapped_column(String(100))
    inputs: Mapped[dict] = mapped_column(JSON, default=dict)
    outputs: Mapped[dict] = mapped_column(JSON, default=dict)
    score: Mapped[float | None] = mapped_column(Float)
    feedback: Mapped[str | None] = mapped_column(Text)
    # Only usable for optimization when the workspace opted in.
    training_allowed: Mapped[bool] = mapped_column(Boolean, default=False)


class UsageEvent(IdMixin, TimestampMixin, Base):
    """Metering: LLM tokens, TTS characters, render seconds. One row per billable call."""

    __tablename__ = "usage_events"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    job_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("jobs.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(20))  # llm | tts | render
    provider: Mapped[str] = mapped_column(String(40))
    model: Mapped[str | None] = mapped_column(String(100))
    quantity: Mapped[float] = mapped_column(Float)  # tokens, characters or seconds
    unit: Mapped[str] = mapped_column(String(20))
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)

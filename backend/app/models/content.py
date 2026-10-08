import logging
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
    event,
    text,
    true,
)
from sqlalchemy.orm import Mapped, Session, mapped_column, relationship

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
    # Resurfacing: 0..1 from the EvergreenScore module (reason and angle live in metadata_json)
    evergreen_score: Mapped[float | None] = mapped_column(Float)
    last_resurfaced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Notebook(IdMixin, TimestampMixin, Base):
    __tablename__ = "notebooks"
    # One "All posts" notebook per workspace: two requests opening it at once cannot both create one.
    __table_args__ = (Index("uq_notebooks_one_archive", "workspace_id", unique=True,
                            postgresql_where=text("is_archive"), sqlite_where=text("is_archive")),)

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
    # The workspace's "All posts" notebook: created on demand, kept in step with every indexed post.
    is_archive: Mapped[bool] = mapped_column(Boolean, default=False)


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
    host_voices: Mapped[dict] = mapped_column(JSON, default=dict)  # {"host_a": voice_id, "host_b": voice_id}


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
    # How an assistant answer was produced (triage route, which chat memory was loaded, the steps taken), so a
    # thumbs down can be traced back to what recall did. Null for user messages and older rows.
    recall_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    citations: Mapped[list["Citation"]] = relationship(cascade="all, delete-orphan")


class MessageFeedback(IdMixin, TimestampMixin, Base):
    """A thumbs up or down on one assistant answer, with a snapshot of the question, answer and recall trace taken
    when it was rated. It keeps its own copy so the rating stays useful for improving recall even after the chat is
    deleted (the links then become null). One row per message: rating again replaces it."""

    __tablename__ = "message_feedback"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    notebook_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("notebooks.id", ondelete="SET NULL"))
    chat_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("chats.id", ondelete="SET NULL"))
    message_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("messages.id", ondelete="SET NULL"), unique=True, index=True
    )
    rating: Mapped[int] = mapped_column(Integer)  # 1 up, -1 down
    reasons: Mapped[list] = mapped_column(JSON, default=list)  # tags such as forgot_chat, wrong, bad_sources
    comment: Mapped[str | None] = mapped_column(Text)
    question: Mapped[str] = mapped_column(Text, default="")  # what the writer asked (the message before the answer)
    answer: Mapped[str] = mapped_column(Text, default="")
    sources: Mapped[list] = mapped_column(JSON, default=list)  # [{kind, path, line_start, line_end}] it cited
    recall: Mapped[dict] = mapped_column(JSON, default=dict)  # copy of Message.recall_json


class ArtifactFeedback(IdMixin, TimestampMixin, Base):
    """A thumbs up or down on one generated report, quiz, flashcard set or infographic, with a snapshot of what it was
    (title, prompt, sources, options) taken when it was rated, so the ratings stay useful after it is deleted (the link
    then becomes null). One row per artifact and person: rating again replaces it."""

    __tablename__ = "artifact_feedback"
    __table_args__ = (UniqueConstraint("artifact_id", "user_id"),)

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    artifact_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("artifacts.id", ondelete="SET NULL"), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    artifact_type: Mapped[str] = mapped_column(String(30))
    rating: Mapped[int] = mapped_column(Integer)  # 1 up, -1 down
    reasons: Mapped[list] = mapped_column(JSON, default=list)
    comment: Mapped[str | None] = mapped_column(Text)
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)


class QuizAttempt(IdMixin, TimestampMixin, Base):
    """A person's last finished run of a quiz: what they answered and the score, so opening the quiz again shows the result.
    One row per quiz and person; finishing it again replaces it."""

    __tablename__ = "quiz_attempts"
    __table_args__ = (UniqueConstraint("artifact_id", "user_id"),)

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    artifact_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("artifacts.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"))
    score: Mapped[int] = mapped_column(Integer)
    total: Mapped[int] = mapped_column(Integer)
    answers: Mapped[list] = mapped_column(JSON, default=list)  # per question: choice (indexes), text, correct


class ReportTemplateCache(IdMixin, TimestampMixin, Base):
    """The suggested report templates already written for some sources, found again by a hash of exactly what the AI read (each
    post's stored ideas and topics, and the topic). The same input gives the same templates at once, so the Create report dialog
    is instant, and a changed post (its ideas change) gets new ones."""

    __tablename__ = "report_template_cache"
    __table_args__ = (UniqueConstraint("workspace_id", "key"),)

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    key: Mapped[str] = mapped_column(String(64))
    templates: Mapped[list] = mapped_column(JSON, default=list)


class WorkspaceMemory(IdMixin, TimestampMixin, Base):
    """The writer's standing notes, one row per workspace, shared by every notebook and chat.

    facts maps a short key to {"value", "source" (user | auto), "updated_at"}, e.g.
    {"audience": {"value": "indie founders", "source": "auto", "updated_at": "2026-09-30T10:00:00+00:00"}}."""

    __tablename__ = "workspace_memory"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"), unique=True, index=True
    )
    facts: Mapped[dict] = mapped_column(JSON, default=dict)


class Citation(IdMixin, Base):
    __tablename__ = "citations"

    message_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("messages.id", ondelete="CASCADE"))
    # post: a line range of a document. chat: a line range of an earlier chat's topic file, with no document.
    kind: Mapped[str] = mapped_column(String(10), default="post", server_default="post")
    document_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("documents.id", ondelete="CASCADE"))
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
    # pending | generating | ready | failed | rendering | review; a video also takes blog2video's job statuses as they
    # are: regenerating (template switch) | voice_regenerating | language_regenerating | script_regenerating
    status: Mapped[str] = mapped_column(String(40), default="pending")
    content_json: Mapped[dict] = mapped_column(JSON, default=dict)
    storage_key: Mapped[str | None] = mapped_column(String(500))


class ArtifactShare(IdMixin, TimestampMixin, Base):
    """A public link to one artifact (a report): anyone holding the token can read the shared view, nothing else.
    Revoking deletes the row, so a new link is a new token."""

    __tablename__ = "artifact_shares"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    artifact_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("artifacts.id", ondelete="CASCADE"), unique=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    show_sources: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())


class B2VVideo(IdMixin, TimestampMixin, Base):
    """One blog2video video we asked for: the only place its blog2video id lives. Every read, edit and delete on
    blog2video goes through this row (b2v_video_id, and created_via for the right endpoints). Also records who made it
    and whether the workspace's video allowance is still charged for it.

    Our API key reaches every video it created, for every workspace, so this table (with the artifact) is what
    ties a blog2video id to one workspace. quota_state moves charged -> refunded (or -> kept once generated), with a
    conditional UPDATE (see video_quota.refund), so the status poller and the sweep can not refund twice."""

    __tablename__ = "b2v_videos"
    __table_args__ = (Index("ix_b2v_videos_ws_created", "workspace_id", "created_at"),)

    workspace_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="SET NULL"),
                                                      index=True)  # who made it
    artifact_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("artifacts.id", ondelete="SET NULL"),
                                                          index=True)
    # blog2video's video id, which is also its project id. Null until blog2video accepts the create.
    b2v_video_id: Mapped[int | None] = mapped_column(Integer, unique=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(100), unique=True)  # "<workspace_id>:<uuid>"; v1 only
    created_via: Mapped[str] = mapped_column(String(10), default="v1", server_default="v1")  # v1 | upload
    template_ref: Mapped[str | None] = mapped_column(String(100))  # e.g. custom_58: blocks deleting that template
    title: Mapped[str | None] = mapped_column(String(300))
    source_url: Mapped[str | None] = mapped_column(String(2000))  # the link it was made from (null for files, text)
    aspect_ratio: Mapped[str | None] = mapped_column(String(20))
    preview_url: Mapped[str | None] = mapped_column(String(1000))  # public live preview (embed token)
    video_url: Mapped[str | None] = mapped_column(String(1000))  # the rendered MP4
    quota_state: Mapped[str] = mapped_column(String(20), default="charged")  # charged | refunded | kept
    status: Mapped[str] = mapped_column(String(40), default="queued")  # last known blog2video status


class B2VTemplate(TimestampMixin, Base):
    """A custom template this workspace made. Used on videos as custom_<b2v_template_id>; only when ready."""

    __tablename__ = "b2v_templates"

    b2v_template_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    name: Mapped[str] = mapped_column(String(255))
    ready: Mapped[bool] = mapped_column(Boolean, default=False)  # code generation finished ('complete')


class B2VCustomVoice(TimestampMixin, Base):
    """A designed or cloned voice this workspace made. Videos reference it by voice_id (custom_voice_id)."""

    __tablename__ = "b2v_custom_voices"

    b2v_custom_voice_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)  # preview/delete
    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    voice_id: Mapped[str] = mapped_column(String(100), unique=True)  # the ElevenLabs id sent as custom_voice_id
    name: Mapped[str] = mapped_column(String(255))
    source: Mapped[str] = mapped_column(String(20))  # prompt | preset | clone
    preview_url: Mapped[str | None] = mapped_column(String(1000))


class UserSavedVoice(TimestampMixin, Base):
    """The workspace's "My voices" list. Kept only here: blog2video's saved-voice list is shared by everyone."""

    __tablename__ = "user_saved_voices"

    workspace_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"),
                                                    primary_key=True)
    voice_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    preview_url: Mapped[str | None] = mapped_column(String(1000))
    gender: Mapped[str | None] = mapped_column(String(20))
    accent: Mapped[str | None] = mapped_column(String(50))
    premium: Mapped[bool] = mapped_column(Boolean, default=False)  # a paid built-in voice, or any custom voice
    is_custom: Mapped[bool] = mapped_column(Boolean, default=False)


class B2VStyle(TimestampMixin, Base):
    """A custom video style this workspace made. Used on videos as custom:<b2v_style_id>."""

    __tablename__ = "b2v_styles"

    b2v_style_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    name: Mapped[str] = mapped_column(String(80))


class UsageCounter(Base):
    """Per-workspace counters for the video features blog2video only limits account-wide (video_limits.py)."""

    __tablename__ = "usage_counters"

    workspace_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"),
                                                    primary_key=True)
    period: Mapped[str] = mapped_column(String(10), primary_key=True)  # 2026-10 | 2026-10-02 | all
    metric: Mapped[str] = mapped_column(String(30), primary_key=True)
    used: Mapped[int] = mapped_column(Integer, default=0)


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


# Deleting an upload record removes its file from storage too, once the delete is committed (never on a rollback).
# This covers deletes made through the ORM; rows removed straight in the database are caught by the daily orphan
# sweep (app.services.uploads.sweep_orphan_uploads).
_PENDING_FILE_DELETES = "upload_files_to_delete"


@event.listens_for(Session, "after_flush")
def _note_deleted_uploads(session: Session, _ctx) -> None:
    keys = [obj.key for obj in session.deleted if isinstance(obj, Upload) and obj.key]
    if keys:
        session.info.setdefault(_PENDING_FILE_DELETES, []).extend(keys)


@event.listens_for(Session, "after_commit")
def _delete_upload_files(session: Session) -> None:
    keys = session.info.pop(_PENDING_FILE_DELETES, [])
    if not keys:
        return
    from app.services.storage import storage

    for key in keys:
        try:
            storage.delete(key)
        except Exception:  # left for the daily sweep
            logging.getLogger("notestack.storage").warning("couldn't delete upload file %s", key, exc_info=True)


@event.listens_for(Session, "after_rollback")
def _forget_upload_files(session: Session) -> None:
    session.info.pop(_PENDING_FILE_DELETES, None)


class CalendarItem(IdMixin, TimestampMixin, Base):
    __tablename__ = "calendar_items"

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    # What the post carries (a video, quote card, carousel...): never a Launch Kit, which is kit_id.
    artifact_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("artifacts.id", ondelete="CASCADE"))
    # The Launch Kit the post was written from, kept apart from the attachment (nothing of it is uploaded).
    kit_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("artifacts.id", ondelete="SET NULL"))
    document_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("documents.id", ondelete="SET NULL"))
    platform: Mapped[str] = mapped_column(String(30))  # x | linkedin | bluesky | substack_notes
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    # scheduled | publishing | posted | reminded | failed | draft
    status: Mapped[str] = mapped_column(String(20), default="scheduled")
    content: Mapped[str] = mapped_column(Text, default="")
    thread: Mapped[list] = mapped_column(JSON, default=list)  # extra posts after the first, for threads
    social_account_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("social_accounts.id", ondelete="SET NULL")
    )
    remind_by_email: Mapped[bool] = mapped_column(Boolean, default=False)
    external_id: Mapped[str | None] = mapped_column(String(200))
    external_url: Mapped[str | None] = mapped_column(String(1000))
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)  # likes, reposts, replies, impressions


class SocialAccount(IdMixin, TimestampMixin, Base):
    """A connected X, LinkedIn or Bluesky account. Tokens are Fernet encrypted (app/services/crypto.py)."""

    __tablename__ = "social_accounts"
    __table_args__ = (UniqueConstraint("workspace_id", "platform", "external_id"),)

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    platform: Mapped[str] = mapped_column(String(20))
    handle: Mapped[str] = mapped_column(String(200))
    external_id: Mapped[str] = mapped_column(String(200))
    access_token: Mapped[str] = mapped_column(Text)
    refresh_token: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scopes: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(20), default="active")  # active | expired | revoked
    avatar_url: Mapped[str | None] = mapped_column(String(1000))


class Topic(IdMixin, TimestampMixin, Base):
    __tablename__ = "topics"
    __table_args__ = (UniqueConstraint("workspace_id", "slug"),)

    workspace_id: Mapped[uuid.UUID] = _ws_fk()
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str | None] = mapped_column(Text)
    post_count: Mapped[int] = mapped_column(Integer, default=0)


class DocumentTopic(Base):
    __tablename__ = "document_topics"

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), primary_key=True
    )
    topic_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("topics.id", ondelete="CASCADE"), primary_key=True)
    weight: Mapped[float] = mapped_column(Float, default=1.0)


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

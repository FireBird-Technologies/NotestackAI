import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import IdMixin, TimestampMixin


class McpClient(TimestampMixin, Base):
    """An app that registered itself to connect to Notestack over MCP (OAuth dynamic client registration)."""

    __tablename__ = "mcp_clients"

    client_id: Mapped[str] = mapped_column(String(100), primary_key=True)
    info: Mapped[dict] = mapped_column(JSON)  # the registration, as the client sent it (name, redirect URIs, ...)


class McpAuthRequest(IdMixin, TimestampMixin, Base):
    """One sign-in an app has started. The writer approves it in the web app, which turns it into a one-time code."""

    __tablename__ = "mcp_auth_requests"

    client_id: Mapped[str] = mapped_column(ForeignKey("mcp_clients.client_id", ondelete="CASCADE"), index=True)
    redirect_uri: Mapped[str] = mapped_column(Text)
    redirect_uri_provided_explicitly: Mapped[bool] = mapped_column(Boolean, default=True)
    code_challenge: Mapped[str] = mapped_column(String(200))
    state: Mapped[str | None] = mapped_column(Text)
    scopes: Mapped[list] = mapped_column(JSON)
    resource: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"))
    code_hash: Mapped[str | None] = mapped_column(String(64), index=True)  # set once the writer approves
    code_used: Mapped[bool] = mapped_column(Boolean, default=False)


class McpGrant(IdMixin, TimestampMixin, Base):
    """An app the writer has connected. Revoking it ends that app's access and nothing else."""

    __tablename__ = "mcp_grants"

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    client_id: Mapped[str] = mapped_column(ForeignKey("mcp_clients.client_id", ondelete="CASCADE"), index=True)
    scopes: Mapped[list] = mapped_column(JSON)
    resource: Mapped[str | None] = mapped_column(Text)
    refresh_hash: Mapped[str] = mapped_column(String(64), index=True)
    previous_refresh_hash: Mapped[str | None] = mapped_column(String(64), index=True)  # a second use of it = theft
    refresh_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class McpWidgetState(TimestampMixin, Base):
    """A conversation widget's durable pointer to the artifact it created."""

    __tablename__ = "mcp_widget_states"

    state_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"), index=True)
    artifact_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("artifacts.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(30))

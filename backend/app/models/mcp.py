import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import IdMixin, TimestampMixin, utcnow


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


class OutboundMcpConnection(IdMixin, TimestampMixin, Base):
    """A remote MCP server whose selected tools NoteStack may call for one writer."""

    __tablename__ = "outbound_mcp_connections"
    __table_args__ = (
        Index(
            "uq_outbound_mcp_connections_active_name",
            "workspace_id", "user_id", "name",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
    )

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    server_url: Mapped[str] = mapped_column(Text)
    auth_type: Mapped[str] = mapped_column(String(20), default="none")  # none | bearer | oauth | managed
    access_token_encrypted: Mapped[str | None] = mapped_column(Text)
    provider: Mapped[str | None] = mapped_column(String(80))
    icon_url: Mapped[str | None] = mapped_column(Text)  # data: URI fetched when the server was connected
    canonical_resource: Mapped[str | None] = mapped_column(Text)
    authorization_issuer: Mapped[str | None] = mapped_column(Text)
    auth_status: Mapped[str] = mapped_column(String(30), default="not_required")
    account_label: Mapped[str | None] = mapped_column(String(250))
    granted_scopes: Mapped[list] = mapped_column(JSON, default=list)
    oauth_metadata_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    enabled_tools: Mapped[list] = mapped_column(JSON, default=list)
    discovered_tools: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="ready")  # ready | error | removed
    last_error: Mapped[str | None] = mapped_column(Text)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)


class NotebookMcpConnection(TimestampMixin, Base):
    """A notebook-level override for whether one of the writer's connected MCP servers may be used.

    No row means enabled, which preserves the existing behaviour for old and newly created notebooks. A row is
    written only after the writer deliberately changes the notebook switch.
    """

    __tablename__ = "notebook_mcp_connections"

    notebook_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("notebooks.id", ondelete="CASCADE"), primary_key=True
    )
    connection_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("outbound_mcp_connections.id", ondelete="CASCADE"), primary_key=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class OutboundMcpOAuthClient(IdMixin, TimestampMixin, Base):
    """OAuth client registration used for one authorization issuer/resource/callback tuple."""

    __tablename__ = "outbound_mcp_oauth_clients"
    __table_args__ = (UniqueConstraint("issuer", "resource", "redirect_uri"),)

    issuer: Mapped[str] = mapped_column(Text)
    resource: Mapped[str] = mapped_column(Text)
    redirect_uri: Mapped[str] = mapped_column(Text)
    registration_type: Mapped[str] = mapped_column(String(30))  # static | dynamic | metadata_url
    client_id: Mapped[str] = mapped_column(Text)
    client_secret_encrypted: Mapped[str | None] = mapped_column(Text)
    registration_token_encrypted: Mapped[str | None] = mapped_column(Text)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)


class OutboundMcpGrant(IdMixin, TimestampMixin, Base):
    """Encrypted OAuth grant for one user's outbound MCP connection."""

    __tablename__ = "outbound_mcp_grants"
    __table_args__ = (UniqueConstraint("connection_id"),)

    connection_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("outbound_mcp_connections.id", ondelete="CASCADE"), index=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    oauth_client_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("outbound_mcp_oauth_clients.id", ondelete="CASCADE"), index=True
    )
    issuer: Mapped[str] = mapped_column(Text)
    resource: Mapped[str] = mapped_column(Text)
    access_token_encrypted: Mapped[str] = mapped_column(Text)
    refresh_token_encrypted: Mapped[str | None] = mapped_column(Text)
    token_type: Mapped[str] = mapped_column(String(30), default="Bearer")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scopes: Mapped[list] = mapped_column(JSON, default=list)
    account_id: Mapped[str | None] = mapped_column(String(250))
    account_label: Mapped[str | None] = mapped_column(String(250))
    status: Mapped[str] = mapped_column(String(30), default="active")
    refreshed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OutboundMcpAuthAttempt(IdMixin, TimestampMixin, Base):
    """Short-lived PKCE/state record bridging OAuth start and the unauthenticated callback."""

    __tablename__ = "outbound_mcp_auth_attempts"

    connection_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("outbound_mcp_connections.id", ondelete="CASCADE"), index=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    oauth_client_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("outbound_mcp_oauth_clients.id", ondelete="CASCADE"), index=True
    )
    state_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    pkce_verifier_encrypted: Mapped[str] = mapped_column(Text)
    issuer: Mapped[str] = mapped_column(Text)
    resource: Mapped[str] = mapped_column(Text)
    scopes: Mapped[list] = mapped_column(JSON, default=list)
    redirect_uri: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OutboundMcpAudit(IdMixin, Base):
    """A bounded, credential-free record of each remote tool call."""

    __tablename__ = "outbound_mcp_audits"

    connection_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("outbound_mcp_connections.id", ondelete="SET NULL"), index=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    tool_name: Mapped[str] = mapped_column(String(200))
    arguments_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(20))  # ok | error
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    result_preview: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

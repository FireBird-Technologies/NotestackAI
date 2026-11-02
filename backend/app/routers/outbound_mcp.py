"""User-facing control plane for outbound (NoteStack-as-client) MCP connections."""

import secrets
import uuid
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlencode, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import Ctx, get_ctx
from app.config import settings
from app.db import get_db
from app.mcp_client.catalog import catalog_with_icons
from app.mcp_client.icon import ensure_icon, monogram_icon
from app.mcp_client.manager import (
    OutboundMcpError,
    OutboundToolResult,
    enable_read_only_tools,
    manager,
    tool_is_usable,
)
from app.mcp_client.oauth import (
    OAuthFlowError,
    access_token_for,
    client_metadata_document,
    finish_authorization,
    prepare_authorization,
    probe_authorization,
    revoke_connection,
    start_authorization,
)
from app.models import OutboundMcpAuthAttempt, OutboundMcpConnection, OutboundMcpGrant
from app.services.crypto import decrypt, encrypt

router = APIRouter(prefix="/api/outbound-mcp", tags=["outbound-mcp"])
OAUTH_STATE_COOKIE = "ns_outbound_mcp_state"


@router.get("/oauth/client-metadata")
def oauth_client_metadata():
    return client_metadata_document()


class ConnectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    server_url: str = Field(min_length=1, max_length=2000)
    bearer_token: str | None = Field(None, max_length=8000)


class ConnectionPatch(BaseModel):
    enabled: bool | None = None
    enabled_tools: list[str] | None = None


class OAuthStart(BaseModel):
    scopes: list[str] | None = None


class WidgetToolCall(BaseModel):
    arguments: dict = Field(default_factory=dict)
    approved: bool = False


def _get(ctx: Ctx, connection_id: uuid.UUID) -> OutboundMcpConnection:
    row = ctx.db.scalar(select(OutboundMcpConnection).where(
        OutboundMcpConnection.id == connection_id,
        OutboundMcpConnection.workspace_id == ctx.workspace.id,
        OutboundMcpConnection.user_id == ctx.user.id,
        OutboundMcpConnection.deleted_at.is_(None),
    ))
    if not row:
        raise HTTPException(404, "MCP connection not found")
    return row


def _out(row: OutboundMcpConnection) -> dict:
    discovered = [{**tool, "usable": tool_is_usable(tool)} for tool in (row.discovered_tools or [])]
    return {
        "id": str(row.id), "name": row.name, "server_url": row.server_url, "auth_type": row.auth_type,
        "has_token": bool(row.access_token_encrypted) or (row.auth_type == "oauth" and row.auth_status == "ready"),
        "provider": row.provider, "icon_url": row.icon_url or monogram_icon(row.name),
        "auth_status": row.auth_status, "account_label": row.account_label,
        "granted_scopes": row.granted_scopes or [], "enabled": row.enabled,
        "enabled_tools": row.enabled_tools or [], "discovered_tools": discovered,
        "status": row.status, "last_error": row.last_error,
        "last_checked_at": row.last_checked_at.isoformat() if row.last_checked_at else None,
    }


def _connection_token(row: OutboundMcpConnection) -> str | None:
    try:
        return (access_token_for(row.id, row.workspace_id, row.user_id)
                if row.auth_type == "oauth" else decrypt(row.access_token_encrypted))
    except OAuthFlowError as exc:
        raise HTTPException(401, "Reconnect this MCP server before using its widget.") from exc


def _enabled_tool(row: OutboundMcpConnection, tool_name: str) -> dict:
    if not row.enabled or row.status != "ready" or tool_name not in (row.enabled_tools or []):
        raise HTTPException(403, "This MCP tool is not enabled.")
    tool = next((item for item in (row.discovered_tools or []) if item.get("name") == tool_name), None)
    if not tool or not tool_is_usable(tool):
        raise HTTPException(404, "This MCP tool is unavailable.")
    return tool


def _discover(url: str, token: str | None) -> list[dict]:
    try:
        return manager.discover(url, token)
    except OutboundMcpError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(400, f"Could not connect to that MCP server: {type(exc).__name__}") from exc


def _validate_selection(row: OutboundMcpConnection, names: list[str]) -> list[str]:
    names = list(dict.fromkeys(names))
    usable = {tool.get("name") for tool in (row.discovered_tools or []) if tool_is_usable(tool)}
    if unknown := [name for name in names if name not in usable]:
        raise HTTPException(400, f"Tools are unavailable or have unsupported input schemas: {', '.join(unknown)}")
    return names


@router.get("/catalog")
def catalog(_ctx: Ctx = Depends(get_ctx)):
    """Suggested servers, including ones the writer already connected so the UI can mark them."""
    return catalog_with_icons()


@router.get("/connections")
def list_connections(ctx: Ctx = Depends(get_ctx)):
    rows = ctx.db.scalars(select(OutboundMcpConnection).where(
        OutboundMcpConnection.workspace_id == ctx.workspace.id,
        OutboundMcpConnection.user_id == ctx.user.id,
        OutboundMcpConnection.deleted_at.is_(None),
    ).order_by(OutboundMcpConnection.created_at)).all()
    for row in rows:
        if not row.icon_url:  # connected before icons were stored
            row.icon_url = ensure_icon(row.server_url, row.name)
            ctx.db.commit()
        if (row.auth_type == "none" and row.auth_status in {"not_required", "ready"}
                and row.oauth_metadata_checked_at is None):
            try:
                probe_authorization(ctx.db, row)
            except OAuthFlowError as exc:
                row.auth_status, row.status, row.last_error = "configuration_error", "error", str(exc)[:500]
                ctx.db.commit()
    return [_out(row) for row in rows]


@router.get("/connections/{connection_id}/widgets/{tool_name}")
def widget_resource(connection_id: uuid.UUID, tool_name: str, ctx: Ctx = Depends(get_ctx)):
    """Fetch the UI resource declared by one enabled tool without exposing the MCP credential to the browser."""
    row = _get(ctx, connection_id)
    _enabled_tool(row, tool_name)
    token = _connection_token(row)
    try:
        current = next((tool for tool in manager.discover(row.server_url, token)
                        if tool.get("name") == tool_name), None)
        resource_uri = (current or {}).get("ui_resource_uri")
        if not resource_uri:
            raise HTTPException(404, "This tool does not declare an MCP App UI resource.")
        resource = manager.read_resource(row.server_url, token, resource_uri)
    except HTTPException:
        raise
    except OutboundMcpError as exc:
        raise HTTPException(502, str(exc)) from exc
    contents = resource.get("contents") if isinstance(resource, dict) else None
    page = next((item for item in (contents or [])
                 if isinstance(item, dict) and isinstance(item.get("text"), str)), None)
    if not page:
        raise HTTPException(502, "The MCP App resource did not return an HTML document.")
    mime = str(page.get("mimeType") or "")
    if mime not in {"text/html;profile=mcp-app", "text/html+skybridge"}:
        raise HTTPException(502, "The MCP App resource has an unsupported media type.")
    return {
        "resource_uri": resource_uri,
        "html": page["text"],
        "mime_type": mime,
        "meta": page.get("_meta") or {},
    }


@router.post("/connections/{connection_id}/widgets/tools/{tool_name}")
def widget_call_tool(connection_id: uuid.UUID, tool_name: str, body: WidgetToolCall,
                     ctx: Ctx = Depends(get_ctx)):
    """Proxy an MCP App's tools/call request through the user's existing connection and authorization."""
    row = _get(ctx, connection_id)
    tool = _enabled_tool(row, tool_name)
    if tool.get("destructive") and not body.approved:
        raise HTTPException(409, detail={
            "message": f"The {row.name} widget wants to run destructive tool {tool_name}.",
            "code": "confirmation_required",
            "tool": tool_name,
        })
    try:
        result = manager.call(row.server_url, _connection_token(row), tool_name, body.arguments)
    except OutboundMcpError as exc:
        raise HTTPException(502, str(exc)) from exc
    if isinstance(result, OutboundToolResult):
        return result.raw_result
    return {"content": [{"type": "text", "text": str(result)}], "isError": False}


@router.post("/connections", status_code=201)
def create_connection(body: ConnectionCreate, ctx: Ctx = Depends(get_ctx)):
    if not settings.outbound_mcp_enabled:
        raise HTTPException(404, "Outbound MCP is disabled")
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Connection name is required.")
    token = (body.bearer_token or "").strip() or None
    url = body.server_url.strip()
    try:
        tools = manager.discover(url, token)
        auth_status, status, last_error = "ready" if token else "not_required", "ready", None
        auth_error: OutboundMcpError | None = None
    except OutboundMcpError as exc:
        if token or exc.status_code != 401 or not settings.outbound_mcp_oauth_enabled:
            raise HTTPException(400, str(exc)) from exc
        tools, auth_status, status = [], "authorization_required", "error"
        last_error, auth_error = "Authorization is required to connect to this MCP server.", exc
    except Exception as exc:
        raise HTTPException(400, f"Could not connect to that MCP server: {type(exc).__name__}") from exc
    row = OutboundMcpConnection(
        workspace_id=ctx.workspace.id, user_id=ctx.user.id, name=name, server_url=url,
        auth_type="bearer" if token else "none", access_token_encrypted=encrypt(token), enabled=True,
        auth_status=auth_status, enabled_tools=enable_read_only_tools(tools), discovered_tools=tools,
        status=status, last_error=last_error,
        last_checked_at=datetime.now(UTC), icon_url=ensure_icon(url, name),
    )
    ctx.db.add(row)
    try:
        ctx.db.commit()
    except IntegrityError as exc:
        ctx.db.rollback()
        raise HTTPException(409, "A connection with that name already exists.") from exc
    if not token and not auth_error:
        try:
            probe_authorization(ctx.db, row)
        except OAuthFlowError as exc:
            row.auth_status, row.status, row.last_error = "configuration_error", "error", str(exc)[:500]
            ctx.db.commit()
    if auth_error:
        try:
            prepare_authorization(ctx.db, row, auth_error.headers)
        except OAuthFlowError as exc:
            row.last_error = str(exc)[:500]
            ctx.db.commit()
    return _out(row)


@router.patch("/connections/{connection_id}")
def update_connection(connection_id: uuid.UUID, body: ConnectionPatch, ctx: Ctx = Depends(get_ctx)):
    row = _get(ctx, connection_id)
    next_enabled = body.enabled if body.enabled is not None else row.enabled
    next_tools = body.enabled_tools if body.enabled_tools is not None else list(row.enabled_tools or [])
    row.enabled_tools = _validate_selection(row, next_tools)
    row.enabled = next_enabled
    ctx.db.commit()
    return _out(row)


@router.post("/connections/{connection_id}/refresh")
def refresh_connection(connection_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    row = _get(ctx, connection_id)
    try:
        token = (access_token_for(row.id, row.workspace_id, row.user_id)
                 if row.auth_type == "oauth" else decrypt(row.access_token_encrypted))
    except OAuthFlowError as exc:
        row.auth_status, row.status, row.last_error = "reconnect_required", "error", str(exc)[:500]
        ctx.db.commit()
        return _out(row)
    if row.auth_type == "bearer" and not token:
        raise HTTPException(400, "This connection's credential cannot be decrypted. Reconnect it.")
    row.icon_url = ensure_icon(row.server_url, row.name, row.icon_url)
    try:
        row.discovered_tools = manager.discover(row.server_url, token)
        row.enabled_tools = enable_read_only_tools(row.discovered_tools, row.enabled_tools)
        row.status, row.last_error = "ready", None
        if row.auth_type == "oauth":
            row.auth_status = "ready"
        if row.auth_type != "oauth" and not token:
            probe_authorization(ctx.db, row)
    except Exception as exc:
        if isinstance(exc, OutboundMcpError) and exc.status_code == 401 and settings.outbound_mcp_oauth_enabled:
            row.auth_status = "authorization_required"
            try:
                prepare_authorization(ctx.db, row, exc.headers)
            except OAuthFlowError as oauth_exc:
                row.auth_status = "configuration_error"
                row.last_error = str(oauth_exc)[:500]
        elif isinstance(exc, OAuthFlowError):
            row.auth_status, row.status, row.last_error = "configuration_error", "error", str(exc)[:500]
        else:
            row.status, row.last_error = "error", " ".join(str(exc).split())[:500]
    row.last_checked_at = datetime.now(UTC)
    ctx.db.commit()
    return _out(row)


@router.post("/connections/{connection_id}/oauth/start")
def oauth_start(connection_id: uuid.UUID, body: OAuthStart | None = None, ctx: Ctx = Depends(get_ctx)):
    row = _get(ctx, connection_id)
    try:
        authorization_url = start_authorization(ctx.db, row, body.scopes if body else None)
    except OAuthFlowError as exc:
        row.auth_status, row.status, row.last_error = "configuration_error", "error", str(exc)[:500]
        ctx.db.commit()
        raise HTTPException(400, str(exc)) from exc
    state = (parse_qs(urlsplit(authorization_url).query).get("state") or [None])[0]
    if not state:
        raise HTTPException(500, "The OAuth authorization URL did not contain state.")
    response = JSONResponse({"authorization_url": authorization_url})
    response.set_cookie(
        OAUTH_STATE_COOKIE, state, max_age=600, path="/api/outbound-mcp/oauth", httponly=True,
        secure=settings.env != "development", samesite="lax",
    )
    return response


def _oauth_redirect(result: str, message: str | None = None) -> RedirectResponse:
    query = {"mcp_oauth": result}
    if message:
        query["message"] = message[:240]
    response = RedirectResponse(
        f"{settings.frontend_url.rstrip('/')}/app/connector?{urlencode(query)}", status_code=302
    )
    response.delete_cookie(OAUTH_STATE_COOKIE, path="/api/outbound-mcp/oauth")
    return response


@router.get("/oauth/callback")
def oauth_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None,
                   db: Session = Depends(get_db)):
    if error:
        return _oauth_redirect("error", "Authorization was cancelled." if error == "access_denied" else error)
    if not code or not state:
        return _oauth_redirect("error", "The OAuth callback was incomplete.")
    cookie_state = request.cookies.get(OAUTH_STATE_COOKIE)
    if not cookie_state or not secrets.compare_digest(cookie_state, state):
        return _oauth_redirect("error", "This authorization request is invalid or expired.")
    try:
        row = finish_authorization(db, state, code)
        grant = db.scalar(select(OutboundMcpGrant).where(OutboundMcpGrant.connection_id == row.id))
        token = decrypt(grant.access_token_encrypted) if grant else None
        if not token:
            raise OAuthFlowError("The saved OAuth grant could not be read.")
        # The authorization code is one-time. Keep the successfully issued grant even if the resource server is not
        # ready yet (for example, its API is disabled); the user can then fix provider setup and retry without signing
        # in again.
        db.commit()
        row.discovered_tools = manager.discover(row.server_url, token)
        row.enabled_tools = enable_read_only_tools(row.discovered_tools, row.enabled_tools)
        row.icon_url = ensure_icon(row.server_url, row.name, row.icon_url)
        row.last_checked_at = datetime.now(UTC)
        row.auth_status, row.status, row.last_error = "ready", "ready", None
        db.commit()
        return _oauth_redirect("connected")
    except (OAuthFlowError, OutboundMcpError) as exc:
        db.rollback()
        if "row" in locals() and row:
            row = db.get(OutboundMcpConnection, row.id)
            if row:
                status_code = getattr(exc, "status_code", None)
                if status_code == 401:
                    row.auth_status = "reconnect_required"
                elif status_code == 403:
                    row.auth_status = "configuration_error"
                message = str(exc)
                if status_code == 403 and row.provider == "google":
                    message = (
                        "Google authorized the account but denied Drive MCP access. Enable the Google Drive API and "
                        "Google Drive MCP API in this OAuth client's Cloud project, and confirm Developer Preview access."
                    )
                row.status, row.last_error = "error", message[:500]
                db.commit()
        return _oauth_redirect("error", str(exc))


@router.post("/connections/{connection_id}/revoke")
def revoke_oauth_connection(connection_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    row = _get(ctx, connection_id)
    revoke_connection(ctx.db, row)
    return _out(row)


@router.delete("/connections/{connection_id}")
def delete_connection(connection_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    row = _get(ctx, connection_id)
    # End remote/local authorization first, but retain the non-secret connection and tool-definition snapshot so the
    # database records that this writer once connected the server. A later connection creates a fresh row and runs
    # tools/list again; it never copies definitions or credentials from this removed row.
    revoke_connection(ctx.db, row)
    ctx.db.execute(delete(OutboundMcpAuthAttempt).where(OutboundMcpAuthAttempt.connection_id == row.id))
    row.deleted_at = datetime.now(UTC)
    row.enabled = False
    row.enabled_tools = []
    row.status = "removed"
    row.last_error = None
    ctx.db.commit()
    return {"ok": True}

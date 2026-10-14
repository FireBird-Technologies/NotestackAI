"""The web app's half of connecting an app over MCP: the approval screen and the writer's list of connected apps."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import decode_token_full, get_current_user
from app.db import get_db
from app.mcp import provider
from app.models import Artifact, McpClient, McpGrant, McpWidgetState, User, Workspace, WorkspaceMember

router = APIRouter(prefix="/api/mcp", tags=["mcp"])

GONE = HTTPException(404, "This connection request has expired. Start again from the app.")


def _widget_cors(response: Response) -> None:
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Cache-Control"] = "no-store"


@router.options("/widget-state")
def widget_state_options(response: Response):
    _widget_cors(response)
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "content-type"
    return Response(status_code=204, headers=response.headers)


@router.post("/widget-state")
def widget_state(body: str = Body(media_type="text/plain"), response: Response = None,
                 db: Session = Depends(get_db)):
    """Restore a completed widget, or attach its signed instance key to the artifact it just created."""
    _widget_cors(response)
    parts = body.splitlines()
    if not parts:
        raise HTTPException(401, "Invalid widget state")
    try:
        saved = decode_token_full(parts[0], expected_type="mcp_widget_state")
        user_id, state_id = uuid.UUID(saved["sub"]), str(saved["sid"])
    except (KeyError, ValueError) as exc:
        raise HTTPException(401, "Invalid widget state") from exc
    user = db.get(User, user_id)
    if not user or not user.is_active or user.deleted_at or user.token_version != saved.get("tv"):
        raise HTTPException(401, "Invalid widget state")
    workspace = db.scalar(
        select(Workspace).join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id).order_by(WorkspaceMember.created_at).limit(1)
    )
    if not workspace:
        raise HTTPException(404, "Not found")
    if len(parts) > 1 and parts[1].strip():
        try:
            artifact_id = uuid.UUID(parts[1].strip())
        except ValueError as exc:
            raise HTTPException(400, "Invalid artifact") from exc
        artifact = db.scalar(select(Artifact).where(Artifact.id == artifact_id,
                                                     Artifact.workspace_id == workspace.id))
        if not artifact or artifact.type != saved.get("kind"):
            raise HTTPException(404, "Artifact not found")
        row = db.get(McpWidgetState, state_id)
        if row and (row.user_id != user.id or row.workspace_id != workspace.id):
            raise HTTPException(403, "Not allowed")
        if row:
            row.artifact_id, row.kind = artifact.id, artifact.type
        else:
            db.add(McpWidgetState(state_id=state_id, user_id=user.id, workspace_id=workspace.id,
                                  artifact_id=artifact.id, kind=artifact.type))
        db.commit()
        return {"artifact_id": str(artifact.id), "kind": artifact.type, "status": artifact.status}
    row = db.scalar(select(McpWidgetState).where(McpWidgetState.state_id == state_id,
                                                  McpWidgetState.user_id == user.id,
                                                  McpWidgetState.workspace_id == workspace.id))
    artifact = db.get(Artifact, row.artifact_id) if row else None
    return {"artifact_id": str(artifact.id), "kind": artifact.type, "status": artifact.status} if artifact else {
        "artifact_id": None
    }


class DecisionIn(BaseModel):
    approve: bool
    scopes: list[str] | None = None  # what the writer left ticked


@router.get("/requests/{request_id}")
def get_request(request_id: uuid.UUID, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """What the approval screen shows: which app, where it will be sent back to, and what it is asking for."""
    info = provider.describe_request(db, request_id)
    if not info:
        raise GONE
    return info


@router.post("/requests/{request_id}/decision")
def decide(request_id: uuid.UUID, body: DecisionIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        redirect = provider.decide(db, request_id, user, body.approve, body.scopes)
    except provider.BadScopes as exc:
        raise HTTPException(400, str(exc)) from exc
    if not redirect:
        raise GONE
    return {"redirect_url": redirect}


@router.get("/grants")
def list_grants(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.execute(
        select(McpGrant, McpClient).join(McpClient, McpClient.client_id == McpGrant.client_id)
        .where(McpGrant.user_id == user.id, McpGrant.revoked_at.is_(None)).order_by(McpGrant.created_at.desc())
    ).all()
    # Old data may contain duplicate grants from reconnecting an app. Rows are newest first, so expose only the latest
    # connection for each logical app.
    seen: set[tuple[str, tuple[str, ...]]] = set()
    out = []
    for grant, client in rows:
        key = provider.client_key(client.info)
        if key in seen:
            continue
        seen.add(key)
        out.append({"id": str(grant.id), "client_name": (client.info.get("client_name") or "An app")[:80],
                    "scopes": grant.scopes, "created_at": grant.created_at.isoformat(),
                    "last_used_at": grant.last_used_at.isoformat() if grant.last_used_at else None})
    return out


@router.delete("/grants/{grant_id}")
def revoke_grant(grant_id: uuid.UUID, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    grant = db.scalar(select(McpGrant).where(McpGrant.id == grant_id, McpGrant.user_id == user.id))
    if not grant:
        raise HTTPException(404, "Connected app not found")
    client = db.get(McpClient, grant.client_id)
    key = provider.client_key(client.info) if client else None
    now = datetime.now(UTC)
    rows = db.execute(
        select(McpGrant, McpClient).join(McpClient, McpClient.client_id == McpGrant.client_id)
        .where(McpGrant.user_id == user.id, McpGrant.revoked_at.is_(None))
    ).all()
    for connected, connected_client in rows:
        if connected.id == grant.id or (key is not None and provider.client_key(connected_client.info) == key):
            connected.revoked_at = now
    db.commit()
    return {"ok": True}

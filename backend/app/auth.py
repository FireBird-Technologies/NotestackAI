"""JWT helpers. Revocation = bump User.token_version; stale tokens get the same 401 as expired ones."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import User, Workspace, WorkspaceMember

_bearer = HTTPBearer(auto_error=False)
_UNAUTHORIZED = HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")


def _encode(user_id: uuid.UUID, token_version: int, kind: str, ttl: timedelta) -> str:
    now = datetime.now(UTC)
    payload = {"sub": str(user_id), "tv": token_version, "typ": kind, "iat": now, "exp": now + ttl}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_access_token(user_id: uuid.UUID, token_version: int) -> str:
    return _encode(user_id, token_version, "access", timedelta(hours=settings.jwt_expiration_hours))


def create_refresh_token(user_id: uuid.UUID, token_version: int) -> str:
    return _encode(user_id, token_version, "refresh", timedelta(days=settings.jwt_refresh_expiration_days))


def decode_token_full(token: str, expected_type: str = "access") -> dict:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError as exc:
        raise _UNAUTHORIZED from exc
    if payload.get("typ") != expected_type:
        raise _UNAUTHORIZED
    return payload


def token_version_is_current(user: User, payload: dict) -> bool:
    return payload.get("tv") == user.token_version


def load_user_from_token(db: Session, token: str, expected_type: str = "access") -> User:
    payload = decode_token_full(token, expected_type)
    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise _UNAUTHORIZED from exc
    user = db.get(User, user_id)
    if not user or not user.is_active or user.deleted_at or not token_version_is_current(user, payload):
        raise _UNAUTHORIZED
    return user


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer), db: Session = Depends(get_db)
) -> User:
    if not creds:
        raise _UNAUTHORIZED
    return load_user_from_token(db, creds.credentials)


@dataclass
class Ctx:
    user: User
    workspace: Workspace
    db: Session


def get_ctx(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> Ctx:
    """Current user plus their active workspace (first membership for now; team switching in Phase 4)."""
    workspace = db.scalar(
        select(Workspace)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(WorkspaceMember.created_at)
        .limit(1)
    )
    if not workspace:
        raise HTTPException(status.HTTP_409_CONFLICT, "No workspace for user")
    return Ctx(user=user, workspace=workspace, db=db)

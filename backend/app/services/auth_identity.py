"""Account resolution. One provider per account for life: Google accounts never get a password and
email accounts never get linked to Google."""

from dataclasses import dataclass
from datetime import UTC, datetime

import bcrypt
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models import AuthProvider, McpGrant, Subscription, User, Workspace, WorkspaceMember
from app.services.plans import PLANS


class IdentityError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass
class Resolved:
    user: User
    created: bool


def normalize_email(email: str) -> str:
    return email.strip().lower()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    return bcrypt.checkpw(password.encode(), password_hash.encode())


def validate_password(password: str) -> None:
    if len(password) < 8:
        raise IdentityError("weak_password", "Use at least 8 characters.")


def wrong_provider_error(user: User) -> IdentityError:
    if user.auth_provider == AuthProvider.GOOGLE:
        return IdentityError("wrong_provider", "This email uses Google sign in. Continue with Google.", 409)
    if user.auth_provider == AuthProvider.APPLE:
        return IdentityError("wrong_provider", "This email uses Apple sign in. Continue with Apple.", 409)
    return IdentityError("wrong_provider", "This email uses a password. Sign in with email instead.", 409)


def find_user(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(User.email == normalize_email(email)))


def _ensure_active(user: User) -> None:
    if user.deleted_at or not user.is_active:
        raise IdentityError("account_deleted", "This account was deleted. Contact support to restore it.", 403)


def _bootstrap_workspace(db: Session, user: User) -> None:
    first = (user.name or user.email.split("@")[0]).split(" ")[0]
    workspace = Workspace(name=f"{first}'s workspace", owner_id=user.id)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
    free = PLANS["free"]
    db.add(Subscription(workspace_id=workspace.id, plan="free", video_plan=free.id, video_limit=free.videos,
                        videos_period_start=datetime.now(UTC)))


def resolve_or_create_google_user(
    db: Session, *, email: str, google_id: str, name: str | None, avatar_url: str | None
) -> Resolved:
    email = normalize_email(email)
    user = db.scalar(select(User).where(User.google_id == google_id)) or find_user(db, email)
    if user:
        _ensure_active(user)
        if user.auth_provider != AuthProvider.GOOGLE:
            raise wrong_provider_error(user)
        user.name = user.name or name
        user.avatar_url = avatar_url or user.avatar_url
        return Resolved(user, False)
    user = User(
        email=email, name=name, avatar_url=avatar_url, auth_provider=AuthProvider.GOOGLE, google_id=google_id
    )
    db.add(user)
    db.flush()
    _bootstrap_workspace(db, user)
    return Resolved(user, True)


def resolve_or_create_apple_user(db: Session, *, apple_id: str, email: str | None, name: str | None) -> Resolved:
    """Sign in with Apple. Apple sends the email (and the name, on the device) only the first time: later sign ins are
    found by Apple's id alone. One provider per account: an email that already signs in another way is refused."""
    user = db.scalar(select(User).where(User.apple_id == apple_id))
    if not user and email:
        user = find_user(db, email)
    if user:
        _ensure_active(user)
        if user.auth_provider != AuthProvider.APPLE:
            raise wrong_provider_error(user)
        user.apple_id = user.apple_id or apple_id
        user.name = user.name or name
        return Resolved(user, False)
    if not email:
        # A first sign in always carries the email; without one there is no account to make (Apple was told to
        # forget us, or the token is not the first one): starting over in Settings → Apple ID fixes it.
        raise IdentityError(
            "apple_no_email",
            "Apple didn't share an email for this account. In your iPhone's Settings, remove Notestack from Sign in with Apple, then try again.",
            400,
        )
    user = User(email=normalize_email(email), name=name, auth_provider=AuthProvider.APPLE, apple_id=apple_id)
    db.add(user)
    db.flush()
    _bootstrap_workspace(db, user)
    return Resolved(user, True)


def create_password_user(db: Session, *, email: str, name: str | None, password_hash: str) -> User:
    email = normalize_email(email)
    existing = find_user(db, email)
    if existing:
        _ensure_active(existing)
        if existing.auth_provider != AuthProvider.EMAIL:
            raise wrong_provider_error(existing)
        raise IdentityError("exists", "An account with this email already exists. Sign in instead.", 409)
    user = User(email=email, name=name, auth_provider=AuthProvider.EMAIL, password_hash=password_hash)
    db.add(user)
    db.flush()
    _bootstrap_workspace(db, user)
    return user


def resolve_password_user(db: Session, *, email: str, password: str) -> User:
    user = find_user(db, email)
    if not user:
        raise IdentityError("invalid_credentials", "Email or password is incorrect.", 401)
    _ensure_active(user)
    if user.auth_provider != AuthProvider.EMAIL:
        raise wrong_provider_error(user)
    if not verify_password(password, user.password_hash):
        raise IdentityError("invalid_credentials", "Email or password is incorrect.", 401)
    return user


def sign_out_everywhere(db: Session, user: User) -> None:
    """End every web session (stale token_version) and every connected MCP app, which refreshes on its own grant."""
    user.token_version += 1
    db.execute(
        update(McpGrant)
        .where(McpGrant.user_id == user.id, McpGrant.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )


def soft_delete(db: Session, user: User) -> None:
    user.deleted_at = datetime.now(UTC)
    user.is_active = False
    sign_out_everywhere(db, user)

"""Account resolution. One provider per account for life: Google accounts never get a password and
email accounts never get linked to Google."""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

import bcrypt
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.models import ArtifactShare, AuthProvider, McpGrant, Subscription, User, Workspace, WorkspaceMember
from app.services.plans import GUEST_PLAN, PLANS

log = logging.getLogger(__name__)


class IdentityError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class HiddenEmailSignup(Exception):
    """A new Apple account would be made from a hidden (relay) email: the person may already have an account under
    their real one, which this address can't be matched to. Nothing was written; they are asked first."""


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
        raise IdentityError("account_deleted", "This account was deleted.", 403)


HIDDEN_WORKSPACE_NAME = "My workspace"


def _workspace_name(user: User) -> str:
    first = (user.name or user.email.split("@")[0]).split(" ")[0]
    return f"{first}'s workspace"


def _bootstrap_workspace(db: Session, user: User, *, hidden_email: bool = False) -> None:
    # A hidden email's address is random letters, not something to call anyone
    workspace_name = _workspace_name(user) if user.name or not hidden_email else HIDDEN_WORKSPACE_NAME
    workspace = Workspace(name=workspace_name, owner_id=user.id)
    db.add(workspace)
    db.flush()
    db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role="owner"))
    free = PLANS["free"]
    db.add(Subscription(workspace_id=workspace.id, plan="free", video_plan=free.id, video_limit=free.videos,
                        videos_period_start=datetime.now(UTC)))


def create_guest_user(db: Session) -> User:
    """A guest (services/guests.py): no name, no address, and nothing is ever mailed to it."""
    from app.services.guests import EMAIL_DOMAIN

    user = User(email=f"guest-{uuid.uuid4()}@{EMAIL_DOMAIN}", auth_provider=AuthProvider.GUEST, email_unsubscribed=True)
    db.add(user)
    db.flush()
    _bootstrap_workspace(db, user, hidden_email=True)
    db.flush()
    sub = db.scalar(select(Subscription).join(Workspace, Workspace.id == Subscription.workspace_id)
                    .where(Workspace.owner_id == user.id))
    if sub:
        sub.video_plan, sub.video_limit = GUEST_PLAN.id, GUEST_PLAN.videos
    return user


def _new_user(db: Session, guest: User | None, *, hidden_email: bool = False, **fields) -> User:
    """A new account. Made by a guest, it is the guest's own row, so its workspace, work and plan come with it."""
    if guest is None or guest.auth_provider != AuthProvider.GUEST:
        user = User(**fields)
        db.add(user)
        db.flush()
        _bootstrap_workspace(db, user, hidden_email=hidden_email)
        return user
    from app.services import guests
    from app.services.billing import resync_sources

    for key, value in fields.items():
        setattr(guest, key, value)
    guest.email_unsubscribed = False
    guest.token_version += 1  # the guest's own tokens end; the new account gets fresh ones
    guests.release(db, guest)
    db.flush()
    workspace = db.scalar(select(Workspace).where(Workspace.owner_id == guest.id))
    if workspace:
        if workspace.name == HIDDEN_WORKSPACE_NAME and (guest.name or not hidden_email):
            workspace.name = _workspace_name(guest)
        resync_sources(db, workspace.id)  # more posts fit now
    return guest


def resolve_or_create_google_user(
    db: Session, *, email: str, google_id: str, name: str | None, avatar_url: str | None, guest: User | None = None
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
    user = _new_user(db, guest, email=email, name=name, avatar_url=avatar_url, auth_provider=AuthProvider.GOOGLE,
                     google_id=google_id)
    return Resolved(user, True)


def resolve_or_create_apple_user(
    db: Session,
    *,
    apple_id: str,
    email: str | None,
    name: str | None,
    is_private_email: bool = False,
    warn_hidden: bool = False,
    guest: User | None = None,
) -> Resolved:
    """Sign in with Apple. Apple sends the email (and the name, on the device) only the first time: later sign ins are
    found by Apple's id alone. One provider per account: an email that already signs in another way is refused. With
    warn_hidden, a new account from a hidden email raises HiddenEmailSignup instead of being made."""
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
    if warn_hidden and is_private_email:
        raise HiddenEmailSignup
    # Whether Apple sent a name is the question when an account has none; the name itself stays out of the logs.
    log.info("Apple sign up: name %s, email %s", "sent" if name else "missing", "hidden" if is_private_email else "shared")
    user = _new_user(db, guest, hidden_email=is_private_email, email=normalize_email(email), name=name,
                     auth_provider=AuthProvider.APPLE, apple_id=apple_id)
    return Resolved(user, True)


def create_password_user(db: Session, *, email: str, name: str | None, password_hash: str,
                         guest: User | None = None) -> User:
    email = normalize_email(email)
    existing = find_user(db, email)
    if existing:
        _ensure_active(existing)
        if existing.auth_provider != AuthProvider.EMAIL:
            raise wrong_provider_error(existing)
        raise IdentityError("exists", "An account with this email already exists. Sign in instead.", 409)
    return _new_user(db, guest, email=email, name=name, auth_provider=AuthProvider.EMAIL, password_hash=password_hash)


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
    """Close the account now: signed out everywhere, and its public links stop working. Its data is removed for good
    30 days later (services/account_purge.py)."""
    user.deleted_at = datetime.now(UTC)
    user.is_active = False
    sign_out_everywhere(db, user)
    owned = select(Workspace.id).where(Workspace.owner_id == user.id)
    db.execute(delete(ArtifactShare).where(ArtifactShare.workspace_id.in_(owned)))

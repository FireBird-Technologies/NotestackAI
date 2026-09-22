from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.auth import create_access_token, create_refresh_token, get_current_user, load_user_from_token
from app.config import settings
from app.db import get_db
from app.models import AuthProvider, User, VerificationPurpose
from app.services import auth_identity as ident
from app.services import email_verification as ev
from app.services.email import email_service

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _err(exc: ident.IdentityError | ev.VerificationError, status: int = 400) -> HTTPException:
    return HTTPException(getattr(exc, "status", status), {"code": exc.code, "message": exc.message})


def _serialize_user(user: User) -> dict:
    return {
        "id": str(user.id),
        "email": user.email,
        "name": user.name,
        "avatar_url": user.avatar_url,
        "auth_provider": user.auth_provider.value,
        "email_unsubscribed": user.email_unsubscribed,
    }


def _finalize_login(db: Session, user: User, created: bool) -> dict:
    user.last_login_at = datetime.now(UTC)
    if created and not user.welcome_email_sent_at:
        if email_service.send_welcome(user.email, user.name, str(user.id)):
            user.welcome_email_sent_at = datetime.now(UTC)
    db.commit()
    return {
        "access_token": create_access_token(user.id, user.token_version),
        "refresh_token": create_refresh_token(user.id, user.token_version),
        "user": _serialize_user(user),
        "created": created,
    }


# Google


class GoogleIn(BaseModel):
    credential: str  # Google Identity Services ID token


@router.post("/google")
def google_login(body: GoogleIn, db: Session = Depends(get_db)):
    if not settings.google_client_id:
        raise HTTPException(503, "Google sign in is not configured")
    try:
        info = google_id_token.verify_oauth2_token(
            body.credential, google_requests.Request(), settings.google_client_id
        )
    except ValueError as exc:
        raise HTTPException(401, "Invalid Google credential") from exc
    if not info.get("email_verified"):
        raise HTTPException(401, "Google email is not verified")
    try:
        resolved = ident.resolve_or_create_google_user(
            db, email=info["email"], google_id=info["sub"], name=info.get("name"), avatar_url=info.get("picture")
        )
    except ident.IdentityError as exc:
        raise _err(exc) from exc
    return _finalize_login(db, resolved.user, resolved.created)


# Email signup (6 digit code)


class RegisterStartIn(BaseModel):
    email: EmailStr
    password: str
    name: str | None = None


class CodeIn(BaseModel):
    email: EmailStr
    code: str


class EmailIn(BaseModel):
    email: EmailStr


@router.post("/email/register/start")
def register_start(body: RegisterStartIn, db: Session = Depends(get_db)):
    email = ident.normalize_email(body.email)
    try:
        ident.validate_password(body.password)
        existing = ident.find_user(db, email)
        if existing:
            if existing.auth_provider != AuthProvider.EMAIL:
                raise ident.wrong_provider_error(existing)
            raise ident.IdentityError("exists", "An account with this email already exists. Sign in instead.", 409)
        issued = ev.issue_code(
            db,
            email,
            VerificationPurpose.SIGNUP,
            pending_name=(body.name or "").strip() or None,
            pending_password_hash=ident.hash_password(body.password),
        )
    except (ident.IdentityError, ev.VerificationError) as exc:
        raise _err(exc, 429 if getattr(exc, "code", "") == "cooldown" else 400) from exc
    db.commit()
    email_service.send_verification_code(email, issued.code)
    return {"ok": True}


@router.post("/email/register/verify")
def register_verify(body: CodeIn, db: Session = Depends(get_db)):
    email = ident.normalize_email(body.email)
    try:
        record = ev.consume_code(db, email, VerificationPurpose.SIGNUP, body.code)
        user = ident.create_password_user(
            db, email=email, name=record.pending_name, password_hash=record.pending_password_hash or ""
        )
    except (ident.IdentityError, ev.VerificationError) as exc:
        raise _err(exc) from exc
    ev.clear_codes(db, email, VerificationPurpose.SIGNUP)
    return _finalize_login(db, user, True)


@router.post("/email/register/resend")
def register_resend(body: EmailIn, db: Session = Depends(get_db)):
    email = ident.normalize_email(body.email)
    pending = ev._latest(db, email, VerificationPurpose.SIGNUP)
    if not pending:
        raise HTTPException(400, {"code": "not_found", "message": "Start sign up again."})
    try:
        issued = ev.issue_code(
            db,
            email,
            VerificationPurpose.SIGNUP,
            pending_name=pending.pending_name,
            pending_password_hash=pending.pending_password_hash,
        )
    except ev.VerificationError as exc:
        raise _err(exc, 429) from exc
    db.commit()
    email_service.send_verification_code(email, issued.code)
    return {"ok": True}


# Password login + reset


class LoginIn(BaseModel):
    email: EmailStr
    password: str


@router.post("/email/login")
def email_login(body: LoginIn, db: Session = Depends(get_db)):
    try:
        user = ident.resolve_password_user(db, email=body.email, password=body.password)
    except ident.IdentityError as exc:
        raise _err(exc) from exc
    return _finalize_login(db, user, False)


@router.post("/password/forgot/start")
def forgot_start(body: EmailIn, db: Session = Depends(get_db)):
    user = ident.find_user(db, body.email)
    # Always 200 so the endpoint does not reveal which emails exist.
    if user and user.auth_provider == AuthProvider.EMAIL and user.is_active:
        try:
            issued = ev.issue_code(db, user.email, VerificationPurpose.PASSWORD_RESET)
            db.commit()
            email_service.send_password_reset_code(user.email, issued.code)
        except ev.VerificationError:
            pass
    return {"ok": True}


@router.post("/password/forgot/check")
def forgot_check(body: CodeIn, db: Session = Depends(get_db)):
    try:
        ev.check_code(db, ident.normalize_email(body.email), VerificationPurpose.PASSWORD_RESET, body.code)
    except ev.VerificationError as exc:
        raise _err(exc) from exc
    return {"ok": True}


class ResetIn(CodeIn):
    password: str


@router.post("/password/forgot/complete")
def forgot_complete(body: ResetIn, db: Session = Depends(get_db)):
    email = ident.normalize_email(body.email)
    try:
        ident.validate_password(body.password)
        ev.consume_code(db, email, VerificationPurpose.PASSWORD_RESET, body.code)
    except (ident.IdentityError, ev.VerificationError) as exc:
        raise _err(exc) from exc
    user = ident.find_user(db, email)
    if not user:
        raise HTTPException(400, {"code": "not_found", "message": "Account not found."})
    user.password_hash = ident.hash_password(body.password)
    user.token_version += 1  # sign out everywhere
    ev.clear_codes(db, email, VerificationPurpose.PASSWORD_RESET)
    return _finalize_login(db, user, False)


# Session


class RefreshIn(BaseModel):
    refresh_token: str


@router.post("/refresh")
def refresh(body: RefreshIn, db: Session = Depends(get_db)):
    user = load_user_from_token(db, body.refresh_token, expected_type="refresh")
    return {"access_token": create_access_token(user.id, user.token_version)}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return _serialize_user(user)


@router.post("/logout")
def logout(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    user.token_version += 1
    db.commit()
    return {"ok": True}


@router.post("/delete-account")
def delete_account(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ident.soft_delete(db, user)
    db.commit()
    return {"ok": True}

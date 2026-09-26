import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.auth import (
    create_access_token,
    create_login_ticket,
    create_refresh_token,
    decode_token_full,
    encode_signed,
    get_current_user,
    load_user_from_token,
)
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


def _record_login(db: Session, user: User, created: bool) -> None:
    user.last_login_at = datetime.now(UTC)
    if created and not user.welcome_email_sent_at:
        if email_service.send_welcome(user.email, user.name, str(user.id)):
            user.welcome_email_sent_at = datetime.now(UTC)
    db.commit()


def _login_result(user: User, created: bool) -> dict:
    return {
        "access_token": create_access_token(user.id, user.token_version),
        "refresh_token": create_refresh_token(user.id, user.token_version),
        "user": _serialize_user(user),
        "created": created,
    }


def _finalize_login(db: Session, user: User, created: bool) -> dict:
    _record_login(db, user, created)
    return _login_result(user, created)


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


def _safe_next(path: str | None) -> str:
    """Only same site paths, so the redirect flow cannot be turned into an open redirect."""
    if not path or not path.startswith("/") or path.startswith("//") or "\\" in path:
        return "/app"
    return path


@router.get("/providers")
def providers():
    """Which Google flow the auth page should render: 'redirect', 'popup', or null when off."""
    if not settings.google_client_id:
        return {"google": None}
    return {"google": "redirect" if settings.google_client_secret else "popup"}


# Google redirect flow (authorization code, exchanged server side)

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
STATE_COOKIE = "ns_oauth_state"
STATE_TTL = timedelta(minutes=10)


def _frontend(path: str, **fragment: str) -> RedirectResponse:
    url = f"{settings.frontend_url.rstrip('/')}{path}"
    if fragment:
        url += "#" + urlencode(fragment)
    response = RedirectResponse(url, status_code=302)
    response.delete_cookie(STATE_COOKIE, path="/api/auth/google")
    return response


def _auth_error(message: str) -> RedirectResponse:
    return _frontend("/auth", error=message)


def exchange_google_code(code: str) -> dict:
    """Trade the authorization code for tokens and return the verified ID token claims."""
    res = httpx.post(
        GOOGLE_TOKEN_URL,
        data={
            "code": code,
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "redirect_uri": settings.google_redirect_url,
            "grant_type": "authorization_code",
        },
        timeout=10,
    )
    res.raise_for_status()
    return google_id_token.verify_oauth2_token(
        res.json()["id_token"], google_requests.Request(), settings.google_client_id
    )


@router.get("/google/start")
def google_start(next: str | None = None):
    if not (settings.google_client_id and settings.google_client_secret):
        return _auth_error("Google sign in is not configured.")
    nonce = secrets.token_urlsafe(24)
    state = encode_signed({"typ": "oauth_state", "nonce": nonce, "next": _safe_next(next)}, STATE_TTL)
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.google_redirect_url,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "nonce": nonce,
        "prompt": "select_account",
    }
    response = RedirectResponse(f"{GOOGLE_AUTH_URL}?{urlencode(params)}", status_code=302)
    # Binds the state to this browser (login CSRF). Lax so it survives the top level return from Google.
    response.set_cookie(
        STATE_COOKIE,
        nonce,
        max_age=int(STATE_TTL.total_seconds()),
        path="/api/auth/google",
        httponly=True,
        secure=settings.env != "development",
        samesite="lax",
    )
    return response


@router.get("/google/callback")
def google_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
):
    if error:
        return _auth_error("Google sign in was cancelled." if error == "access_denied" else "Google sign in failed.")
    if not code or not state:
        return _auth_error("Google sign in failed. Try again.")
    try:
        saved = decode_token_full(state, expected_type="oauth_state")
    except HTTPException:
        return _auth_error("Google sign in expired. Try again.")
    cookie = request.cookies.get(STATE_COOKIE)
    if not cookie or not secrets.compare_digest(cookie, saved.get("nonce", "")):
        return _auth_error("Google sign in expired. Try again.")
    try:
        info = exchange_google_code(code)
    except (httpx.HTTPError, KeyError, ValueError):
        return _auth_error("Google sign in failed. Try again.")
    if info.get("nonce") != saved["nonce"]:
        return _auth_error("Google sign in failed. Try again.")
    if not info.get("email_verified"):
        return _auth_error("Google email is not verified.")
    try:
        resolved = ident.resolve_or_create_google_user(
            db, email=info["email"], google_id=info["sub"], name=info.get("name"), avatar_url=info.get("picture")
        )
    except ident.IdentityError as exc:
        db.rollback()
        return _auth_error(exc.message)
    _record_login(db, resolved.user, resolved.created)
    ticket = create_login_ticket(resolved.user.id, resolved.user.token_version, resolved.created)
    # Fragment, not query: it never reaches servers or referrers, and the ticket dies in 60s.
    return _frontend("/auth/callback", ticket=ticket, next=saved["next"])


class TicketIn(BaseModel):
    ticket: str


@router.post("/ticket")
def redeem_ticket(body: TicketIn, db: Session = Depends(get_db)):
    user = load_user_from_token(db, body.ticket, expected_type="ticket")
    created = bool(decode_token_full(body.ticket, expected_type="ticket").get("new"))
    return _login_result(user, created)


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

import json
import logging
import secrets
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import httpx
import jwt
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
from app.services import apple_auth as apple
from app.services import auth_identity as ident
from app.services.crypto import decrypt, encrypt
from app.services import email_verification as ev
from app.services.email import email_service

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _err(exc: ident.IdentityError | ev.VerificationError, status: int = 400) -> HTTPException:
    return HTTPException(getattr(exc, "status", status), {"code": exc.code, "message": exc.message})


def _sent_or_fail(db: Session, sent: bool, email: str, purpose: VerificationPurpose) -> None:
    """A code the user never receives is useless: drop it and say so instead of reporting success."""
    if sent:
        return
    ev.clear_codes(db, email, purpose)
    db.commit()
    raise HTTPException(502, {"code": "email_failed", "message": "We couldn't send the code. Try again in a moment."})


def _serialize_user(user: User) -> dict:
    return {
        "id": str(user.id),
        "email": user.email,
        "name": user.name,
        "avatar_url": user.avatar_url,
        "auth_provider": user.auth_provider.value,
        "email_unsubscribed": user.email_unsubscribed,
    }


FEEDBACK_EMAIL_DELAY = timedelta(hours=2)  # a new sign-up hears from the developer this long after signing up


def _record_login(db: Session, user: User, created: bool) -> None:
    user.last_login_at = datetime.now(UTC)
    # A fresh sign-up: one email, the developer's feedback request, scheduled for later (welcome_email_sent_at marks
    # that it is scheduled, so nobody gets it twice and existing users get nothing).
    if created and not user.welcome_email_sent_at:
        if email_service.send_feedback_request(user.email, str(user.id), at=user.last_login_at + FEEDBACK_EMAIL_DELAY):
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
        # The web's popup and the apps' native sign in both send an ID token: minted for the web client, or for an
        # app's own client. Checked against all of them (the signature, issuer and expiry are checked here).
        info = google_id_token.verify_oauth2_token(
            body.credential, google_requests.Request(), None, clock_skew_in_seconds=GOOGLE_CLOCK_SKEW_SECONDS,
        )
    except ValueError as exc:
        log.warning("Google credential rejected: %s", exc)
        raise HTTPException(401, "Invalid Google credential") from exc
    if info.get("aud") not in settings.google_audiences:
        log.warning("Google credential rejected: audience %s is not one of ours", info.get("aud"))
        raise HTTPException(401, "Invalid Google credential")
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
    """Which sign in buttons the auth pages show. Google: 'redirect', 'popup', or null when off. Apple: 'native' when
    the iOS app can sign in with it, 'redirect' when the web can too, or null when off."""
    google = None if not settings.google_client_id else "redirect" if settings.google_client_secret else "popup"
    apple = None
    if settings.apple_configured and settings.apple_services_id:
        apple = "redirect"
    elif settings.apple_configured and settings.apple_bundle_id_list:
        apple = "native"
    return {"google": google, "apple": apple}


# Google redirect flow (authorization code, exchanged server side)

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
# Google stamps the ID token with its own clock. google-auth rejects a token issued even a second after the local clock
# ("Token used too early"), and a laptop clock is often a few seconds behind, so allow some drift.
GOOGLE_CLOCK_SKEW_SECONDS = 10
STATE_COOKIE = "ns_oauth_state"
STATE_TTL = timedelta(minutes=10)


def _frontend(path: str, cookie_path: str = "/api/auth/google", **fragment: str) -> RedirectResponse:
    url = f"{settings.frontend_url.rstrip('/')}{path}"
    if fragment:
        url += "#" + urlencode(fragment)
    response = RedirectResponse(url, status_code=302)
    response.delete_cookie(STATE_COOKIE, path=cookie_path)
    return response


def _auth_error(message: str, cookie_path: str = "/api/auth/google") -> RedirectResponse:
    return _frontend("/auth", cookie_path=cookie_path, error=message)


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
        res.json()["id_token"], google_requests.Request(), settings.google_client_id,
        clock_skew_in_seconds=GOOGLE_CLOCK_SKEW_SECONDS,
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
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        # The cause (rejected code, bad client secret, token clock, wrong audience) is only in this exception.
        log.warning("Google sign in failed while exchanging the code: %s: %s", type(exc).__name__, exc)
        return _auth_error("Google sign in failed. Try again.")
    if info.get("nonce") != saved["nonce"]:
        log.warning("Google sign in failed: the ID token's nonce does not match this browser's")
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


# Sign in with Apple: natively in the iOS app (POST /apple), or the redirect flow on the web (/apple/start, then Apple
# form-posts to /apple/callback). Same accounts either way.

APPLE_COOKIE_PATH = "/api/auth/apple"


def _keep_apple_token(user: User, code: str | None, client_id: str, redirect_uri: str | None = None) -> None:
    """Trade the sign in's code for Apple's refresh token, kept (encrypted, with the client it belongs to) so deleting
    the account can revoke it. Signing in never waits on its success."""
    if not code:
        return
    token = apple.exchange_code(code, client_id, redirect_uri)
    if token:
        user.apple_refresh_token = encrypt(json.dumps({"client_id": client_id, "token": token}))


class AppleIn(BaseModel):
    identity_token: str
    authorization_code: str | None = None
    # Apple gives the app the name (never in the token), and only on the first sign in.
    name: str | None = None


@router.post("/apple")
def apple_login(body: AppleIn, db: Session = Depends(get_db)):
    if not (settings.apple_configured and settings.apple_bundle_id_list):
        raise HTTPException(503, "Apple sign in is not configured")
    try:
        info = apple.verify_identity_token(body.identity_token, settings.apple_bundle_id_list)
    except apple.AppleTokenError as exc:
        log.warning("Apple identity token rejected: %s", exc)
        raise HTTPException(401, "Invalid Apple sign in") from exc
    try:
        resolved = ident.resolve_or_create_apple_user(
            db, apple_id=info.sub, email=info.email, name=(body.name or "").strip()[:200] or None
        )
    except ident.IdentityError as exc:
        raise _err(exc) from exc
    # The token's audience is the app's bundle id: the code belongs to that client.
    audience = jwt.decode(body.identity_token, options={"verify_signature": False}).get("aud")
    _keep_apple_token(resolved.user, body.authorization_code, str(audience))
    return _finalize_login(db, resolved.user, resolved.created)


@router.get("/apple/start")
def apple_start(next: str | None = None):
    if not (settings.apple_configured and settings.apple_services_id):
        return _auth_error("Apple sign in is not configured.", APPLE_COOKIE_PATH)
    nonce = secrets.token_urlsafe(24)
    state = encode_signed({"typ": "oauth_state", "nonce": nonce, "next": _safe_next(next)}, STATE_TTL)
    params = {
        "client_id": settings.apple_services_id,
        "redirect_uri": settings.apple_redirect_url,
        "response_type": "code id_token",
        "response_mode": "form_post",
        "scope": "name email",
        "state": state,
        "nonce": nonce,
    }
    response = RedirectResponse(f"{apple.APPLE_AUTHORIZE_URL}?{urlencode(params)}", status_code=302)
    # Binds the state to this browser. Apple comes back with a cross-site POST, which only carries a SameSite=None
    # cookie (and that must be Secure: the Apple flow runs over https, never on plain local http).
    response.set_cookie(
        STATE_COOKIE,
        nonce,
        max_age=int(STATE_TTL.total_seconds()),
        path=APPLE_COOKIE_PATH,
        httponly=True,
        secure=True,
        samesite="none",
    )
    return response


@router.post("/apple/callback")
async def apple_callback(request: Request, db: Session = Depends(get_db)):
    form = await request.form()
    error = form.get("error")
    if error:
        return _auth_error(
            "Apple sign in was cancelled." if error == "user_cancelled_authorize" else "Apple sign in failed.", APPLE_COOKIE_PATH
        )
    code, state, id_token = form.get("code"), form.get("state"), form.get("id_token")
    if not (isinstance(code, str) and isinstance(state, str) and isinstance(id_token, str)):
        return _auth_error("Apple sign in failed. Try again.", APPLE_COOKIE_PATH)
    try:
        saved = decode_token_full(state, expected_type="oauth_state")
    except HTTPException:
        return _auth_error("Apple sign in expired. Try again.", APPLE_COOKIE_PATH)
    cookie = request.cookies.get(STATE_COOKIE)
    if not cookie or not secrets.compare_digest(cookie, saved.get("nonce", "")):
        return _auth_error("Apple sign in expired. Try again.", APPLE_COOKIE_PATH)
    try:
        info = apple.verify_identity_token(id_token, [settings.apple_services_id], nonce=saved["nonce"])
    except apple.AppleTokenError as exc:
        log.warning("Apple sign in failed: %s", exc)
        return _auth_error("Apple sign in failed. Try again.", APPLE_COOKIE_PATH)
    # The name comes once, on the first sign in, as JSON beside the token: {"name": {"firstName", "lastName"}}.
    name = None
    raw_user = form.get("user")
    if isinstance(raw_user, str):
        try:
            parts = json.loads(raw_user).get("name") or {}
            name = " ".join(p for p in (parts.get("firstName"), parts.get("lastName")) if p).strip()[:200] or None
        except (ValueError, AttributeError):
            name = None
    try:
        resolved = ident.resolve_or_create_apple_user(db, apple_id=info.sub, email=info.email, name=name)
    except ident.IdentityError as exc:
        db.rollback()
        return _auth_error(exc.message, APPLE_COOKIE_PATH)
    _keep_apple_token(resolved.user, code, settings.apple_services_id, settings.apple_redirect_url)
    _record_login(db, resolved.user, resolved.created)
    ticket = create_login_ticket(resolved.user.id, resolved.user.token_version, resolved.created)
    # 303: the browser follows this form POST with a GET to the app.
    response = _frontend("/auth/callback", cookie_path=APPLE_COOKIE_PATH, ticket=ticket, next=saved["next"])
    response.status_code = 303
    return response


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
    _sent_or_fail(db, email_service.send_verification_code(email, issued.code), email, VerificationPurpose.SIGNUP)
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
    _sent_or_fail(db, email_service.send_verification_code(email, issued.code), email, VerificationPurpose.SIGNUP)
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
    # Sign up already tells whether an email is taken, so naming the problem here leaks nothing new.
    if not user or user.deleted_at or not user.is_active:
        raise HTTPException(404, {"code": "not_found", "message": "No account found with this email. Create one instead."})
    if user.auth_provider != AuthProvider.EMAIL:
        raise _err(ident.wrong_provider_error(user))
    try:
        issued = ev.issue_code(db, user.email, VerificationPurpose.PASSWORD_RESET)
    except ev.VerificationError as exc:
        raise _err(exc, 429) from exc
    db.commit()
    _sent_or_fail(
        db, email_service.send_password_reset_code(user.email, issued.code), user.email, VerificationPurpose.PASSWORD_RESET
    )
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
    ident.sign_out_everywhere(db, user)  # a leaked password must not keep any device or app signed in
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
    # An Apple account: revoke our access to the person's Apple ID too (App Store 5.1.1(v)). Best effort: the account
    # is deleted either way.
    if user.auth_provider == AuthProvider.APPLE and user.apple_refresh_token:
        try:
            kept = json.loads(decrypt(user.apple_refresh_token) or "{}")
            if kept.get("token") and kept.get("client_id"):
                apple.revoke(kept["token"], kept["client_id"])
        except ValueError:
            log.warning("Apple refresh token for user %s could not be read", user.id)
        user.apple_refresh_token = None
    # The paid plan ends with the account: Stripe and Google Play are cancelled, and the workspace drops to Free.
    from app.services.billing import end_subscriptions

    end_subscriptions(db, user)
    ident.soft_delete(db, user)
    db.commit()
    return {"ok": True}

"""Public lifecycle callbacks for the Threads app and the shared Facebook/Instagram app."""

import base64
import hashlib
import hmac
import html
import json
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Form, HTTPException
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import decode_token_full, encode_signed
from app.config import settings
from app.db import get_db
from app.models import SocialAccount
from app.services.social.health import erase_account

router = APIRouter(tags=["meta"])


def _unbase64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _signed_request(value: str, secret: str, integration: str) -> dict:
    """Verify and decode the signed_request posted by Meta."""
    try:
        encoded_signature, encoded_payload = value.split(".", 1)
        signature = _unbase64(encoded_signature)
        payload = json.loads(_unbase64(encoded_payload))
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "Invalid Meta signed request") from exc
    if str(payload.get("algorithm") or "").upper() != "HMAC-SHA256":
        raise HTTPException(400, "Unsupported Meta signature algorithm")
    if not secret:
        raise HTTPException(503, f"{integration} integration is not configured")
    expected = hmac.new(secret.encode(), encoded_payload.encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(400, "Invalid Meta signature")
    if not payload.get("user_id"):
        raise HTTPException(400, "Meta request did not include a user ID")
    return payload


def _disconnect_threads(db: Session, external_id: str, reason: str) -> int:
    accounts = db.scalars(select(SocialAccount).where(
        SocialAccount.platform == "threads", SocialAccount.external_id == str(external_id)
    )).all()
    for account in accounts:
        erase_account(db, account, reason)
    db.commit()
    return len(accounts)


def _main_meta_secret() -> str:
    """Facebook and Instagram use configurations belonging to the same main Meta app."""
    secrets = {value for value in (settings.facebook_client_secret, settings.instagram_client_secret) if value}
    if not secrets:
        raise HTTPException(503, "Facebook/Instagram integration is not configured")
    if len(secrets) != 1:
        raise HTTPException(503, "Facebook and Instagram lifecycle callbacks require one shared Meta app secret")
    return secrets.pop()


def _disconnect_main_meta(db: Session, authorization_user_id: str, reason: str) -> int:
    accounts = db.scalars(select(SocialAccount).where(
        SocialAccount.platform.in_(("facebook", "instagram")),
        SocialAccount.authorization_user_id == str(authorization_user_id),
    )).all()
    for account in accounts:
        erase_account(db, account, reason)
    db.commit()
    return len(accounts)


def _deletion_result(user_id: str, count: int, scope: str) -> dict:
    completed_at = datetime.now(UTC).isoformat()
    code = encode_signed({
        "typ": "meta_deletion",
        "user": hashlib.sha256(str(user_id).encode()).hexdigest()[:16],
        "connections": count,
        "scope": scope,
        "completed_at": completed_at,
    }, timedelta(days=30))
    status_url = f"{settings.api_url.rstrip('/')}/meta/data-deletion/status?code={code}"
    return {"url": status_url, "confirmation_code": code}


def _instructions() -> str:
    frontend = settings.frontend_url.rstrip("/")
    privacy = "https://notestack.ai/privacy" if "localhost" in frontend or "127.0.0.1" in frontend else f"{frontend}/privacy"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Threads data deletion · Notestack</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;line-height:1.6">
<h1>Threads data deletion</h1>
<p>To remove your Threads connection and its access token from Notestack, open Notestack, go to
<strong>Launchpad → Connections → Threads</strong>, and select <strong>Disconnect</strong>.</p>
<p>You may also remove Notestack from your Threads account's connected-app settings. Meta will notify Notestack and
we will remove the stored Threads access token automatically.</p>
<p>Deleting your Notestack account from Settings also removes the connection. See the
<a href="{privacy}">Notestack privacy policy</a> for more information.</p>
</body></html>"""


@router.get("/meta/data-deletion", response_class=HTMLResponse)
def data_deletion_instructions():
    """Human-readable URL accepted by Meta as the data deletion instructions URL."""
    return _instructions()


@router.post("/meta/data-deletion")
def data_deletion_callback(signed_request: str = Form(...), db: Session = Depends(get_db)):
    """Meta's automated deletion callback. It must return a status URL and confirmation code."""
    payload = _signed_request(signed_request, settings.threads_client_secret, "Threads")
    count = _disconnect_threads(db, str(payload["user_id"]), "Threads requested deletion of this connection.")
    return _deletion_result(str(payload["user_id"]), count, "Threads")


@router.post("/meta/deauthorize")
def deauthorize_callback(signed_request: str = Form(...), db: Session = Depends(get_db)):
    """Remove credentials when a person removes the app from Threads settings."""
    payload = _signed_request(signed_request, settings.threads_client_secret, "Threads")
    count = _disconnect_threads(db, str(payload["user_id"]), "Threads deauthorized this connection.")
    return {"success": True, "connections_removed": count}


def _facebook_instagram_instructions() -> str:
    frontend = settings.frontend_url.rstrip("/")
    privacy = "https://notestack.ai/privacy" if "localhost" in frontend or "127.0.0.1" in frontend else f"{frontend}/privacy"
    launchpad = f"{frontend}/app/launchpad"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Facebook and Instagram data deletion · Notestack</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;line-height:1.6">
<h1>Facebook and Instagram data deletion</h1>
<p>To remove a Facebook or Instagram connection and its stored access token, open
<a href="{launchpad}">Notestack Launchpad</a>, find the account under Connections, and select Disconnect.</p>
<p>You may also remove Notestack from your Meta connected-app or business-integration settings. Meta will notify
Notestack and we will remove the Facebook and Instagram access credentials issued for that authorization.</p>
<p>See the <a href="{privacy}">Notestack privacy policy</a> for more information.</p>
</body></html>"""


@router.get("/meta/facebook-instagram/data-deletion", response_class=HTMLResponse)
def facebook_instagram_data_deletion_instructions():
    return _facebook_instagram_instructions()


@router.post("/meta/facebook-instagram/data-deletion")
def facebook_instagram_data_deletion_callback(signed_request: str = Form(...), db: Session = Depends(get_db)):
    """Delete every Facebook/Instagram grant associated with the main app-scoped authorization identity."""
    payload = _signed_request(signed_request, _main_meta_secret(), "Facebook/Instagram")
    user_id = str(payload["user_id"])
    count = _disconnect_main_meta(db, user_id, "Meta requested deletion of this Facebook/Instagram connection.")
    return _deletion_result(user_id, count, "Facebook and Instagram")


@router.post("/meta/facebook-instagram/deauthorize")
def facebook_instagram_deauthorize_callback(signed_request: str = Form(...), db: Session = Depends(get_db)):
    """Remove Facebook/Instagram credentials when the shared Meta app is deauthorized."""
    payload = _signed_request(signed_request, _main_meta_secret(), "Facebook/Instagram")
    count = _disconnect_main_meta(
        db, str(payload["user_id"]), "Meta deauthorized this Facebook/Instagram connection."
    )
    return {"success": True, "connections_removed": count}


@router.get("/meta/data-deletion/status", response_class=HTMLResponse)
def data_deletion_status(code: str):
    try:
        payload = decode_token_full(code, expected_type="meta_deletion")
    except HTTPException as exc:
        raise HTTPException(404, "Deletion confirmation not found or expired") from exc
    completed = html.escape(str(payload.get("completed_at") or "completed"))
    scope = html.escape(str(payload.get("scope") or "Meta"))
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deletion complete · Notestack</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;line-height:1.6">
<h1>{scope} data deletion complete</h1>
<p>The {scope} connections and stored access credentials covered by this request were removed.</p>
<p>Completed: {completed}</p>
</body></html>"""

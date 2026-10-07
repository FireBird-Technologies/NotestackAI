"""6 digit codes: hashed, 10 minute TTL, 5 attempts, 60s resend cooldown, purged after 1 day."""

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import EmailVerificationCode, VerificationPurpose

CODE_TTL = timedelta(minutes=10)
MAX_ATTEMPTS = 5
RESEND_COOLDOWN = timedelta(seconds=60)
PURGE_AFTER = timedelta(days=1)


class VerificationError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class IssuedCode:
    code: str
    record: EmailVerificationCode


def _hash(email: str, code: str) -> str:
    return hmac.new(settings.jwt_secret.encode(), f"{email}:{code}".encode(), hashlib.sha256).hexdigest()


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _latest(db: Session, email: str, purpose: VerificationPurpose) -> EmailVerificationCode | None:
    return db.scalar(
        select(EmailVerificationCode)
        .where(
            EmailVerificationCode.email == email,
            EmailVerificationCode.purpose == purpose,
            EmailVerificationCode.consumed_at.is_(None),
        )
        .order_by(EmailVerificationCode.created_at.desc())
        .limit(1)
    )


def _alive(record: EmailVerificationCode, now: datetime) -> bool:
    """A code that can still be entered. Dead codes (expired, out of tries) never hold up a resend."""
    return now <= _aware(record.expires_at) and record.attempts < MAX_ATTEMPTS


def issue_code(
    db: Session,
    email: str,
    purpose: VerificationPurpose,
    pending_name: str | None = None,
    pending_password_hash: str | None = None,
) -> IssuedCode:
    now = datetime.now(UTC)
    latest = _latest(db, email, purpose)
    if latest and _alive(latest, now) and now - _aware(latest.created_at) < RESEND_COOLDOWN:
        raise VerificationError("cooldown", "Please wait a minute before requesting another code.")
    clear_codes(db, email, purpose)
    code = f"{secrets.randbelow(1_000_000):06d}"
    record = EmailVerificationCode(
        email=email,
        purpose=purpose,
        code_hash=_hash(email, code),
        pending_name=pending_name,
        pending_password_hash=pending_password_hash,
        expires_at=now + CODE_TTL,
    )
    db.add(record)
    db.flush()
    return IssuedCode(code=code, record=record)


def check_code(db: Session, email: str, purpose: VerificationPurpose, code: str) -> EmailVerificationCode:
    """Validate without consuming (used by the password reset 'check' step)."""
    record = _latest(db, email, purpose)
    if not record:
        raise VerificationError("not_found", "No active code. Request a new one.")
    if record.attempts >= MAX_ATTEMPTS:
        raise VerificationError("too_many_attempts", "Too many wrong tries. This code has expired. Request a new one.")
    if datetime.now(UTC) > _aware(record.expires_at):
        raise VerificationError("expired", "That code expired. Request a new one.")
    if not hmac.compare_digest(record.code_hash, _hash(email, code.strip())):
        record.attempts += 1
        left = MAX_ATTEMPTS - record.attempts
        if left <= 0:
            # Expire rather than consume: sign up resend still needs the pending name and password.
            record.expires_at = datetime.now(UTC)
            db.commit()
            raise VerificationError("too_many_attempts", "Too many wrong tries. This code has expired. Request a new one.")
        db.commit()
        raise VerificationError("invalid", f"That code is not right. {left} {'try' if left == 1 else 'tries'} left.")
    return record


def consume_code(db: Session, email: str, purpose: VerificationPurpose, code: str) -> EmailVerificationCode:
    record = check_code(db, email, purpose, code)
    record.consumed_at = datetime.now(UTC)
    return record


def clear_codes(db: Session, email: str, purpose: VerificationPurpose) -> None:
    db.execute(
        delete(EmailVerificationCode).where(
            EmailVerificationCode.email == email, EmailVerificationCode.purpose == purpose
        )
    )


def purge_old_codes(db: Session) -> None:
    db.execute(
        delete(EmailVerificationCode).where(
            EmailVerificationCode.created_at < datetime.now(UTC) - PURGE_AFTER
        )
    )
    db.commit()

"""Publishing to X, LinkedIn and Bluesky. Each platform module exposes:

    publish(db, account, posts: list[str]) -> (external_id, external_url)
    metrics(db, account, external_id) -> dict

A list with more than one post is published as a thread (reply chain) where the platform supports it.
"""

from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.models import SocialAccount
from app.services.crypto import decrypt, encrypt


class SocialError(RuntimeError):
    def __init__(self, message: str, permanent: bool = False):
        super().__init__(message)
        self.permanent = permanent


PLATFORM_LABELS = {"x": "X", "linkedin": "LinkedIn", "bluesky": "Bluesky", "substack_notes": "Substack Notes"}
AUTO_POST = {"x", "linkedin", "bluesky"}
LIMITS = {"x": 280, "bluesky": 300, "linkedin": 3000, "substack_notes": 2000}


def token(account: SocialAccount) -> str:
    value = decrypt(account.access_token)
    if not value:
        raise SocialError("Stored credentials could not be read. Reconnect the account.", permanent=True)
    return value


def save_tokens(db: Session, account: SocialAccount, access: str, refresh: str | None, expires_in: int | None) -> None:
    account.access_token = encrypt(access)
    if refresh:
        account.refresh_token = encrypt(refresh)
    if expires_in:
        account.expires_at = datetime.fromtimestamp(datetime.now(UTC).timestamp() + int(expires_in), UTC)
    account.status = "active"
    db.commit()


def expired(account: SocialAccount) -> bool:
    if not account.expires_at:
        return False
    exp = account.expires_at if account.expires_at.tzinfo else account.expires_at.replace(tzinfo=UTC)
    return exp.timestamp() - 120 < datetime.now(UTC).timestamp()


def module(platform: str):
    from app.services.social import bluesky, linkedin, x

    return {"x": x, "linkedin": linkedin, "bluesky": bluesky}[platform]

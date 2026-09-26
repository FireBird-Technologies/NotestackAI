"""Encrypts third party tokens at rest (social accounts). Fernet key from SOCIAL_TOKEN_KEY, or derived
from JWT_SECRET so local dev needs no extra setting."""

import base64
import hashlib
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings


@lru_cache
def _fernet() -> Fernet:
    key = settings.social_token_key
    if not key:
        key = base64.urlsafe_b64encode(hashlib.sha256(f"social:{settings.jwt_secret}".encode()).digest()).decode()
    return Fernet(key.encode())


def encrypt(value: str | None) -> str | None:
    return _fernet().encrypt(value.encode()).decode() if value else None


def decrypt(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return _fernet().decrypt(value.encode()).decode()
    except InvalidToken:
        return None

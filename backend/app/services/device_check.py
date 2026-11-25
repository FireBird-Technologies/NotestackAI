"""Apple's DeviceCheck: two bits Apple keeps per iPhone for our team, which survive reinstalling the app and erasing the
phone. They hold the GUEST_EPOCH whose guest allowance this device has taken (0: none), so it cannot be taken twice.
A valid token also proves the request came from a real device running our app.
"""

import logging
import time
import uuid

import httpx
import jwt

from app.config import settings

log = logging.getLogger(__name__)

HOSTS = {"production": "https://api.devicecheck.apple.com", "development": "https://api.development.devicecheck.apple.com"}
TIMEOUT = 8


class DeviceCheckInvalid(Exception):
    """Apple says the token is not a real one for our app."""


class DeviceCheckUnavailable(Exception):
    """Apple could not be asked (not set up here, an outage, our key refused): says nothing about the device."""


def _auth() -> str:
    key = settings.devicecheck_private_key.replace("\\n", "\n")
    token = jwt.encode({"iss": settings.apple_team_id, "iat": int(time.time())}, key, algorithm="ES256",
                       headers={"kid": settings.devicecheck_key_id})
    return f"Bearer {token}"


def _post(path: str, device_token: str, **body) -> httpx.Response:
    if not settings.devicecheck_configured:
        raise DeviceCheckUnavailable("DeviceCheck is not configured")
    host = HOSTS["development" if settings.devicecheck_development else "production"]
    try:
        res = httpx.post(f"{host}/v1/{path}", timeout=TIMEOUT, headers={"Authorization": _auth()},
                         json={"device_token": device_token, "transaction_id": uuid.uuid4().hex,
                               "timestamp": int(time.time() * 1000), **body})
    except (httpx.HTTPError, ValueError, jwt.PyJWTError) as exc:  # ValueError: the key is not a key
        raise DeviceCheckUnavailable(f"{type(exc).__name__}: {exc}") from exc
    if res.status_code == 400:
        raise DeviceCheckInvalid(res.text[:200])
    if res.status_code != 200:
        raise DeviceCheckUnavailable(f"{res.status_code}: {res.text[:200]}")
    return res


def read(device_token: str) -> int:
    """The epoch stored for this device, 0-3."""
    res = _post("query_two_bits", device_token)
    try:
        data = res.json()
    except ValueError:
        return 0  # Apple answers 200 with plain text ("Failed to find bit state") for a device never written
    return int(bool(data.get("bit0"))) + 2 * int(bool(data.get("bit1")))


def write(device_token: str, epoch: int) -> None:
    _post("update_two_bits", device_token, bit0=bool(epoch & 1), bit1=bool(epoch & 2))

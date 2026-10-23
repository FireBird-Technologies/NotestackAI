"""Server errors (any 5xx from the API) emailed to ALERTS_EMAIL as plain text: what failed, where, and the traceback.

Sent on a background thread, so the failing request is not slowed by the email. The same error (same route and
exception) is emailed at most once per REPEAT_WINDOW, with a count of the ones held back; and no more than
MAX_PER_HOUR alerts go out in all, so an outage cannot flood the inbox."""

import logging
import platform
import threading
import time
import traceback
from collections import deque
from datetime import UTC, datetime
from pathlib import Path

from app.config import settings
from app.services.email import email_service

log = logging.getLogger(__name__)

REPEAT_WINDOW = 600  # seconds
MAX_PER_HOUR = 30

_lock = threading.Lock()
_last_sent: dict[str, float] = {}  # error key -> when it was last emailed
_held_back: dict[str, int] = {}  # error key -> repeats not emailed since
_sent_times: deque[float] = deque()
_BACKEND = str(Path(__file__).resolve().parents[2]) + "/"  # paths are shown from here: app/routers/x.py


def _allow(key: str, now: float) -> tuple[bool, int]:
    """Whether to email this error now, and how many repeats of it were held back before it."""
    with _lock:
        while _sent_times and now - _sent_times[0] > 3600:
            _sent_times.popleft()
        last = _last_sent.get(key)
        if (last is not None and now - last < REPEAT_WINDOW) or len(_sent_times) >= MAX_PER_HOUR:
            _held_back[key] = _held_back.get(key, 0) + 1
            return False, 0
        _last_sent[key] = now
        _sent_times.append(now)
        return True, _held_back.pop(key, 0)


def _where(exc: BaseException | None) -> str:
    """The innermost frame in our own code (not a library's): backend-relative file:line in function."""
    if exc is None:
        return "unknown (a 5xx response, no exception raised)"
    frames = traceback.extract_tb(exc.__traceback__)
    ours = [f for f in frames if "site-packages" not in f.filename and "/lib/python" not in f.filename]
    if not frames:
        return "unknown"
    frame = (ours or frames)[-1]
    name = frame.filename
    if name.startswith(_BACKEND):
        name = name[len(_BACKEND):]
    return f"{name}:{frame.lineno} in {frame.name}"


def report_server_error(*, method: str, path: str, route: str | None, status: int, request_id: str,
                        query_keys: list[str], client: str | None, user_agent: str | None,
                        duration_ms: float, exc: BaseException | None = None) -> None:
    """Email ALERTS_EMAIL about a 5xx. Never raises."""
    try:
        error = f"{type(exc).__name__}: {exc}" if exc is not None else f"HTTP {status}"
        key = f"{method} {route or path} {type(exc).__name__ if exc else status}"
        ok, held = _allow(key, time.monotonic())
        if not ok:
            return
        where = _where(exc)
        target = route or path
        env = f"{settings.env} on {platform.node()}"
        if exc is not None:
            what = f"{method} {path} crashed with {error.splitlines()[0][:200]}, at {where}."
        else:
            what = f"{method} {path} answered {status} without raising an error (the route returned it on purpose)."
        lines = [
            f"Something failed on the Notestack backend ({env}).",
            "",
            what,
            f"Whoever made the request got a {status} error. Search the logs for rid={request_id} to see the request.",
            "",
            "Details",
            f"Error: {error}",
            f"Where: {where}",
            f"Request: {method} {path}",
            f"Route: {target}",
            f"Status: {status}",
            f"Request id: {request_id}",
            f"Time (UTC): {datetime.now(UTC).strftime('%Y-%m-%d %H:%M:%S')}",
            f"Took: {duration_ms:.0f} ms",
            f"Query keys: {', '.join(query_keys) or 'none'}",
            f"Client: {client or 'unknown'}",
            f"User agent: {user_agent or 'unknown'}",
            f"Environment: {env}",
        ]
        if held:
            lines += ["", f"The same error happened {held} more time(s) since the last alert (those were not emailed)."]
        if exc is not None:
            # chain=False: only this error, not the framework's own exception it surfaced through
            lines += ["", "Traceback", "".join(traceback.format_exception(exc, chain=False)).rstrip()]
        kind = type(exc).__name__ if exc is not None else f"HTTP {status}"
        subject = f"Failure on Notestack backend: {kind} in {method} {target}"
        _send_later(subject, "\n".join(lines))
    except Exception:  # an alert must never break the response it is about
        log.exception("could not send the server error alert")


def _send_later(subject: str, text: str) -> None:
    """On its own thread, so the failing request does not wait for the email."""
    threading.Thread(target=email_service.send_error_alert, args=(subject, text), daemon=True).start()

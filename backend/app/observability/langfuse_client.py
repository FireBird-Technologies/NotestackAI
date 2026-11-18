"""Langfuse for the notebook chat: one trace per message, scores from ratings and the judge.

Optional in every way. With no LANGFUSE_PUBLIC_KEY/SECRET_KEY, or the `langfuse` package missing, every helper here
does nothing and the chat runs as before. A Langfuse failure is logged and never reaches the writer.

Writers' text (questions, answers, passages, search patterns) leaves our stack only when LANGFUSE_MASK_TEXT=false:
by default `text()` sends its size instead. Ids are hashed before they are sent."""

import hashlib
import logging
import threading
from typing import Any

from app.config import settings

log = logging.getLogger(__name__)

_client: Any = None
_lock = threading.Lock()
_broken = False  # the package is missing or the client could not start: stay off for this process


def configured() -> bool:
    return bool(settings.langfuse_public_key and settings.langfuse_secret_key)


def client() -> Any:
    """The process's Langfuse client, or None when off."""
    global _client, _broken
    if _broken or not configured():
        return None
    if _client is None:
        with _lock:
            if _client is None and not _broken:
                try:
                    from langfuse import Langfuse

                    _client = Langfuse(public_key=settings.langfuse_public_key,
                                       secret_key=settings.langfuse_secret_key,
                                       base_url=settings.langfuse_host or None,
                                       environment=settings.env.lower() or None)
                except Exception:
                    log.warning("Langfuse could not start; chat tracing is off in this process", exc_info=True)
                    _broken = True
                    return None
    return _client


def enabled() -> bool:
    return client() is not None


def text(value: str | None) -> Any:
    """What may be sent for a piece of writers' text: the text itself only when masking is off."""
    if value is None:
        return None
    return {"chars": len(value)} if settings.langfuse_mask_text else value


def pseudonym(value: Any) -> str:
    """A stable, non-reversible id for a user or workspace."""
    return hashlib.sha256(f"notestack:{value}".encode()).hexdigest()[:24]


def score(trace_id: str | None, name: str, value: float | str, comment: str | None = None,
          data_type: str | None = None, score_id: str | None = None) -> bool:
    """Attach a score to a chat message's trace. False when off, when the message has no trace, or on failure.
    A fixed score_id replaces the earlier score with that id (a writer who rates again)."""
    lf = client()
    if lf is None or not trace_id:
        return False
    try:
        kwargs: dict[str, Any] = {"name": name, "value": value, "trace_id": trace_id}
        if comment:
            kwargs["comment"] = comment[:1000]
        if data_type:
            kwargs["data_type"] = data_type
        if score_id:
            kwargs["score_id"] = score_id
        lf.create_score(**kwargs)
        return True
    except Exception:
        log.warning("Could not send the Langfuse score %s", name, exc_info=True)
        return False


def flush() -> None:
    lf = client()
    if lf is not None:
        try:
            lf.flush()
        except Exception:
            log.warning("Could not flush Langfuse", exc_info=True)


def reset_for_tests() -> None:
    global _client, _broken
    _client, _broken = None, False

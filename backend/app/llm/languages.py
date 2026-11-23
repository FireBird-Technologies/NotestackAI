"""The app's interface language, so AI output follows it.

The mobile app sends X-App-Language (a code such as "es") when its interface is not English. The middleware in
main.py puts it in a context variable for the request. Jobs created during the request carry it in their params
(services/jobs.py), and the worker restores it while it runs them. Pipelines that already take a language get the
English name as their default, and an explicit language (picked in the app or named in chat) still wins. With no
header, nothing changes: AI output stays in the language of the sources."""

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

# Keep in step with LANGUAGES in mobile/src/i18n/index.ts. English is absent on purpose: the app sends no header.
APP_LANGUAGES: dict[str, str] = {
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "pt": "Portuguese",
    "ar": "Arabic",
    "ur": "Urdu",
    "zh": "Chinese (Simplified)",
    "ja": "Japanese",
    "ko": "Korean",
}

HEADER = "x-app-language"
PARAM = "app_language"  # the code, kept in a job's params

_current: ContextVar[str | None] = ContextVar("app_language", default=None)


def parse(value: str | None) -> str | None:
    """A supported code from a header value such as "es", "es-MX" or "zh-Hans", else None."""
    if not value:
        return None
    code = value.strip().lower().replace("_", "-").split("-")[0]
    return code if code in APP_LANGUAGES else None


def app_language() -> str | None:
    """The current request's (or job's) app language code, or None."""
    return _current.get()


def app_language_name() -> str | None:
    """The English name of the current app language ("Spanish"), or None."""
    code = _current.get()
    return APP_LANGUAGES.get(code) if code else None


@contextmanager
def use_app_language(code: str | None) -> Iterator[None]:
    token = _current.set(parse(code))
    try:
        yield
    finally:
        _current.reset(token)


def reply_language_note() -> str:
    """A line for the writer notes in chat, or "" when the app is in English."""
    name = app_language_name()
    if not name:
        return ""
    return (f"Reply language: write the answer in {name}, the language of the writer's app. If the writer's message "
            "is written in another language, answer in the language of the message instead.")

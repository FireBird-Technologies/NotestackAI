"""Server log switches for chat memory.

Two loggers, because they hold different things:
  notestack.chat_memory   what the summary job did: which chat, how many rounds, which R2 keys it wrote and how big. No
                          writer text, so it is always on.
  notestack.chat_context  what the research agent is given on each message, and the text of new summaries. That is
                          writers' text, so it is on in development, or when CHAT_CONTEXT_LOG=true."""

import logging

from app.config import settings

job_log = logging.getLogger("notestack.chat_memory")
context_log = logging.getLogger("notestack.chat_context")


def text_enabled() -> bool:
    """Whether logs may contain writers' text: CHAT_CONTEXT_LOG if set, else on only in development."""
    return settings.chat_context_log if settings.chat_context_log is not None else settings.env == "development"

"""One readable block in the server log for every chat message: what ran, in what order, what Jev or the triage model
chose (and why a threshold changed it), what each model was given, which tools the agent called, and how long every
stage took.

Logger `notestack.chat_trace`. The structure is always logged. Writers' text (the message, the note values) is added
only when text logging is on (the same switch as `notestack.chat_context`: CHAT_CONTEXT_LOG, or development).
`notestack.chat_context` still holds the full text of everything the agent was given, for when you need to read it."""

import logging
import time
from contextlib import contextmanager
from contextvars import ContextVar

from app.chat_memory.logs import text_enabled

trace_log = logging.getLogger("notestack.chat_trace")

# What each memory level hands to the research agent (see chat_memory/context.py build_context).
MEMORY_GIVES = {
    "none": "nothing extra: the agent only sees the last messages of this chat",
    "lookup": "the topic's summary (R2 file) + its last messages word for word (Postgres). No chat tools",
    "replay": "the topic's summary + its saved exact quotes (R2 file) + the 3 chat tools",
    "compose": "the notebook's topic index, first 20 lines (R2 file) + the 3 chat tools",
}

# Where each tool reads from, for the step list.
STEP_SOURCE = {"list": "posts, local disk cache", "search": "posts, local disk cache",
               "read": "post, local disk cache", "recall": "earlier chats, local disk cache", "think": ""}

SECTIONS = ("load", "route", "triage", "context", "steps", "citations", "result", "save", "notes")
TITLES = {"load": "1 LOAD (Postgres, R2)", "route": "2 PATH", "triage": "3 TRIAGE",
          "context": "4 WHAT THE AGENT WAS GIVEN", "steps": "5 AGENT STEPS", "citations": "6 CITATIONS",
          "result": "7 RESULT", "save": "8 SAVED", "notes": "9 AFTER THE ANSWER"}


def ms(value: float) -> str:
    return f"{value:.0f}ms" if value < 1000 else f"{value / 1000:.1f}s"


class ChatTrace:
    def __init__(self, chat_id: str = "", notebook: str = "", message: str = ""):
        self.chat_id, self.notebook, self.message = chat_id, notebook, message
        self.t0 = time.perf_counter()
        self.stages: list[tuple[str, float]] = []
        self.sections: dict[str, list[str]] = {}
        self.marks: dict[str, float] = {}
        self.agent_started: float | None = None
        self.error = ""

    # Recording

    @contextmanager
    def stage(self, name: str):
        start = time.perf_counter()
        try:
            yield
        finally:
            self.stages.append((name, (time.perf_counter() - start) * 1000))

    def mark(self, name: str) -> None:
        """A moment on the clock, in ms since the message arrived (e.g. when the answer was sent)."""
        self.marks[name] = (time.perf_counter() - self.t0) * 1000

    def add(self, section: str, *lines: str) -> None:
        self.sections.setdefault(section, []).extend(lines)

    def start_agent(self) -> None:
        self.agent_started = time.perf_counter()

    def step(self, kind: str, detail: str) -> None:
        offset = (time.perf_counter() - (self.agent_started or self.t0)) * 1000
        source = STEP_SOURCE.get(kind, "")
        self.add("steps", f"+{ms(offset):>6}  {kind:<6} {detail}" + (f"   [{source}]" if source else ""))

    # Output

    def render(self) -> str:
        total = (time.perf_counter() - self.t0) * 1000
        answered = self.marks.get("answer")
        head = f"CHAT TRACE  chat={self.chat_id[:8] or '-'}  notebook={self.notebook!r}"
        shown = f"  {self.message[:140]!r}" if text_enabled() else ""
        lines = [head, f"  message : {len(self.message)} chars{shown}"]
        if answered is not None:
            lines.append(f"  clock   : answer sent after {ms(answered)}, stream closed after {ms(total)}")
        else:
            lines.append(f"  clock   : stopped after {ms(total)}" + (f"  ERROR: {self.error}" if self.error else ""))
        for key in SECTIONS:
            body = self.sections.get(key)
            if not body:
                continue
            lines.append(f"  [{TITLES[key]}]")
            lines += [f"    {ln}" for ln in body]
        if self.stages:
            lines.append("  [TIMING]  " + "  |  ".join(f"{name} {ms(took)}" for name, took in self.stages))
        return "\n".join(lines)

    def emit(self) -> None:
        try:
            trace_log.info(self.render())
        except Exception:  # a log line must never break a chat
            logging.getLogger(__name__).warning("Could not write the chat trace", exc_info=True)


# research() runs in a worker thread (asyncio.to_thread copies the context), so the request hands its trace over
# this way instead of through research()'s arguments.
_current: ContextVar["ChatTrace | None"] = ContextVar("chat_trace", default=None)


def use_trace(trace: "ChatTrace") -> None:
    _current.set(trace)


def current_trace() -> "ChatTrace | None":
    return _current.get()


def probs_text(probabilities: dict[str, float], limit: int = 5) -> str:
    top = sorted(probabilities.items(), key=lambda kv: kv[1], reverse=True)[:limit]
    return "  ".join(f"{name} {p:.2f}" for name, p in top)

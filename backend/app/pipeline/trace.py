"""One readable block in the server log for every chat message: what ran, in what order, what Jev or the triage model
chose (and why a threshold changed it), what each model was given, which tools the agent called, and how long every
stage took.

Logger `notestack.chat_trace`. The structure is always logged. Writers' text (the message, the note values) is added
only when text logging is on (the same switch as `notestack.chat_context`: CHAT_CONTEXT_LOG, or development).
`notestack.chat_context` still holds the full text of everything the agent was given, for when you need to read it.

The same trace also goes to Langfuse when it is configured (app/observability/langfuse_client.py): the message is the
root observation, every stage() a span, every agent step an event, every answer-writer call a generation, and the
outcome code (why an answer did or did not come out) a trace tag. Without Langfuse all of that is a no-op."""

import logging
import time
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from app.chat_memory.logs import text_enabled
from app.config import settings
from app.observability import langfuse_client as lf

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

SECTIONS = ("load", "route", "triage", "context", "steps", "writer", "citations", "result", "save", "notes")
TITLES = {"load": "1 LOAD (Postgres, R2)", "route": "2 PATH", "triage": "3 TRIAGE",
          "context": "4 WHAT THE AGENT WAS GIVEN", "steps": "5 AGENT STEPS",
          "writer": "5b ANSWER WRITER (streaming, fast path, rewrite, parts)", "citations": "6 CITATIONS",
          "result": "7 RESULT", "save": "8 SAVED", "notes": "9 AFTER THE ANSWER"}


# Why a message ended the way it did. Saved as recall_json["outcome"] and sent to Langfuse as the tag outcome:<code>.
OUTCOMES = {
    "answered": "an archive answer with verified citations",
    "cache_hit": "an earlier identical answer was reused",
    "writer_uncovered": "the model said the material it was given does not answer the question",
    "refused_no_cites": "the model answered without any citation, so the 'could not find support' reply was sent",
    "cites_dropped": "the model cited lines, none passed verification, so the 'could not find support' reply was sent",
    "triage_off_topic": "triage called the message off topic, so no research ran",
    "triage_other": "small talk, app help or a create request: no research needed",
    "external_done": "a connected app did the work",
    "external_failed": "a connected app was asked but nothing usable came back",
    "agent_malformed": "the research agent's replies could not be read",
    "exception": "the chat raised; no answer was saved",
    "timeout": "a model request took longer than CHAT_LLM_TIMEOUT_SECONDS; no answer was saved",
}

# What each outcome means for whoever reads Langfuse: pass (the question got what it needed), fail (it did not: no
# answer, an unsupported answer, a crash) or review (turned away as off topic: right for "capital of France", wrong
# when the notebook did cover it). Shown as the trace name, its level (fail = ERROR, review = WARNING) and a score.
VERDICTS = {"answered": "pass", "cache_hit": "pass", "external_done": "pass", "triage_other": "pass",
            "triage_off_topic": "review"}


def verdict_of(outcome: str) -> str:
    return VERDICTS.get(outcome, "fail") if outcome else ""


# Trace sections that never hold writers' text: sent to Langfuse even when text is masked.
_SAFE_SECTIONS = ("route", "triage", "writer", "result")


class _NoObservation:
    """What stage() and observe() yield when Langfuse is off: accepts any update and does nothing."""

    def update(self, **_kwargs) -> "_NoObservation":
        return self


_NONE = _NoObservation()


def _safe(fn, *args, **kwargs):
    """A Langfuse call that must never break a chat."""
    try:
        return fn(*args, **kwargs)
    except Exception:
        logging.getLogger(__name__).warning("Langfuse call failed", exc_info=True)
        return None


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
        # Langfuse (all empty when it is off)
        self.trace_id = ""
        self.outcome = ""
        self.tags: list[str] = []
        self.output: str | None = None
        self._root: Any = None

    # Langfuse

    def start_langfuse(self, *, user: Any = None, session: str = "", metadata: dict | None = None) -> str:
        """Open this message's Langfuse trace. Returns its id ("" when Langfuse is off)."""
        client = lf.client()
        if client is None or self._root is not None:
            return self.trace_id
        trace_id = _safe(client.create_trace_id)
        if not trace_id:
            return ""
        root = _safe(client.start_observation, trace_context={"trace_id": trace_id}, name="notebook-chat",
                     as_type="chain", input=lf.text(self.message), metadata=metadata or {})
        if root is None:
            return ""
        self.trace_id, self._root = trace_id, root
        attrs = {"langfuse.trace.name": "notebook-chat", "session.id": session}
        if user is not None:
            attrs["user.id"] = lf.pseudonym(user)
        for key, value in attrs.items():
            if value:
                _safe(root._otel_span.set_attribute, key, value)
        return trace_id

    def tag(self, *tags: str) -> None:
        self.tags += [t for t in tags if t and t not in self.tags]

    def set_outcome(self, outcome: str) -> None:
        self.outcome = outcome
        self.tag(f"outcome:{outcome}")

    @contextmanager
    def observe(self, name: str, as_type: str = "span", **kwargs):
        """A child observation of the message (a span, or a generation for a model call). Yields an object with
        update(); the observation ends when the block does, marked as an error if the block raised."""
        obs = _safe(self._root.start_observation, name=name, as_type=as_type, **kwargs) if self._root else None
        try:
            yield obs or _NONE
        except BaseException as exc:
            if obs is not None:
                _safe(obs.update, level="ERROR", status_message=f"{type(exc).__name__}: {exc}"[:500])
            raise
        finally:
            if obs is not None:
                _safe(obs.end)

    def _event(self, name: str, detail: str) -> None:
        if self._root is None:
            return
        event = _safe(self._root.start_observation, name=name, as_type="event", input=lf.text(detail))
        if event is not None:
            _safe(event.end)

    def _finish_langfuse(self) -> None:
        root, self._root = self._root, None
        if root is None:
            return
        safe_only = settings.langfuse_mask_text
        sections = {k: v for k, v in self.sections.items() if not safe_only or k in _SAFE_SECTIONS}
        metadata = {"stages_ms": {name: round(took) for name, took in self.stages},
                    "marks_ms": {name: round(at) for name, at in self.marks.items()},
                    "outcome": self.outcome, "sections": sections}
        verdict = verdict_of(self.outcome) or ("fail" if self.error else "")
        name = f"{verdict.upper()} · {self.outcome or 'error'}" if verdict else "notebook-chat"
        if verdict:
            self.tag(f"verdict:{verdict}")
        update: dict[str, Any] = {"name": name, "output": lf.text(self.output), "metadata": metadata,
                                  "status_message": (self.error or OUTCOMES.get(self.outcome, ""))[:500]}
        if verdict == "fail":
            update["level"] = "ERROR"
        elif verdict == "review":
            update["level"] = "WARNING"
        _safe(root.update, **update)
        _safe(root._otel_span.set_attribute, "langfuse.trace.name", name)
        if self.tags:
            _safe(root._otel_span.set_attribute, "langfuse.trace.tags", list(self.tags))
        _safe(root.end)
        if verdict:
            lf.score(self.trace_id, "verdict", verdict, data_type="CATEGORICAL",
                     comment=OUTCOMES.get(self.outcome, self.error)[:500] or None, score_id=f"{self.trace_id}-verdict")

    # Recording

    @contextmanager
    def stage(self, name: str):
        """A timed stage of the message: a line in the log's TIMING row, and a span in Langfuse."""
        start = time.perf_counter()
        try:
            with self.observe(name) as obs:
                yield obs
        finally:
            self.stages.append((name, (time.perf_counter() - start) * 1000))

    def mark(self, name: str) -> None:
        """A moment on the clock, in ms since the message arrived (e.g. when the answer was sent). In Langfuse it is an
        event, so the tree shows when the first words and the full answer reached the writer."""
        self.marks[name] = (time.perf_counter() - self.t0) * 1000
        label = {"first-delta": "first answer text sent", "answer": "answer sent"}.get(name, name)
        self._event(f"{label} ({ms(self.marks[name])})", name)

    def begin(self, name: str):
        """A stage that cannot be a `with` block (it spans code that yields): call the returned function to end it."""
        start = time.perf_counter()
        obs = _safe(self._root.start_observation, name=name, as_type="span") if self._root else None

        def end() -> None:
            self.stages.append((name, (time.perf_counter() - start) * 1000))
            if obs is not None:
                _safe(obs.end)
        return end

    def add(self, section: str, *lines: str) -> None:
        self.sections.setdefault(section, []).extend(lines)

    def start_agent(self) -> None:
        self.agent_started = time.perf_counter()

    def step(self, kind: str, detail: str) -> None:
        offset = (time.perf_counter() - (self.agent_started or self.t0)) * 1000
        source = STEP_SOURCE.get(kind, "")
        self.add("steps", f"+{ms(offset):>6}  {kind:<6} {detail}" + (f"   [{source}]" if source else ""))
        self._event(f"step:{kind}", detail)

    # Output

    def render(self) -> str:
        total = (time.perf_counter() - self.t0) * 1000
        answered = self.marks.get("answer")
        head = f"CHAT TRACE  chat={self.chat_id[:8] or '-'}  notebook={self.notebook!r}"
        shown = f"  {self.message[:140]!r}" if text_enabled() else ""
        lines = [head, f"  message : {len(self.message)} chars{shown}"]
        if self.outcome:
            lines.append(f"  outcome : {self.outcome} ({OUTCOMES.get(self.outcome, '?')})"
                         + (f"  langfuse trace {self.trace_id}" if self.trace_id else ""))
        first = self.marks.get("first-delta")
        if answered is not None:
            lines.append("  clock   : " + (f"first answer text after {ms(first)}, " if first is not None else "")
                         + f"answer sent after {ms(answered)}, stream closed after {ms(total)}")
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
        self._finish_langfuse()


# research() runs in a worker thread (asyncio.to_thread copies the context), so the request hands its trace over
# this way instead of through research()'s arguments.
_current: ContextVar["ChatTrace | None"] = ContextVar("chat_trace", default=None)


def use_trace(trace: "ChatTrace") -> None:
    _current.set(trace)


def current_trace() -> "ChatTrace | None":
    return _current.get()


def probs_text(probabilities: dict[str, float], limit: int | None = None) -> str:
    ordered = sorted(probabilities.items(), key=lambda kv: kv[1], reverse=True)
    top = ordered[:limit] if limit is not None else ordered
    return "  ".join(f"{name} {p:.2f}" for name, p in top)


def value_shape(value) -> str:
    """Log the shape and size of tool data without logging private argument or result values."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return f"string[{len(value)} chars]"
    if isinstance(value, bytes):
        return f"bytes[{len(value)}]"
    if isinstance(value, list | tuple):
        kinds = list(dict.fromkeys(value_shape(item).split("[", 1)[0] for item in value))
        return f"list[{len(value)}]" + (f"<{','.join(kinds)}>" if kinds else "")
    if isinstance(value, dict):
        return "object{" + ",".join(f"{key}:{value_shape(child)}" for key, child in value.items()) + "}"
    return type(value).__name__


def arguments_shape(arguments: dict | None) -> str:
    return value_shape(arguments or {})

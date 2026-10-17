"""The chat answer, streamed. Research (list/search/read) gathers the evidence; this one call writes the answer from it
and sends the text to the writer as it is generated, instead of all at once at the end.

dspy's own answer step is a single non-streaming call through the JSONAdapter, so it cannot do this: streaming it
would show JSON-escaped text, and the LM cache skips streaming on a hit. So the answer step is a plain LiteLLM call
with a simple contract: a COVERED line, the Markdown answer, then a sentinel line, then one JSON object with the
citations. Only the answer reaches the client. The final, verified answer still replaces the draft at the end.

The COVERED line comes first so a one-call path (fast path, overview, rewrite) can stop as soon as the model says the
passages do not answer the question: nothing is shown and then taken back, and the research agent starts seconds
sooner."""

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field

import litellm

from app.llm.postprocess import strip_em_dashes
from app.llm.provider import writer_lm
from app.llm.signatures import ANSWER_INSTRUCTIONS, ANSWER_LENGTHS, FileCitation

log = logging.getLogger(__name__)

SENTINEL = "<<<CITATIONS>>>"
# Output caps per answer length. GLM's reasoning counts against max_tokens, so these leave it room; they guard
# against a runaway answer, the length instruction is what keeps answers short. None = the model's own cap.
WRITER_MAX_TOKENS: dict[str, int | None] = {"brief": 3000, "standard": 5000, "in_depth": None}

WRITER_SYSTEM = f"""You write the answer for a research assistant inside a writer's archive of markdown posts.
The research is done: the trajectory holds what was found, with file paths and line numbers. Answer the question ONLY
from text in the trajectory (or in the earlier-chat notes, when given). Every factual sentence needs a [n] marker, and
every marker needs a citation with the file path and the line range it came from. If the trajectory does not cover
the question, say so plainly and set unsupported to true.
Name each post you draw on. Use the conversation to resolve short follow ups such as "why" or "say more". Treat the
writer notes as guidance on tone and focus, never as evidence, and never cite them.

{ANSWER_INSTRUCTIONS}

Output format, exactly:
1. A first line that is exactly "COVERED: yes" when the material above holds the answer, or "COVERED: no" when it
   does not.
2. The Markdown answer with its [n] markers (for COVERED: no, one plain sentence saying the archive does not cover
   it). No list of sources, references or file paths at the end: the app shows the cited passages itself, from the
   JSON below.
3. A line containing only {SENTINEL}
4. One JSON object, nothing after it:
{{"citations": [{{"marker": 1, "path": "sources/site/2024-01-01-slug.md", "line_start": 12, "line_end": 18}}],
 "unsupported": false, "topic": "BlogHub's featured listings"}}
"topic" names the subject of the answer in 2 to 6 words, to fill "Study ... with flashcards", "Quiz yourself on ..."
and "Turn ... into a slide deck". It is a noun phrase, never a question or a clause: "BlogHub", not "what BlogHub is";
"links on Substack Notes", not "why links underperform on Notes"; "the Hook & Eye method", "your pricing posts".
Lowercase except names. Use "" when the archive does not cover the question."""

_INPUT_TITLES = (("question", "Question"), ("answer_length", "Answer length"), ("conversation", "Conversation"),
                 ("writer_profile", "Writer notes"), ("chat_memory", "Notes from earlier in this chat"),
                 ("prefetched", "Passages a keyword search found (citable, with line numbers)"))


_COVERED = re.compile(r"^\s*\**COVERED:?\**\s*(yes|no)\b[^\n]*(\n|$)", re.IGNORECASE)
HEADER_WAIT_CHARS = 40  # without a line break by then, the model skipped the COVERED line: the text is the answer


class WriterError(RuntimeError):
    pass


class WriterUncovered(WriterError):
    """The model's first line said the material does not answer the question."""


@dataclass
class WriterResult:
    answer: str
    citations: list[FileCitation]
    unsupported: bool
    prompt_tokens: int = 0
    completion_tokens: int = 0
    chunks: int = 0
    topic: str = ""  # what the answer is about, in a few words: the app names its next-step suggestions after it
    extra: dict = field(default_factory=dict)


class SentinelFilter:
    """Reads the COVERED line first, then passes text through until the sentinel and keeps everything after it. The last
    len(SENTINEL) - 1 characters are always held back, so a sentinel split across chunks never leaks to the client.
    With stop_if_uncovered, "COVERED: no" raises WriterUncovered before any text is sent."""

    def __init__(self, emit: Callable[[str], None], stop_if_uncovered: bool = False):
        self.emit = emit
        self.stop_if_uncovered = stop_if_uncovered
        self.head = ""
        self.header_done = False
        self.covered: bool | None = None  # None: the model wrote no COVERED line
        self.buf = ""
        self.body = ""
        self.tail = ""
        self.done = False
        self.emitted = 0

    def _end_header(self) -> str:
        """The text after the COVERED line (or all of it, when there is none)."""
        self.header_done = True
        head, self.head = self.head, ""
        m = _COVERED.match(head)
        if not m:
            return head
        self.covered = m.group(1).lower() == "yes"
        if not self.covered and self.stop_if_uncovered:
            raise WriterUncovered("the model says the material does not answer the question (stopped at its first line)")
        return head[m.end():].lstrip("\n")

    def _send(self, text: str) -> None:
        if not text:
            return
        self.body += text
        self.emitted += 1
        self.emit(strip_em_dashes(text))

    def feed(self, text: str) -> None:
        if not self.header_done:
            self.head += text
            if "\n" not in self.head and len(self.head) < HEADER_WAIT_CHARS:
                return
            text = self._end_header()
        if self.done:
            self.tail += text
            return
        self.buf += text
        at = self.buf.find(SENTINEL)
        if at >= 0:
            self._send(self.buf[:at])
            self.tail, self.buf, self.done = self.buf[at + len(SENTINEL):], "", True
            return
        safe = len(self.buf) - (len(SENTINEL) - 1)
        if safe > 0:
            self._send(self.buf[:safe])
            self.buf = self.buf[safe:]

    def close(self) -> None:
        if not self.header_done:
            rest = self._end_header()
            self.header_done, self.head = True, ""
            if rest:
                self.feed(rest)
        if not self.done:
            raise WriterError("the answer ended without the citations line")


def parse_tail(tail: str) -> tuple[list[FileCitation], bool, str]:
    """The JSON after the sentinel. Code fences and stray text around the object are tolerated."""
    start, end = tail.find("{"), tail.rfind("}")
    if start < 0 or end < start:
        raise WriterError("no citations object after the sentinel")
    try:
        data = json.loads(tail[start:end + 1])
        cites = [FileCitation.model_validate(c) for c in data.get("citations") or []]
    except (ValueError, TypeError) as exc:
        raise WriterError(f"unreadable citations: {exc}") from exc
    topic = data.get("topic") if isinstance(data.get("topic"), str) else ""
    return cites, bool(data.get("unsupported", False)), clean_topic(topic)


TOPIC_MAX_CHARS = 48


def clean_topic(topic: str) -> str:
    """A short phrase that fits inside a button label: one line, no end punctuation, cut at a word when too long."""
    topic = strip_em_dashes(" ".join(topic.split())).strip(" .,:;!?\"'")
    if len(topic) > TOPIC_MAX_CHARS:
        topic = topic[:TOPIC_MAX_CHARS].rsplit(" ", 1)[0]
    return topic


def user_prompt(inputs: dict, evidence: str) -> str:
    parts = [f"## {title}\n{inputs[key]}" for key, title in _INPUT_TITLES if inputs.get(key)]
    parts.append(f"## Research trajectory (what was found)\n{evidence}")
    return "\n\n".join(parts)


def _completion(**kwargs):  # one seam for tests
    return litellm.completion(**kwargs)


def stream_answer(inputs: dict, evidence: str, on_delta: Callable[[str], None],
                  answer_length: str = "standard", stop_if_uncovered: bool = False) -> WriterResult:
    """Write the answer from `evidence`, sending text to on_delta as it arrives. Raises WriterError when the reply does
    not follow the contract (WriterUncovered when stop_if_uncovered and the model says the material does not answer
    it), and LiteLLM's errors (ContextWindowExceededError included) as they are."""
    lm = writer_lm()
    kwargs = dict(lm.kwargs)
    cap = WRITER_MAX_TOKENS.get(answer_length if answer_length in ANSWER_LENGTHS else "standard")
    if cap:
        key = "max_completion_tokens" if "max_completion_tokens" in kwargs else "max_tokens"
        kwargs[key] = min(cap, kwargs.get(key) or cap)
    messages = [{"role": "system", "content": WRITER_SYSTEM},
                {"role": "user", "content": user_prompt({**inputs, "answer_length": answer_length}, evidence)}]
    out = SentinelFilter(on_delta, stop_if_uncovered)
    prompt_tokens = completion_tokens = 0
    finish = None
    for chunk in _completion(model=lm.model, messages=messages, stream=True,
                             stream_options={"include_usage": True}, **kwargs):
        usage = getattr(chunk, "usage", None)
        if usage:
            prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
            completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
        choices = getattr(chunk, "choices", None) or []
        if not choices:
            continue
        finish = getattr(choices[0], "finish_reason", None) or finish
        text = getattr(choices[0].delta, "content", None)  # GLM's reasoning_content is never shown
        if text:
            out.feed(text)
    if not out.done and finish == "length":
        raise WriterError(f"the answer hit the {kwargs.get('max_tokens')} token cap before its citations")
    out.close()
    cites, unsupported, topic = parse_tail(out.tail)
    answer = re.sub(r"\s+$", "", out.body)
    return WriterResult(answer, cites, unsupported, prompt_tokens, completion_tokens, out.emitted, topic=topic)

"""Agentic research over the file system corpus: the model explores files with list/search/read,
then every citation is checked against the real file before it reaches the writer.

Cost control: every message is triaged first. Greetings and thanks are answered from a phrase list
(no model call). Everything else gets one cheap call on the fast model that reads the recent
conversation, answers off topic and app questions directly, and turns follow ups into standalone
questions. Only real archive questions run the research agent, with a small step budget for simple
lookups and the full budget for synthesis."""

import logging
import random
import re
from collections.abc import Callable
from dataclasses import dataclass, field

import dspy
from dspy.utils.exceptions import AdapterParseError

from app.chat_memory.context import (
    JEV_MEMORY,
    JEV_MEMORY_QUESTION,
    MEMORY_LEVELS,
    ChatMemory,
    build_context,
    context_banner,
    memory_decision,
    topic_question,
    topics_digest,
)
from app.chat_memory.files import SMALL_TALK
from app.chat_memory.logs import context_log, text_enabled
from app.chat_memory.tools import ChatTools, is_chat_path
from app.config import settings
from app.corpus import Corpus, ScopedTools
from app.llm.postprocess import strip_em_dashes
from app.llm.provider import main_lm, track_usage, triage_lm
from app.llm.signatures import ResearchArchive, ResearchArchiveWithMemory, TriageMessage, TriageWithMemory
from app.pipeline.trace import MEMORY_GIVES, ChatTrace, current_trace, probs_text
from app.services import jev

_MARKER = re.compile(r"\[(\d+)\]")
log = logging.getLogger(__name__)


@dataclass
class VerifiedCitation:
    marker: int
    path: str
    line_start: int
    line_end: int
    quote: str


def _route_info(route: "Triage") -> dict:
    """What triage decided, in plain values: the first thing to look at when an answer forgot or mixed up a chat."""
    return {"kind": route.kind, "depth": route.depth, "topic": route.topic, "memory": route.memory,
            "standalone_question": route.question}


@dataclass
class ResearchResult:
    text: str
    unsupported: bool
    citations: list[VerifiedCitation]
    prompt_tokens: int = 0
    completion_tokens: int = 0
    steps: list[tuple[str, str]] = field(default_factory=list)
    kind: str = "archive"  # archive | chitchat | about_app | off_topic
    question: str = ""  # the standalone question that was researched
    recall: dict = field(default_factory=dict)  # how recall behaved for this answer (saved with the message)


@dataclass
class Turn:
    role: str  # user | assistant
    text: str


HISTORY_TURNS = 8
HISTORY_CHARS = 700  # per older message: half from the start, half from the end
RECENT_TURNS = 2  # the newest messages (the last question and answer) are kept whole, up to RECENT_CHARS
RECENT_CHARS = 4000  # safety ceiling for those, the same as the longest question a writer can send
QUICK_STEPS = 4
MAX_AGENT_TOOLS = 6  # seen live: with a seventh tool the model returns {} instead of its next step

_CHITCHAT = SMALL_TALK  # greetings and thanks: the same pattern chat memory uses to decide what may be skipped
_GREETING = re.compile(r"^\s*(hi|hey|hello|yo|hiya|good (morning|afternoon|evening))", re.IGNORECASE)
_BYE = re.compile(r"^\s*(bye|goodbye|see you)", re.IGNORECASE)


def shorten(text: str, limit: int = HISTORY_CHARS) -> str:
    """A long message keeps its start and its end and drops the middle: the opening usually states the point
    and the ending holds the conclusion or the question that follow ups refer to."""
    if len(text) <= limit:
        return text
    half = limit // 2
    head, tail = text[:half], text[-half:]
    head = head.rsplit(" ", 1)[0] if " " in head else head  # cut on word boundaries
    tail = tail.split(" ", 1)[1] if " " in tail else tail
    return f"{head.rstrip()} ... {tail.lstrip()}"


def conversation_text(history: list[Turn], limit: int = HISTORY_TURNS) -> str:
    """Last few turns, citation markers stripped, so the prompt stays small. The newest two messages stay whole
    because a follow up like "make it shorter" only makes sense against their exact words; older ones are shortened."""
    if not history:
        return "(new conversation)"
    lines = []
    recent_from = len(history) - RECENT_TURNS
    for i, t in enumerate(history):
        if i < len(history) - limit:
            continue
        text = _MARKER.sub("", t.text).strip()
        text = shorten(text, RECENT_CHARS if i >= recent_from else HISTORY_CHARS)
        lines.append(f"{'Writer' if t.role == 'user' else 'Assistant'}: {text}")
    return "\n".join(lines)


def instant_reply(message: str, history: list[Turn]) -> str | None:
    """Canned replies for pure small talk: no model call at all."""
    if not _CHITCHAT.match(message):
        return None
    if _BYE.match(message):
        return "Clear skies. Your archive will be here when you come back."
    if _GREETING.match(message):
        return ("Hi! Ask me anything about the posts in this notebook, for example what you have written "
                "about pricing, or how your view on something changed over time.")
    if history:
        return "Glad that helped. Want to dig further into any of those posts?"
    return "Ask me anything about the posts in this notebook and I will answer with citations."


@dataclass
class Triage:
    kind: str
    question: str
    depth: str
    reply: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    topic: str = ""  # the slug of the chat topic the message belongs to, "" when none
    memory: str = "none"  # none | lookup | replay | compose
    # For the log and for recall_json: who decided, what Jev answered before our thresholds, and what they changed.
    engine: str = ""
    jev: dict = field(default_factory=dict)  # question id -> {"choice", "confidence", "probabilities"}
    notes: list[str] = field(default_factory=list)


JEV_INTENT = {
    "archive": {
        "what": "Needs facts, ideas, quotes, opinions or history from the writer's own posts, including follow "
                "ups to the conversation like 'say more', 'why?', 'what about last year?'",
        "examples": ["What have I written about pricing?", "Summarize my take on AI", "Tell me more about that"],
    },
    "chitchat": {
        "what": "Greetings, thanks, reactions or small talk with no question about the posts",
        "examples": ["hello there", "that was helpful, thanks", "you are great"],
    },
    "about_app": {
        "what": "How to use Notestack itself: sources, notebooks, audio, video, launch kits, settings",
        "examples": ["How do I add another Substack?", "Can you make a podcast from this?"],
    },
    "off_topic": {
        "what": "General knowledge, coding, math, news, homework or tasks unrelated to the writer's posts",
        "not_for": "Questions about what the writer wrote, even if the subject is general",
        "examples": ["What is the capital of France?", "Write me a Python script", "Who won the game last night?"],
    },
}
JEV_DEPTH = {
    "quick": "A single fact, quote or lookup in one or two posts",
    "deep": "Synthesis, comparison or change over time across many posts",
}
JEV_MIN_CONFIDENCE = 0.55  # below this, research anyway: a wasted search beats a wrong brush off


def canned_reply(kind: str, allowed: dict[str, str]) -> str:
    """Templated replies for messages that need no research (no model call)."""
    titles = [t for t in allowed.values() if t]
    sample = random.choice(titles) if titles else None
    try_this = f' For example: "What is the main argument in {sample}?"' if sample else ""
    if kind == "about_app":
        return ("Add more Substacks, blogs or files on the Sources page, then group posts into notebooks. From "
                "any notebook, the Studio panel on the right makes summaries, audio overviews, videos and quote "
                "cards, and Launch Kit and Launchpad turn a post into scheduled social posts. In this chat I "
                "answer questions about the posts in this notebook." + try_this)
    if kind == "off_topic":
        return ("I only answer from the posts in this notebook, so I cannot help with that one. Ask me about "
                "something you have written instead." + try_this)
    return "Happy to help. Ask me anything about the posts in this notebook." + try_this


def triage_with_jev(message: str, history: list[Turn], notebook: str, mem: ChatMemory | None = None) -> Triage:
    state = {"notebook": notebook, "conversation": conversation_text(history, limit=4), "message": message}
    questions = {
        "intent": {"instructions": "What does the latest message need from a research assistant that only "
                                   "knows this writer's posts?", "criteria": JEV_INTENT},
        "depth": {"instructions": "If it is about the posts, how much research does it need?",
                  "criteria": JEV_DEPTH},
    }
    if mem is not None:  # two more choices in the same request
        state["topics"] = topics_digest(mem.tf)
        questions["memory"] = {"instructions": JEV_MEMORY_QUESTION, "criteria": JEV_MEMORY}
        topic_q = topic_question(mem.tf)
        if topic_q:
            questions["topic"] = topic_q
    answers = jev.decide(state, questions)
    intent, depth = answers["intent"], answers["depth"]
    raw = {qid: {"choice": a.choice, "confidence": round(a.confidence, 2),
                 "probabilities": {k: round(v, 2) for k, v in a.probabilities.items()}} for qid, a in answers.items()}
    notes: list[str] = []
    kind = intent.choice if intent.choice in JEV_INTENT else "archive"
    if kind != intent.choice:
        notes.append(f"intent {intent.choice!r} is not one of our options -> archive")
    if kind != "archive" and intent.confidence < JEV_MIN_CONFIDENCE:
        notes.append(f"intent {kind!r} confidence {intent.confidence:.2f} < {JEV_MIN_CONFIDENCE} -> archive "
                     "(a wasted search beats a wrong brush off)")
        kind = "archive"
    topic, memory = "", "none"
    if kind == "archive" and mem is not None:
        asked = answers["memory"]
        memory = asked.choice if asked.choice in MEMORY_LEVELS else "none"
        if memory != asked.choice:
            notes.append(f"memory {asked.choice!r} is not one of our options -> none")
        if asked.confidence < JEV_MIN_CONFIDENCE:
            memory = "lookup" if mem.latest() else "none"  # a wasted lookup costs less than a wrong answer
            notes.append(f"memory {asked.choice!r} confidence {asked.confidence:.2f} < {JEV_MIN_CONFIDENCE} "
                         f"-> {memory}")
        picked = answers.get("topic")
        if picked and picked.confidence >= JEV_MIN_CONFIDENCE and picked.choice in mem.tf.slugs:
            topic = picked.choice
        elif picked and picked.choice != "none":
            why = ("unknown topic" if picked.choice not in mem.tf.slugs
                   else f"confidence {picked.confidence:.2f} < {JEV_MIN_CONFIDENCE}")
            notes.append(f"topic {picked.choice!r}: {why} -> no topic (the chat's latest topic is used instead)")
    elif mem is not None:
        notes.append(f"kind is {kind}, so the memory and topic answers are not used")
    # Jev does not write text: the research agent resolves follow ups using the conversation it is given.
    return Triage(kind, message, depth.choice if depth.choice in JEV_DEPTH else "deep", "", topic=topic, memory=memory,
                  engine="jev", jev=raw, notes=notes)


def triage(message: str, history: list[Turn], notebook: str, mem: ChatMemory | None = None) -> Triage:
    """Decide whether a message is worth researching. Jev when configured (fast, typed, no generation),
    otherwise one cheap call on the triage LLM."""
    why = "Jev is not configured (no TYPESAFE_API_KEY)"
    if jev.configured():
        try:
            return triage_with_jev(message, history, notebook, mem)
        except jev.JevError as exc:
            log.warning("Jev triage failed, falling back to the LLM", exc_info=True)
            why = f"Jev failed: {exc}"
    route = triage_llm(message, history, notebook, mem)
    route.engine = f"llm triage ({why})"
    return route


def triage_llm(message: str, history: list[Turn], notebook: str, mem: ChatMemory | None = None) -> Triage:
    """One cheap LLM call: is this worth researching, and what exactly should be researched?"""
    lm = triage_lm()
    try:
        with track_usage(lm) as usage, dspy.context(lm=lm):
            if mem is not None:
                pred = dspy.Predict(TriageWithMemory)(conversation=conversation_text(history), message=message,
                                                      notebook=notebook, topics=topics_digest(mem.tf))
            else:
                pred = dspy.Predict(TriageMessage)(conversation=conversation_text(history), message=message,
                                                   notebook=notebook)
    except Exception as exc:
        # If triage fails, fall back to researching the raw message rather than failing the chat.
        log.warning("LLM triage failed, researching the raw message", exc_info=True)
        return Triage("archive", message, "deep", "",
                      notes=[f"triage model failed ({type(exc).__name__}) -> archive, deep"])
    notes: list[str] = []
    kind = pred.kind if pred.kind in {"archive", "chitchat", "about_app", "off_topic"} else "archive"
    question = (pred.standalone_question or "").strip() or message
    reply = strip_em_dashes((pred.reply or "").strip())
    if kind != "archive" and not reply:
        notes.append(f"model said {kind} but wrote no reply -> archive")
        kind = "archive"  # nothing to say without research: research it
    topic, memory = "", "none"
    if mem is not None and kind == "archive":
        memory = pred.memory if pred.memory in MEMORY_LEVELS else "none"
        topic = (pred.topic or "").strip() if (pred.topic or "").strip() in mem.tf.slugs else ""
    return Triage(kind, question, pred.depth if pred.depth in {"quick", "deep"} else "deep", reply,
                  usage.prompt_tokens, usage.completion_tokens, topic=topic, memory=memory, notes=notes)


def notebook_brief(title: str, allowed: dict[str, str]) -> str:
    titles = list(allowed.values())[:25]
    return f"Notebook: {title}. {len(allowed)} posts, including: " + "; ".join(titles)


def archive_guide(tools: ScopedTools) -> str:
    return (
        f"This notebook has {len(tools.allowed)} posts stored as markdown files under sources/. "
        "Each file starts with front matter (title, url, published date), then '# Title' and '## Section' "
        "headings. Paths look like sources/<site>/<yyyy-mm-dd>-<slug>.md. "
        "Line numbers from read() and search() are what you cite."
    )


def verify_citations(tools: ScopedTools, answer: str, citations,
                     chat_tools: ChatTools | None = None) -> tuple[str, list[VerifiedCitation]]:
    """Keep only citations that point at real lines, renumber them 1..n, and drop dangling markers. A path starting
    with chats/ is checked against the notebook's chat memory, anything else against the posts."""
    verified: list[VerifiedCitation] = []
    remap: dict[int, int] = {}
    for c in sorted(citations, key=lambda c: c.marker):
        if c.marker in remap:
            continue
        if is_chat_path(c.path):
            quote = chat_tools.quote(c.path, c.line_start, c.line_end) if chat_tools else None
        else:
            quote = tools.quote(c.path, c.line_start, c.line_end)
        if not quote:
            continue
        new = len(verified) + 1
        remap[c.marker] = new
        end = max(c.line_start, min(c.line_end, c.line_start + 40))
        verified.append(VerifiedCitation(new, c.path, c.line_start, end, quote[:600]))

    def swap(m: re.Match) -> str:
        n = remap.get(int(m.group(1)))
        return f"[{n}]" if n else ""

    text = _MARKER.sub(swap, answer)
    text = re.sub(r"[ \t]+([.,;:!?])", r"\1", text)  # keep line breaks: answers are Markdown
    return ensure_markers(text.strip(), verified), verified


_WORD = re.compile(r"[a-z0-9][a-z0-9'-]{3,}")
_STOP = {"that", "this", "with", "from", "have", "your", "they", "them", "then", "than", "into", "when", "what",
         "which", "their", "there", "about", "would", "could", "should", "also", "each", "only", "just", "more",
         "some", "such", "like", "does", "were", "been", "being", "will", "post", "posts", "based"}


def _words(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP}


def ensure_markers(text: str, cites: list[VerifiedCitation]) -> str:
    """Every verified citation is shown in the answer as a [n] marker. The model sometimes writes none, or writes
    numbers that do not match its citations and the verifier drops them. Whatever is missing is put back on the
    sentence or list item whose words overlap the cited lines most, so the text and the list always agree."""
    if not cites or not text:
        return text
    present = {int(n) for n in _MARKER.findall(text)}
    missing = [c for c in cites if c.marker not in present]
    if not missing:
        return text
    lines = text.split("\n")
    units: list[int] = []  # indexes of lines that are prose or list items: the places a marker can go
    in_code = False
    for i, line in enumerate(lines):
        t = line.strip()
        if t.startswith("```"):
            in_code = not in_code
            continue
        if in_code or len(t) < 25 or t.startswith(("#", "|", ">", "![")):
            continue
        units.append(i)
    if not units:
        lines[-1] = lines[-1].rstrip() + " " + "".join(f"[{c.marker}]" for c in missing)
        return "\n".join(lines)
    unit_words = {i: _words(lines[i]) for i in units}
    add: dict[int, list[int]] = {}

    def best(c: VerifiedCitation, only_unmarked: bool) -> int | None:
        qw = _words(c.quote)
        pool = [i for i in units if not (only_unmarked and (_MARKER.search(lines[i]) or i in add))]
        scored = [(len(unit_words[i] & qw) / (1 + len(unit_words[i]) ** 0.5), i) for i in pool]
        scored = [x for x in scored if x[0] > 0]
        return max(scored)[1] if scored else None

    # With no markers at all, give each citation a line of its own first, so they spread across the answer.
    for c in missing:
        i = best(c, only_unmarked=not present)
        if i is not None:
            add.setdefault(i, []).append(c.marker)
    # Anything that shares no words with the answer still has to show: put it on the last prose line.
    placed = {m for ms in add.values() for m in ms}
    for c in missing:
        if c.marker not in placed:
            add.setdefault(units[-1], []).append(c.marker)
    for i, ms in add.items():
        line = lines[i].rstrip()
        lines[i] = line + " " + "".join(f"[{m}]" for m in sorted(set(ms)))
    return "\n".join(lines)


CONTEXT_LOG_SECTION_CHARS = 4000


def context_log_enabled() -> bool:
    return text_enabled()


def _section(title: str, text: str) -> str:
    text = (text or "").strip() or "(empty)"
    hidden = len(text) - CONTEXT_LOG_SECTION_CHARS
    note = f"  [+{hidden} more characters not shown]" if hidden > 0 else ""
    return f"--- {title} ({len(text)} chars) ---\n{text[:CONTEXT_LOG_SECTION_CHARS]}{note}"


def describe_context(question: str, route: Triage, inputs: dict, signature, tool_names: list[str],
                     chat_memory: ChatMemory | None, with_chat_tools: bool = False) -> str:
    """Everything the research agent is given for one message, as readable text for the server log."""
    parts = [
        "=== CHAT CONTEXT: what the research agent is given ===",
        f"message from the writer: {question!r}",
        f"triage: kind={route.kind} depth={route.depth} topic={route.topic or '-'} memory={route.memory}",
        f"question given to the agent: {inputs['question']!r}",
        f"agent signature: {signature.__name__} | tools: {', '.join(tool_names)}",
        _section("conversation (last turns, citation markers removed)", inputs["conversation"]),
        _section("writer notes (standing profile)", inputs["writer_profile"]),
        "--- chat memory: what was decided and where it came from ---",
        memory_decision(chat_memory, route.topic, route.memory, inputs.get("chat_memory", ""), with_chat_tools),
    ]
    if chat_memory is not None:
        parts.append(_section("topics of this chat (what triage chose from)", topics_digest(chat_memory.tf)))
    parts.append(_section("chat memory notes (summary, exact words, recent messages)",
                          inputs.get("chat_memory", "(none loaded for this message)")))
    return "\n".join(parts)


RETRY_TEMPERATURE = 0.9  # a different request from the failed one, so the LM cache cannot return the same bad reply
FAILED_REPLY = "I had trouble reading your posts just now. Please send that again."


def _retry_malformed_steps(agent, trace: ChatTrace):
    """dspy's ReAct needs every model reply to be JSON with next_thought, next_tool_name and next_tool_args. The model
    sometimes sends only the tool's arguments, which raises AdapterParseError and used to fail the whole message.
    Here the failing step is asked once more (a new request, not the cached one). If it fails again, a ValueError
    tells ReAct to stop researching and write the answer from what it has found so far.

    Hooks ReAct's `_call_with_potential_trajectory_truncation` (dspy 2.6.*, pinned in requirements.txt). Without it the
    agent is returned unchanged."""
    original = getattr(agent, "_call_with_potential_trajectory_truncation", None)
    if original is None:
        return agent

    def call(module, trajectory, **inputs):
        try:
            return original(module, trajectory, **inputs)
        except AdapterParseError as first:
            reply = " ".join(str(first.lm_response).split())[:160]
            log.warning("Malformed model reply, asking once more: %s", reply)
            trace.add("steps", f"! the model's reply was not in the expected shape: {reply!r}  ->  asking again once")
            try:
                return original(module, trajectory, **inputs, config={"temperature": RETRY_TEMPERATURE})
            except AdapterParseError as second:
                if module is agent.react:
                    trace.add("steps", "! still malformed: research stops here and the answer is written from "
                                       "what was found so far")
                    raise ValueError("the model could not produce a valid next step") from second
                raise

    agent._call_with_potential_trajectory_truncation = call
    return agent


def _triage_detail(route: Triage) -> dict:
    """Who triaged, what Jev answered before our thresholds, and what the thresholds changed. Saved with the message."""
    return {"engine": route.engine, "jev": route.jev, "notes": route.notes}


def _trace_triage(trace: ChatTrace, route: Triage) -> None:
    """The triage section of the log: every Jev answer with its confidence, then what our thresholds did to it."""
    trace.add("triage", f"engine   : {route.engine or 'unknown'}")
    if route.jev:
        for qid in ("intent", "depth", "memory", "topic"):
            a = route.jev.get(qid)
            if a:
                trace.add("triage", f"{qid:<9}: {a['choice']:<22} confidence {a['confidence']:.2f}   "
                                    f"[{probs_text(a['probabilities'])}]")
    else:
        trace.add("triage", "(a language model answered, so there are no probabilities or confidences)")
    trace.add("triage", "overrides: " + ("; ".join(route.notes) if route.notes
                                         else "none, the answers were used as given"))
    trace.add("triage", f"FINAL    : kind={route.kind} depth={route.depth} memory={route.memory} "
                        f"topic={route.topic or '-'}")
    if route.kind == "archive":
        trace.add("triage", f"memory={route.memory} means: {MEMORY_GIVES.get(route.memory, '?')}")


def _memory_parts(notes: str) -> str:
    """Which pieces ended up in the chat memory block, read from the block's own headings."""
    parts = [label for marker, label in (
        ("Summary [", "topic summary (R2)"), ("Exact words kept", "saved exact quotes (R2)"),
        ("Latest messages in this topic", "last messages word for word (Postgres)"),
        ("Messages not yet filed", "unfiled messages (Postgres)"),
        ("Earlier conversations in this notebook", "notebook topic index (R2)")) if marker in notes]
    return ", ".join(parts) or "empty"


def research(
    corpus: Corpus,
    allowed: dict[str, str],
    question: str,
    on_step: Callable[[str, str], None] | None = None,
    history: list[Turn] | None = None,
    notebook_title: str = "",
    profile: str = "",
    chat_memory: ChatMemory | None = None,
    trace: ChatTrace | None = None,
) -> ResearchResult:
    history = history or []
    trace = trace or current_trace() or ChatTrace()  # a throwaway one when research() is called on its own
    if not allowed:
        trace.add("route", "NO POSTS: the notebook has none, so a fixed reply was sent and no model was called")
        return ResearchResult("This notebook has no posts yet. Add some sources first.", True, [], kind="chitchat")

    canned = instant_reply(question, history)
    if canned:
        trace.add("route", "SMALL TALK: the message is only a greeting or thanks (regex), so a fixed reply was sent "
                           "and no model, Jev call or R2 read was needed")
        if context_log_enabled():
            context_log.info("=== CHAT CONTEXT === message %r is small talk: canned reply, no model call", question)
        return ResearchResult(canned, False, [], kind="chitchat", question=question)

    if on_step:
        on_step("think", "Reading the conversation")
    with trace.stage("triage"):
        route = triage(question, history, notebook_brief(notebook_title, allowed), chat_memory)
    _trace_triage(trace, route)
    if route.kind != "archive":
        # App help is always the vetted template: a model would invent product facts.
        if context_log_enabled():
            context_log.info("=== CHAT CONTEXT === message %r triaged as %s: answered without the research agent",
                             question, route.kind)
        reply = canned_reply(route.kind, allowed) if route.kind == "about_app" or not route.reply else route.reply
        source = "a fixed template" if route.kind == "about_app" or not route.reply else "the triage model's reply"
        trace.add("route", f"{route.kind.upper()}: triage decided this needs no research, so the reply is {source} "
                           "(no research agent, no post reads, no R2 sync)")
        trace.add("result", f"reply {len(reply)} chars | "
                            f"tokens (triage): {route.prompt_tokens}/{route.completion_tokens}")
        return ResearchResult(reply, False, [], route.prompt_tokens, route.completion_tokens,
                              kind=route.kind, question=question,
                              recall={"route": _route_info(route), "triage_detail": _triage_detail(route),
                                      "memory_loaded": chat_memory is not None})

    trace.add("route", "ARCHIVE: the message needs the writer's posts, so the research agent runs")
    with trace.stage("sync-posts"):
        corpus.sync()
    steps: list[tuple[str, str]] = []

    def log(kind: str, detail: str) -> None:
        steps.append((kind, detail))
        trace.step(kind, detail)
        if on_step:
            on_step(kind, detail)

    tools = ScopedTools(corpus, allowed, on_step=log)
    trace.start_agent()  # step offsets in the log count from here
    notes, with_chat_tools = ("", False)
    if chat_memory is not None:
        with trace.stage("build-memory"):
            notes, with_chat_tools = build_context(chat_memory, route.topic, route.memory)
        if notes or with_chat_tools:
            log("think", "Recalling earlier in this chat")
    chat_tools = ChatTools(chat_memory.corpus, on_step=log) if chat_memory is not None and with_chat_tools else None
    budget = min(QUICK_STEPS, settings.research_max_steps) if route.depth == "quick" else settings.research_max_steps
    tool_list = [tools.list_files, tools.search, tools.read]
    if chat_tools:
        tool_list += [chat_tools.list_chat_topics, chat_tools.search_chats, chat_tools.read_chat]
    inputs = dict(question=route.question, conversation=conversation_text(history),
                  archive_guide=archive_guide(tools), writer_profile=profile or "(none)")
    if notes or chat_tools:
        signature, inputs["chat_memory"] = ResearchArchiveWithMemory, notes or "(nothing filed yet)"
    else:
        signature = ResearchArchive
    if context_log_enabled():
        context_log.info(context_banner(chat_memory, route.topic, route.memory, inputs.get("chat_memory", "")))
        context_log.info(describe_context(question, route, inputs, signature, [t.__name__ for t in tool_list],
                                          chat_memory, chat_tools is not None))
    agent = _retry_malformed_steps(dspy.ReAct(signature, tools=tool_list, max_iters=budget), trace)
    lm = main_lm()
    if not settings.chat_memory_read:
        memory_line = "chat memory: OFF (CHAT_MEMORY_READ=false), so only the last messages of this chat are used"
    elif chat_memory is None:
        memory_line = "chat memory: nothing loaded (no topics filed for this chat yet, or loading failed)"
    elif not notes and not chat_tools:
        memory_line = (f"chat memory: loaded ({len(chat_memory.tf.entries)} topic(s)) but memory={route.memory}, "
                       "so nothing was passed")
    else:
        memory_line = (f"chat memory block: {len(inputs.get('chat_memory', ''))} chars = {_memory_parts(notes)}"
                       f"; chat tools {'given' if chat_tools else 'not given'}")
    turns = min(len(history), HISTORY_TURNS)
    trace.add("context",
              f"signature: {signature.__name__} | model {getattr(lm, 'model', '?')} | "
              f"up to {budget} reasoning steps ({route.depth})",
              f"tools    : {', '.join(t.__name__ for t in tool_list)}",
              f"question : {len(inputs['question'])} chars ("
              + ("the writer's raw message: Jev does not rewrite it" if route.engine == "jev"
                 else "rewritten as a standalone question by the triage model") + ")",
              f"conversation: {turns} turn(s), {len(inputs['conversation'])} chars  [Postgres, last messages]",
              f"writer notes: {len([ln for ln in profile.splitlines() if ln.strip()]) if profile else 0} line(s), "
              f"{len(profile)} chars  [Postgres WorkspaceMemory]",
              f"archive guide: {len(inputs['archive_guide'])} chars  [built in code]",
              memory_line)
    try:
        with trace.stage("agent"), track_usage(lm) as usage, dspy.context(lm=lm):
            pred = agent(**inputs)
    except AdapterParseError as exc:
        # Even the final answer step came back malformed twice. Save a plain reply instead of an unanswered question.
        # not `log`: inside research() that name is the step recorder
        logging.getLogger(__name__).warning("Research failed: the model's reply could not be read: %s",
                                            " ".join(str(exc.lm_response).split())[:200])
        trace.add("result", "! the final answer step was malformed twice, so a plain 'please send that again' reply "
                            "was saved")
        return ResearchResult(FAILED_REPLY, True, [], route.prompt_tokens, route.completion_tokens, steps=steps,
                              kind="error", question=route.question,
                              recall={"route": _route_info(route), "triage_detail": _triage_detail(route),
                                      "memory_loaded": chat_memory is not None, "failed": "malformed model reply"})

    with trace.stage("verify"):
        text, cites = verify_citations(tools, pred.answer, pred.citations or [], chat_tools)
    unsupported = bool(pred.unsupported) or not cites
    refused = False
    if not cites and not pred.unsupported:
        # The model answered without anything we could verify: do not pass it off as grounded.
        text = "I could not find support for that in these posts, so I would rather not guess."
        refused = True
    proposed = pred.citations or []
    kept = {(c.path, c.line_start) for c in cites}
    dropped = [c for c in proposed if (c.path, c.line_start) not in kept]
    trace.add("citations",
              f"the model proposed {len(proposed)}, verified {len(cites)} "
              f"(posts {sum(1 for c in cites if not is_chat_path(c.path))}, "
              f"earlier chats {sum(1 for c in cites if is_chat_path(c.path))}), dropped {len(dropped)}",
              *[f"dropped: {c.path}:{c.line_start}-{c.line_end} (file not allowed here, or lines do not exist)"
                for c in dropped[:6]])
    trace.add("result",
              f"answer {len(text)} chars | unsupported={unsupported} | "
              f"tokens prompt/completion: triage {route.prompt_tokens}/{route.completion_tokens}, "
              f"agent {usage.prompt_tokens}/{usage.completion_tokens}",
              *(["the model gave no verifiable citation, so the answer was replaced with the 'could not find "
                 "support' message"] if refused else []))
    return ResearchResult(
        text=strip_em_dashes(text),
        unsupported=unsupported,
        citations=cites,
        prompt_tokens=usage.prompt_tokens + route.prompt_tokens,
        completion_tokens=usage.completion_tokens + route.completion_tokens,
        steps=steps,
        kind="archive",
        question=route.question,
        recall={
            "route": _route_info(route),
            "triage_detail": _triage_detail(route),
            "memory_loaded": chat_memory is not None,
            "memory_notes": notes[:4000],  # exactly what the agent was shown from earlier chats
            "chat_tools": chat_tools is not None,
            "chat_topics": [e.slug for e in chat_memory.tf.entries] if chat_memory is not None else [],
        },
    )

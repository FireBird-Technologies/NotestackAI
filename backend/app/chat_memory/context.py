"""The read path of chat memory: before an answer, decide how much of the chat's memory the research agent needs and
build it as one small text block.

Everything the answer step needs from the database is loaded up front by `load_chat_memory` (in the request, with its
session), so the research agent runs in its thread with plain data and no database access.

How much memory a message needs is the `memory` decision made by triage:
  none     a fresh question about the posts: nothing extra
  lookup   a follow up on a topic: that topic's summary and its last few rounds word for word
  replay   "what exactly did you say": the topic's saved exact words, and the chat tools to go further
  compose  a reference to earlier conversations in general: the notebook's topic list, and the chat tools"""

import logging
import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.chat_memory import files
from app.chat_memory.files import Topic, TopicsFile
from app.chat_memory.organize import after_through, chat_corpus, ordered_messages, read_topic, read_topics_file
from app.config import settings
from app.corpus import Corpus
from app.models import Message

log = logging.getLogger(__name__)

MEMORY_LEVELS = ("none", "lookup", "replay", "compose")
BACKLOG_MESSAGES = 6  # unprocessed messages older than the history window that are added back
INDEX_PREVIEW_LINES = 20
TURN_CHARS = 500

# Jev choices (see pipeline/research.py triage_with_jev)
JEV_MEMORY = {
    "none": {
        "what": "A new question about the writer's posts that makes sense on its own, with no reference to anything "
                "said earlier in the conversation",
        "examples": ["What have I written about pricing?", "Summarize my post on habits"],
    },
    "lookup": {
        "what": "A follow up that continues a topic from earlier in this chat and needs to know what was discussed",
        "examples": ["Which of those benchmarks is best?", "Say more about the second point", "Go on"],
    },
    "replay": {
        "what": "Asks what the assistant or the writer said earlier in this chat, or points at a specific earlier "
                "answer or instruction",
        "examples": ["What exactly did you say about MMLU?", "You listed three options earlier, what were they?",
                     "Use the format I asked for before"],
    },
    "compose": {
        "what": "Refers to an earlier conversation or an earlier time, not just the current topic",
        "examples": ["What did I ask about pricing last week?", "In another chat we talked about churn",
                     "Did I ever ask about Obama?"],
    },
}
JEV_MEMORY_QUESTION = "How much memory of earlier conversation does the latest message need?"
JEV_TOPIC_NONE = {"what": "A new subject that is none of the topics above, or a plain question about the posts"}


def topic_question(tf: TopicsFile) -> dict | None:
    """The Jev question that picks which topic of this chat a message belongs to."""
    shown = sorted(tf.entries, key=lambda e: e.last, reverse=True)[:settings.chat_memory_topics_shown]
    if not shown:
        return None
    criteria = {e.slug: {"what": f"{e.label}: {e.gist}. Words used: {e.keywords}"} for e in shown}
    criteria["none"] = JEV_TOPIC_NONE
    return {"instructions": "Which earlier topic of this conversation does the latest message belong to?",
            "criteria": criteria}


def topics_digest(tf: TopicsFile) -> str:
    """A few lines for the triage model: the topics of this chat and when each was last active."""
    shown = sorted(tf.entries, key=lambda e: e.last, reverse=True)[:settings.chat_memory_topics_shown]
    return "\n".join(f"{e.slug} | {e.label} | last active {e.last} | {e.gist}" for e in shown) or "(none)"


@dataclass
class Said:
    role: str  # writer | assistant
    text: str
    date: str


@dataclass
class ChatMemory:
    """Everything the read path needs, loaded in advance."""

    corpus: Corpus
    chat_id: str
    tf: TopicsFile
    topics: dict[str, Topic] = field(default_factory=dict)
    messages: dict[str, Said] = field(default_factory=dict)  # by message id
    backlog: list[Said] = field(default_factory=list)  # processed late: older than the history window, oldest first
    index_preview: str = ""

    @property
    def has_anything(self) -> bool:
        return bool(self.tf.entries or self.index_preview)

    def latest(self) -> str | None:
        return max(self.tf.entries, key=lambda e: e.last).slug if self.tf.entries else None


def load_chat_memory(db: Session, workspace_id: uuid.UUID, notebook_id: uuid.UUID, chat_id: uuid.UUID,
                     history_ids: set[str], corpus: Corpus | None = None) -> ChatMemory | None:
    """None when the read path is off, there is nothing remembered yet, or anything goes wrong: the chat then works as
    it always has, from the last few messages."""
    if not settings.chat_memory_read:
        return None
    try:
        corpus = corpus or chat_corpus(workspace_id, notebook_id)
        corpus.sync()
        mem = ChatMemory(corpus=corpus, chat_id=str(chat_id), tf=read_topics_file(corpus, chat_id))
        if corpus.exists(files.INDEX):
            mem.index_preview = "\n".join(corpus.read_lines(files.INDEX)[:INDEX_PREVIEW_LINES])
        if not mem.has_anything:
            return None
        shown = sorted(mem.tf.entries, key=lambda e: e.last, reverse=True)[:settings.chat_memory_topics_shown]
        for e in shown:
            topic = read_topic(corpus, chat_id, e.slug)
            if topic:
                mem.topics[e.slug] = topic
        ids = {uuid.UUID(i) for t in mem.topics.values() for i in t.recent if _is_uuid(i)}
        if ids:
            for m in db.scalars(select(Message).where(Message.id.in_(ids), Message.chat_id == chat_id)):
                mem.messages[str(m.id)] = _said(m)
        # Messages the job has not filed yet that the history window no longer covers (the job is far behind).
        pending = [m for m in after_through(ordered_messages(db, chat_id), mem.tf.through)
                   if str(m.id) not in history_ids]
        mem.backlog = [_said(m) for m in pending[-BACKLOG_MESSAGES:]]
        return mem
    except Exception:
        log.warning("Chat memory could not be loaded, continuing without it", exc_info=True)
        return None


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except ValueError:
        return False


def _said(m: Message) -> Said:
    text = m.content if m.role == "user" else files.strip_markers(m.content)
    return Said("writer" if m.role == "user" else "assistant", text, m.created_at.date().isoformat())


def _turns(items: list[Said]) -> str:
    return "\n".join(f"{s.role.capitalize()} ({s.date}): {files.squeeze(s.text, TURN_CHARS)}" for s in items)


def line_refs(mem: ChatMemory, t: Topic) -> tuple[str, dict[str, int], int]:
    """(the topic file's path as the agent sees it, line of each saved quote's first text line, line of the summary
    text), so the block can say where every line lives and the agent can cite it."""
    path = f"chats/{mem.chat_id}/{t.slug}.md"
    quotes: dict[str, int] = {}
    summary = 0
    try:
        for n, line in enumerate(mem.corpus.read_lines(files.topic_path(mem.chat_id, t.slug)), start=1):
            if line.strip() == "## Summary":
                summary = n + 2
            for q in t.verbatim:
                if line.startswith(f"[{q.message_id} "):
                    quotes[q.message_id] = n + 1
    except Exception:
        log.warning("Could not read line numbers of %s", path, exc_info=True)
    return path, quotes, summary


def build_context(mem: ChatMemory, topic: str, memory: str) -> tuple[str, bool]:
    """(the text block for the research agent, whether to give it the chat tools). An empty block means nothing."""
    if memory not in ("lookup", "replay", "compose"):
        return "", False
    tools = memory in ("replay", "compose")
    t = mem.topics.get(topic) or mem.topics.get(mem.latest() or "")
    parts: list[str] = []
    if memory in ("lookup", "replay") and t is not None:
        path, quote_lines, summary_line = line_refs(mem, t)
        parts.append(f"Topic: {t.label} (first {t.first}, last discussed {t.last}, {t.rounds} rounds). "
                     "Context only, never evidence about the posts. To cite what was said earlier, use the file and "
                     "line given in brackets.")
        if memory == "replay" and t.verbatim:
            parts.append("Exact words kept from this topic:\n" + "\n".join(
                f"[{q.role}, {q.date}, {path}:{quote_lines.get(q.message_id, 1)}] "
                f"{files.squeeze(q.text, files.MAX_VERBATIM_CHARS)}" for q in t.verbatim))
        parts.append(f"Summary [{path}:{summary_line or 1}]: {t.summary}")
        recent = [mem.messages[i] for i in t.recent if i in mem.messages][-settings.chat_memory_recent_rounds * 2:]
        if memory == "lookup" and recent:
            parts.append("Latest messages in this topic, word for word:\n" + _turns(recent))
    elif memory in ("lookup", "replay") and not mem.backlog:
        return "", tools  # no topic to load: replay still gets the tools to look around
    if memory == "compose" or (tools and t is None):
        parts.append("Earlier conversations in this notebook (use the chat tools to read them):\n"
                     + (mem.index_preview or "(none yet)"))
    if mem.backlog and memory in ("lookup", "replay"):
        parts.append("Messages not yet filed under a topic:\n" + _turns(mem.backlog))
    block = "\n\n".join(p for p in parts if p.strip())
    if len(block) > settings.chat_memory_context_chars:
        block = files.squeeze(block, settings.chat_memory_context_chars)
    return block, tools


def memory_decision(mem: ChatMemory | None, topic: str, memory: str, notes: str, with_tools: bool) -> str:
    """A plain account, for the server log, of what chat memory did for one message: whether it was read, which topic
    file the summary came from, and what of it went to the agent. Answers "which summary was passed, and from where"."""
    lines = [context_banner(mem, topic, memory, notes),
             f"CHAT_MEMORY_READ: {'on' if settings.chat_memory_read else 'OFF'}"]
    if not settings.chat_memory_read:
        lines.append("result: chat memory is not read. Only the last 8 messages are passed. Summaries are still being "
                     "written to R2, but nothing is loaded from them. Set CHAT_MEMORY_READ=true and restart.")
        return "\n".join(lines)
    if mem is None:
        lines.append("result: nothing loaded. This notebook has no chat memory yet, or loading it failed (look for a "
                     "'Chat memory could not be loaded' warning above).")
        return "\n".join(lines)
    lines.append(f"loaded for this notebook: {len(mem.tf.entries)} topic(s) in this chat, "
                 f"{len(mem.topics)} topic file(s) read, notebook index {'present' if mem.index_preview else 'empty'}")
    lines.append(f"triage chose: topic={topic or '-'} memory={memory}")
    t = mem.topics.get(topic) or mem.topics.get(mem.latest() or "")
    if memory == "none" or (not notes and not with_tools):
        lines.append("result: no summary passed (triage decided this message needs no memory of earlier chat).")
        return "\n".join(lines)
    if t is not None and memory in ("lookup", "replay"):
        rel = files.topic_path(mem.chat_id, t.slug)
        lines.append(f"summary source: {mem.corpus._key(rel)} (R2, read through the local cache)")
        lines.append(f"  topic '{t.label}': {t.rounds} round(s), last discussed {t.last}, "
                     f"summary {len(t.summary)} chars, {len(t.verbatim)} saved exact quote(s)")
        passed = ["summary"]
        recent = min(len(t.recent), settings.chat_memory_recent_rounds * 2)
        passed.append(f"{len(t.verbatim)} exact quote(s)" if memory == "replay"
                      else f"last {recent} messages of the topic (database)")
        if mem.backlog:
            passed.append(f"{len(mem.backlog)} message(s) not yet filed (database)")
        lines.append("passed to the agent: " + " + ".join(passed))
    elif memory == "compose":
        lines.append("passed to the agent: the notebook's list of earlier topics (INDEX.md from R2) and the chat tools")
    lines.append(f"chat tools given to the agent: {'yes' if with_tools else 'no'}")
    return "\n".join(lines)


def context_banner(mem: ChatMemory | None, topic: str, memory: str, notes: str) -> str:
    """One line, for the server log, that says which summary was passed as context and whether the chat switched topic.
    `mem.tf.current` is the topic the chat was just on, so a different topic now means the writer switched."""
    if not settings.chat_memory_read:
        return "=== NO SUMMARY PASSED as context: CHAT_MEMORY_READ is off ==="
    if mem is None:
        return "=== NO SUMMARY PASSED as context: this notebook has no chat memory yet (or it could not be loaded) ==="
    if memory == "compose":
        return "=== NO SINGLE SUMMARY: the notebook's list of earlier topics was passed as context ==="
    t = mem.topics.get(topic) or mem.topics.get(mem.latest() or "")
    if memory == "none" or t is None or not notes:
        return "=== NO SUMMARY PASSED as context: this message needs no memory of earlier chat ==="
    before = mem.topics.get(mem.tf.current)
    if before is not None and before.slug != t.slug:
        return (f"=== SUMMARY SWITCHED from '{before.label}' to '{t.label}': "
                f"the summary of '{t.label}' was passed as context ({memory}) ===")
    return f"=== SUMMARY CONTINUES on '{t.label}': the summary of '{t.label}' was passed as context ({memory}) ==="

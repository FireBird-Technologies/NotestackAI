"""Agentic research over the file system corpus: the model explores files with list/search/read,
then every citation is checked against the real file before it reaches the writer.

Cost control: every message is triaged first. Greetings and thanks are answered from a phrase list
(no model call). Everything else gets one cheap call on the fast model that reads the recent
conversation, answers off topic and app questions directly, and turns follow ups into standalone
questions. Only real archive questions run the research agent, with a small step budget for simple
lookups and the full budget for synthesis."""

import contextvars
import logging
import random
import re
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import dspy
from dspy.utils.exceptions import AdapterParseError
from litellm import ContextWindowExceededError

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
from app.llm.provider import fast_lm, main_lm, track_usage, triage_lm
from app.llm.signatures import (
    ResearchArchive,
    ResearchArchiveWithMemory,
    ResearchExternal,
    SplitQuestion,
    TriageMessage,
    TriageWithMemory,
)
from app.pipeline import writer
from app.pipeline.create_intent import parse_create
from app.pipeline.external_delivery import adapter_for_tools
from app.pipeline.internal_artifact_tools import TRANSFERABLE_ARTIFACTS, start_from_chat
from app.pipeline.prefetch import (
    DEEP_PER_POST,
    DEEP_TOP_K,
    OVERVIEW_BUDGET_CHARS,
    OVERVIEW_LIST_CHARS,
    openings,
    passages_of,
    prefetch,
)
from app.pipeline.trace import MEMORY_GIVES, ChatTrace, arguments_shape, current_trace, probs_text
from app.services import jev

_MARKER = re.compile(r"\[(\d+)\]")
_HTTPS_URL = re.compile(r"https://[^\s)\]>]+")
_ASKS_FOR_CREATED_LINK = re.compile(
    r"\b(link|url|open)\b.*\b(this|that|the|these|those|created|made|destination|canva|notion|page|result)\b|"
    r"\b(this|that|the|these|those|created|made|destination|canva|notion|page|result)\b.*\b(link|url)\b",
    re.IGNORECASE,
)
log = logging.getLogger(__name__)
tool_flow_log = logging.getLogger("notestack.tool_flow")


def _append_external_resource_links(text: str, sources: list[dict]) -> str:
    """Make write-tool resource links deterministic even when the model forgets to repeat them."""
    missing: list[tuple[str, str]] = []
    seen: set[str] = set()
    for source in sources:
        connection = str(source.get("connection") or "external tool")
        for url in source.get("urls") or []:
            if not isinstance(url, str) or url in text or url in seen:
                continue
            seen.add(url)
            missing.append((connection, url))
    if not missing:
        return text

    links: list[str] = []
    for index, (connection, url) in enumerate(missing, start=1):
        safe_connection = re.sub(r"[\[\]()]", "", connection).strip() or "external tool"
        suffix = f" {index}" if len(missing) > 1 else ""
        links.append(f"- [Open the result from {safe_connection}{suffix}]({url})")
    return text.rstrip() + "\n\n" + "\n".join(links)


def previous_created_link(question: str, history: list["Turn"]) -> str | None:
    """A follow-up asking for a link we just returned should not run the external tool chooser again."""
    if not _ASKS_FOR_CREATED_LINK.search(question):
        return None
    for turn in reversed(history):
        if turn.role != "assistant":
            continue
        urls = _HTTPS_URL.findall(turn.text)
        if urls:
            return urls[-1].rstrip(".,;:'\"")
    return None


def previous_delivery_status(question: str, history: list["Turn"]) -> tuple[str, str, str | None] | None:
    """Return the latest background delivery state for a follow-up asking for its destination link."""
    if not _ASKS_FOR_CREATED_LINK.search(question):
        return None
    for turn in reversed(history):
        status = turn.background_status if turn.role == "assistant" else None
        if not isinstance(status, dict):
            continue
        state = str(status.get("state") or "").lower()
        if state not in {"working", "done", "failed"}:
            continue
        return state, str(status.get("message") or "").strip(), status.get("url")
    return None


@dataclass
class VerifiedCitation:
    marker: int
    path: str
    line_start: int
    line_end: int
    quote: str


def _route_info(route: "Triage") -> dict:
    """What triage decided, in plain values: the first thing to look at when an answer forgot or mixed up a chat."""
    return {"kind": route.kind, "depth": route.depth, "detail": route.detail, "reuse": route.reuse,
            "topic": route.topic, "memory": route.memory, "standalone_question": route.question}


@dataclass
class ResearchResult:
    text: str
    unsupported: bool
    citations: list[VerifiedCitation]
    prompt_tokens: int = 0
    completion_tokens: int = 0
    steps: list[tuple[str, str]] = field(default_factory=list)
    kind: str = "archive"  # archive | chitchat | about_app | off_topic | external_action | create
    question: str = ""  # the standalone question that was researched
    recall: dict = field(default_factory=dict)  # how recall behaved for this answer (saved with the message)
    topic: str = ""  # what the answer is about in a few words (from the writer), for the next-step suggestions
    action: dict | None = None  # kind create: {"artifact", "settings"}, the dialog the app opens with those settings
    external_sources: list[dict] = field(default_factory=list)
    external_widgets: list[dict] = field(default_factory=list)
    created_artifacts: list[dict] = field(default_factory=list)
    background_action: dict | None = None


@dataclass
class Turn:
    role: str  # user | assistant
    text: str
    background_status: dict | None = None


HISTORY_TURNS = 8
HISTORY_CHARS = 700  # per older message: half from the start, half from the end
RECENT_TURNS = 2  # the newest messages (the last question and answer) are kept whole, up to RECENT_CHARS
RECENT_CHARS = 4000  # safety ceiling for those, the same as the longest question a writer can send
QUICK_STEPS = 4

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
    detail: str = "standard"  # brief | standard | in_depth: how long the answer should be (depth sets research steps)
    reuse: str = "new_research"  # new_research | rewrite_last: only reshape the previous answer, no new research
    # For the log and for recall_json: who decided, what Jev answered before our thresholds, and what they changed.
    engine: str = ""
    jev: dict = field(default_factory=dict)  # question id -> {"choice", "confidence", "probabilities"}
    notes: list[str] = field(default_factory=list)


JEV_INTENT = {
    "archive": {
        "what": "Needs facts, ideas, quotes, opinions or history from the writer's own posts, including follow ups "
                "to the conversation. Also any question, however general or how-to it sounds, whose subject is the "
                "same as, or next to, the subject of ANY post title in the notebook line",
        "examples": ["What have I written about pricing?", "Summarize my take on AI", "Tell me more about that",
                     "A best-practice question on a subject one of the listed post titles covers"],
    },
    "chitchat": {
        "what": "Greetings, thanks, reactions or small talk with no question about the posts",
        "examples": ["hello there", "that was helpful, thanks", "you are great"],
    },
    "about_app": {
        "what": "How to use Notestack itself: sources, notebooks, audio, video, launch kits, settings",
        "examples": ["How do I add another Substack?", "Where do I find my audio overviews?"],
    },
    "create": {
        "what": "Asks to make something from the posts: an audio overview or podcast, slide deck, video, report, "
                "infographic, quiz, flashcards or mind map",
        "examples": ["Create an audio overview of 10 minutes", "Make a slide deck on my pricing posts",
                     "Quiz me on this, hard questions", "Turn that into an infographic"],
    },
    "external_action": {
        "what": "Explicitly asks to use a connected external app or service, or to perform an action outside the "
                "notebook: send an email, post a message, create or update something in another app, search an "
                "external account, or run a named integration",
        "not_for": "A general knowledge, coding, math or news question that does not ask to use an external app. "
                   "Also not for Notestack's built-in audio, slides, video, report, infographic, quiz, flashcards "
                   "or mind map unless the message explicitly assigns the work to a connected app",
        "examples": ["Send an email to Sara", "Post this in Slack", "Create a page in Notion",
                     "Use B2V to make a video", "Find my open issues in the connected tracker"],
    },
    "off_topic": {
        "what": "General knowledge, coding, math, news, homework or tasks whose subject matches NONE of the post "
                "titles in the notebook line and that do not explicitly request a connected external app action",
        "not_for": "Anything that shares a subject with a post title, even loosely or in different words (spelling "
                   "variants, synonyms, a broader or narrower angle). When unsure, it is archive: a wasted search "
                   "costs less than a wrong brush off",
        "examples": ["What is the capital of France?", "Write me a Python script", "Who won the game last night?"],
    },
}
JEV_DEPTH = {
    "quick": "A single fact, quote or lookup in one or two posts",
    "deep": "Synthesis, comparison or change over time across many posts",
}
JEV_MIN_CONFIDENCE = 0.55  # below this, research anyway: a wasted search beats a wrong brush off
JEV_DETAIL = {
    "standard": {
        "what": "Asks about the posts without saying how long or detailed the answer should be",
        "examples": ["What have I written about pricing?", "How did my view on remote work change?",
                     "Which posts mention Stripe?"],
    },
    "in_depth": {
        "what": "Explicitly asks for a detailed, thorough, comprehensive or step by step answer, a deep dive, or "
                "everything about a subject",
        "examples": ["Give me a detailed breakdown of my pricing posts", "Deep dive into everything I said about AI",
                     "Explain step by step how I set up my newsletter"],
    },
    "brief": {
        "what": "Explicitly asks for a short answer: one line, tl;dr, quickly, in brief",
        "examples": ["tl;dr of my pricing posts", "In one line, what do I think about AI?",
                     "Quickly, did I ever write about hiring?"],
    },
}
JEV_REUSE = {
    "new_research": {
        "what": "Needs the posts looked at again: a new question, a new subject, or facts the last answer did not give",
        "examples": ["What about hiring?", "Say more about the second point", "Why did I change my mind?"],
    },
    "rewrite_last": {
        "what": "Only asks to reshape the assistant's previous answer (shorter, simpler, as bullets or a table, "
                "rephrased or translated) with no new information needed",
        "examples": ["make it shorter", "put that in bullets", "can you rephrase that more simply?"],
    },
}
_BRIEF = re.compile(r"\btl;?dr\b|\bin (one|a|1) (line|sentence)\b|\bbriefly\b|\bin brief\b|\bshort answer\b|"
                    r"\bquick(ly)? summar|\bone[- ]liner\b|\bkeep it short\b", re.IGNORECASE)
_IN_DEPTH = re.compile(r"\bin (great |more |full )?detail\b|\bdetailed\b|\bdeep[- ]?dive\b|\bcomprehensive(ly)?\b|"
                       r"\bthorough(ly)?\b|\belaborate\b|\bexpand on\b|\bstep[- ]by[- ]step\b|\bfull breakdown\b|"
                       r"\beverything (about|on|i)\b|\blong answer\b|\bin[- ]depth\b", re.IGNORECASE)
_REWRITE = re.compile(r"^\s*(can you |could you |please )?(make (it|that|this) (shorter|simpler|clearer|briefer)|"
                      r"shorten (it|that|this)|(put|format|turn) (it|that|this) (in|into|as)\b|in bullets?\b|"
                      r"as (a )?(list|table|bullets)\b|rephrase|reword|summari[sz]e (that|this|it)\b|"
                      r"translate (it|that|this)\b)", re.IGNORECASE)


# An explicit ask to make something, said as a request: "create an audio overview of 10 minutes", "can you make me
# a hard quiz", "turn this into slides". Questions about the posts ("what did I make of the report?") do not start so.
_CREATE = re.compile(
    r"^\s*(please |pls |ok(ay)?,? |now,? |so,? )?((can|could|would|will) you (please )?|i want( you to)?( to)? |"
    r"i'?d like( you to)?( to)? |let'?s )?"
    r"(create|make|generate|build|produce|prepare|draft|design|give me|i (want|need) (a|an|some)|turn\b.{0,60}\binto|quiz me|test me)\b"
    r".{0,80}?\b(audio overviews?|podcasts?|audio|slides?|slide ?decks?|decks?|presentations?|videos?|reports?|"
    r"infographics?|quiz(zes)?|flash ?cards?|mind ?maps?|(mind )?constellations?|study guides?|briefing docs?)\b"
    r"|^\s*(please )?(quiz|test) me\b",
    re.IGNORECASE)

_EXPLICIT_CREATE_VERB = re.compile(
    r"\b(create|make|generate|build|produce|prepare|draft|design)\b|\bturn\b.{0,60}\binto\b",
    re.IGNORECASE,
)


def names_external_app(message: str, aliases: set[str] | list[str]) -> str | None:
    """The connected app named anywhere in a create request.

    This deliberately does not enumerate phrases such as ``using Canva`` or ``in Canva``. Triage has already decided
    that the message is a create/action request; an exact connected-app alias is therefore enough to route it to that
    app's enabled capabilities instead of opening a built-in settings dialog.
    """
    if not asks_to_create(message):
        return None
    for alias in sorted(aliases, key=len, reverse=True):
        if re.search(rf"(?<![\w-]){re.escape(alias)}(?![\w-])", message, re.IGNORECASE):
            return alias
    return None


def asks_to_create(message: str) -> bool:
    # "Give me the destination link for these flashcards" is a lookup of an earlier result, not a request to build
    # another flashcard artifact. Keep explicit creation requests such as "create flashcards and give me the link".
    if _ASKS_FOR_CREATED_LINK.search(message) and not _EXPLICIT_CREATE_VERB.search(message):
        return False
    return bool(_CREATE.search(message))


_ARTIFACT_PATTERNS = {
    "audio_overview": re.compile(r"\b(?:audio\s+overviews?|podcasts?|audio)\b", re.IGNORECASE),
    "slide_deck": re.compile(r"\b(?:slide\s*decks?|slides?|decks?|presentations?)\b", re.IGNORECASE),
    "video": re.compile(r"\bvideos?\b", re.IGNORECASE),
    "report": re.compile(r"\b(?:reports?|briefing\s+docs?|study\s+guides?)\b", re.IGNORECASE),
    "infographic": re.compile(r"\binfographics?\b", re.IGNORECASE),
    "flashcards": re.compile(r"\bflash\s*cards?\b", re.IGNORECASE),
    "quiz": re.compile(r"\bquiz(?:zes)?\b|\btest\s+me\b", re.IGNORECASE),
    "mind_map": re.compile(r"\b(?:mind\s+maps?|mind\s+constellations?|constellations?)\b", re.IGNORECASE),
}
_NOTEBOOK_ARTIFACT_SOURCE = re.compile(
    r"\b(?:this|the|my|connected)\s+(?:notebook|posts?|sources?)\b|"
    r"\bfrom\b.{0,50}\b(?:notebook|posts?|sources?)\b",
    re.IGNORECASE,
)


def compound_artifact_request(message: str) -> str | None:
    """A named Studio artifact in an external-action request. This is deterministic, not another Jev decision."""
    making_from_notebook = asks_to_create(message) or bool(_NOTEBOOK_ARTIFACT_SOURCE.search(message))
    if not making_from_notebook:
        return None
    return next((artifact for artifact, pattern in _ARTIFACT_PATTERNS.items() if pattern.search(message)), None)


def _external_tool(tools: list, remote_name: str, connection_id: str | None = None):
    suffix = "_" + remote_name.replace("-", "_")
    expected = f"mcp_{connection_id.replace('-', '')[:8]}{suffix}" if connection_id else None
    return next((tool for tool in tools
                 if (name := str(getattr(tool, "name", getattr(tool, "__name__", "")))) == expected
                 or (expected is None and name.endswith(suffix))), None)


def compound_destination(named_app: str | None, destinations: list[dict]) -> dict | None:
    """Select the named connection by alias, then select its delivery adapter by capabilities."""
    if not named_app:
        return None
    wanted = named_app.lower()
    for destination in destinations:
        aliases = {str(value).lower() for value in destination.get("aliases") or []}
        if wanted not in aliases:
            continue
        adapter = adapter_for_tools(set(destination.get("tools") or []))
        if adapter:
            return {**destination, "adapter": adapter.key, "placeholder": adapter.placeholder}
    return None


def _page_title(message: str, artifact: str) -> str:
    quoted = re.search(r"\b(?:call(?:ed)?|name(?:d)?|title(?:d)?)\s+(?:the\s+design\s+|it\s+)?[\"'“‘]([^\"'”’]{1,200})[\"'”’]",
                       message, re.IGNORECASE)
    if quoted:
        return quoted.group(1).strip()
    plain = re.search(
        r"\b(?:call(?:ed)?|name(?:d)?|title(?:d)?)(?:\s+the\s+design)?\s+(?:it\s+)?(?:as\s+)?(.{1,200}?)"
        r"(?=\s+(?:and|then|with|using|in|on|put|add)\b|[,.!?]|$)",
        message,
        re.IGNORECASE,
    )
    return plain.group(1).strip(" \"'") if plain else f"NoteStack {artifact.replace('_', ' ').title()}"


def _create_notion_placeholder(external_tools: list, external_sources: list, destination: dict,
                               message: str, artifact: str) -> str:
    tool = _external_tool(external_tools, "notion-create-pages", destination.get("connection_id"))
    if tool is None:
        raise RuntimeError("The enabled Notion connection does not provide create-pages.")
    label = artifact.replace("_", " ")
    result = tool(
        pages=[{
            "properties": {"title": _page_title(message, artifact)},
            "content": (
                f"NoteStack is creating the {label} from the connected notebook posts. "
                "This page will be filled automatically when the artifact is ready."
            ),
        }],
        creation_mode="draft",
        allow_async=False,
    )
    for source in reversed(external_sources):
        if getattr(source, "tool", "") == "notion-create-pages" and getattr(source, "urls", None):
            return source.urls[-1]
    urls = _HTTPS_URL.findall(str(result))
    if not urls:
        raise RuntimeError("Notion created no page URL.")
    return urls[-1].rstrip(".,;:'\"}]")


def answer_length_from_text(message: str) -> str | None:
    """An explicit ask for a short or a detailed answer, in so many words. None when the message does not say."""
    if _BRIEF.search(message):
        return "brief"
    if _IN_DEPTH.search(message):
        return "in_depth"
    return None


def asks_to_rewrite(message: str) -> bool:
    return bool(_REWRITE.match(message))


# Words that point back at the conversation. "these posts", "this notebook" and the like point at the notebook instead.
_REFERS = re.compile(r"\b(it|its|that|this|these|those|him|his|her|hers|he|she|they|them|their|more|why|again|"
                     r"above|previous|earlier|same)\b", re.IGNORECASE)
_NOTEBOOK_WORDS = re.compile(r"\b(this|these|those|that|my|the|all|all of)\s+(posts?|notebooks?|archives?|blogs?|"
                             r"articles?|essays?|newsletters?|writing)\b", re.IGNORECASE)


def refers_back(message: str) -> bool:
    """The message only makes sense with the conversation ("explain how to use it", "a brief intro of him")."""
    return bool(_REFERS.search(_NOTEBOOK_WORDS.sub(" ", message)))


_NOTESTACK_NAME = re.compile(
    r"\b(?:noetstack|notstack|netstack|notestack(?:\s*ai)?|note\s*stack(?:\s*ai)?)\b",
    re.IGNORECASE,
)


def external_question(message: str) -> str:
    """Resolve known product-name spellings before an external service performs literal text search."""
    return _NOTESTACK_NAME.sub("NotestackAI", message)


def _has_answer(history: list[Turn]) -> bool:
    return any(t.role == "assistant" for t in history)


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
                                   "knows this writer's posts? First compare its subject with the post titles in "
                                   "the notebook line", "criteria": JEV_INTENT},
        "depth": {"instructions": "If it is about the posts, how much research does it need?",
                  "criteria": JEV_DEPTH},
    }
    questions["detail"] = {"instructions": "How long and detailed an answer does the latest message ask for?",
                           "criteria": JEV_DETAIL}
    if _has_answer(history):
        questions["reuse"] = {"instructions": "Does the latest message need new research in the posts, or only a "
                                              "reshaped version of the assistant's previous answer?",
                              "criteria": JEV_REUSE}
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
    detail = "standard"
    asked = answers.get("detail")  # .get: older fakes answer only intent and depth
    if asked and asked.choice in JEV_DETAIL and asked.choice != "standard":
        if asked.confidence >= JEV_MIN_CONFIDENCE:
            detail = asked.choice
        else:
            notes.append(f"detail {asked.choice!r} confidence {asked.confidence:.2f} < {JEV_MIN_CONFIDENCE} -> standard "
                         "(a longer or shorter answer only when the writer clearly asks)")
    reuse = "new_research"
    asked = answers.get("reuse")
    if asked and asked.choice == "rewrite_last" and kind == "archive":
        if asked.confidence >= JEV_MIN_CONFIDENCE:
            reuse = "rewrite_last"
        else:
            notes.append(f"reuse 'rewrite_last' confidence {asked.confidence:.2f} < {JEV_MIN_CONFIDENCE} "
                         "-> new_research")
    # Jev does not write text: the research agent resolves follow ups using the conversation it is given.
    return Triage(kind, message, depth.choice if depth.choice in JEV_DEPTH else "deep", "", topic=topic, memory=memory,
                  detail=detail, reuse=reuse, engine="jev", jev=raw, notes=notes)


def _phrase_rules(route: Triage, message: str, history: list[Turn]) -> Triage:
    """What the message says in so many words wins: an explicit ask for a short or detailed answer, and a plain
    "make it shorter" style request (when Jev is off, failed, or missed it)."""
    if route.kind == "off_topic" and _has_answer(history) and refers_back(message):
        route.notes.append("off_topic, but the message refers to the conversation (a follow up) -> archive")
        route.kind, route.reply = "archive", ""
    if route.kind not in {"create", "external_action"} and asks_to_create(message):
        route.notes.append(f"{route.kind}, but the message asks to make something in so many words -> create")
        route.kind, route.reply = "create", ""
    asked = answer_length_from_text(message)
    if asked and asked != route.detail:
        route.notes.append(f"the message asks for a {asked} answer in so many words -> detail={asked}")
        route.detail = asked
    if (route.kind == "archive" and route.reuse != "rewrite_last" and _has_answer(history)
            and asks_to_rewrite(message)):
        route.notes.append("the message only asks to reshape the previous answer -> reuse=rewrite_last")
        route.reuse = "rewrite_last"
    return route


def triage(message: str, history: list[Turn], notebook: str, mem: ChatMemory | None = None) -> Triage:
    """Decide whether a message is worth researching. Jev when configured (fast, typed, no generation),
    otherwise one cheap call on the triage LLM."""
    why = "Jev is not configured (no TYPESAFE_API_KEY)"
    if jev.configured():
        try:
            return _phrase_rules(triage_with_jev(message, history, notebook, mem), message, history)
        except jev.JevError as exc:
            log.warning("Jev triage failed, falling back to the LLM", exc_info=True)
            why = f"Jev failed: {exc}"
    route = triage_llm(message, history, notebook, mem)
    route.engine = f"llm triage ({why})"
    return _phrase_rules(route, message, history)


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
    kind = pred.kind if pred.kind in {
        "archive", "chitchat", "about_app", "off_topic", "external_action", "create"
    } else "archive"
    question = (pred.standalone_question or "").strip() or message
    reply = strip_em_dashes((pred.reply or "").strip())
    if kind not in ("archive", "external_action", "create") and not reply:
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


OFF_TOPIC_RETRIES = 1  # one fuller Jev look after the initial title-only decision
RECHECK_OPENING_CHARS = 600  # per post: its first two paragraphs, cut here
RECHECK_BUDGET_CHARS = 60_000  # all the openings together; posts past it are listed by title only
RECHECK_TIMEOUT = 12.0  # the brief is far bigger than the first look's
RECHECK_INSTRUCTIONS = (
    "A first look called this message off topic. Compare its subject with EVERY post title and opening below. "
    "If the subject appears in any of them, even loosely or in different words, it is archive",
)


def notebook_brief_full(title: str, allowed: dict[str, str], corpus: Corpus) -> str:
    """Every post title, each with the first two paragraphs of the post (until the budget is used)."""
    lines, used = [], 0
    for rel, post_title in allowed.items():
        opening = ""
        if used < RECHECK_BUDGET_CHARS:
            paragraphs = [" ".join(t.strip() for t in p.lines if t.strip()) for p in passages_of(corpus, rel, post_title)[:2]]
            opening = shorten(" ".join(x for x in paragraphs if x), RECHECK_OPENING_CHARS)
            used += len(opening)
        lines.append(f"- {post_title}" + (f": {opening}" if opening else ""))
    return f"Notebook: {title}. {len(allowed)} posts:\n" + "\n".join(lines)


def recheck_off_topic(route: Triage, message: str, history: list[Turn], brief: str) -> Triage:
    """Jev called the message off topic from 25 titles alone. Look again, up to OFF_TOPIC_RETRIES times, with every
    title and each post's opening. Any look that says archive (or is unsure) sends it to research; it stays off topic
    only when every look agrees. If Jev fails, research anyway: a wasted search beats a wrong brush off."""
    state = {"notebook": brief, "conversation": conversation_text(history, limit=4), "message": message}
    for attempt in range(1, OFF_TOPIC_RETRIES + 1):
        qid = f"intent_retry{attempt}"
        try:
            a = jev.decide(state, {"intent": {"instructions": RECHECK_INSTRUCTIONS[attempt - 1], "criteria": JEV_INTENT}},
                           timeout=RECHECK_TIMEOUT)["intent"]
        except jev.JevError as exc:
            route.notes.append(f"off_topic recheck {attempt} failed ({exc}) -> archive")
            route.kind, route.reply = "archive", ""
            return route
        route.jev[qid] = {"choice": a.choice, "confidence": round(a.confidence, 2),
                          "probabilities": {k: round(v, 2) for k, v in a.probabilities.items()}}
        if a.choice == "off_topic" and a.confidence >= JEV_MIN_CONFIDENCE:
            route.notes.append(f"off_topic recheck {attempt}: still off_topic ({a.confidence:.2f})")
            continue
        if a.choice == "external_action" and a.confidence >= JEV_MIN_CONFIDENCE:
            route.notes.append(f"off_topic recheck {attempt}: external_action ({a.confidence:.2f})")
            route.kind, route.reply = "external_action", ""
            return route
        route.notes.append(f"off_topic recheck {attempt}: {a.choice} ({a.confidence:.2f}) -> archive")
        route.kind, route.reply = "archive", ""
        return route
    route.notes.append(f"off_topic confirmed by {OFF_TOPIC_RETRIES} rechecks with all titles and openings")
    return route


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
FAST_PATH_MIN_COVERAGE = 0.75  # share of the question's words the prefetched passages must hold to skip the agent
MAX_PARTS = 3


@dataclass
class LastAnswer:
    """The previous assistant answer in this chat with its verified citations: enough to reshape it without research."""
    text: str
    citations: list[VerifiedCitation]


class _Stream:
    """The streamed answer writer for one message: sends text to on_delta as it arrives, takes a draft back (on_delta
    None) when a write fails after text was shown, and adds up the writer's tokens (track_usage cannot see them)."""

    def __init__(self, on_delta: Callable[[str | None], None] | None, trace: ChatTrace):
        self.on_delta, self.trace = on_delta, trace
        self.sent = False
        self.prompt_tokens = self.completion_tokens = 0
        self.topic = ""  # from the last write that succeeded

    def _emit(self, text: str) -> None:
        self.sent = True
        if self.on_delta:
            self.on_delta(text)

    def reset(self) -> None:
        if self.sent and self.on_delta:
            self.on_delta(None)
        self.sent = False

    def write(self, inputs: dict, evidence: str, length: str, label: str,
              shrink: Callable[[], str] | None = None, stop_if_uncovered: bool = False) -> "writer.WriterResult | None":
        """None when the write failed; the caller then takes another path. `shrink` returns smaller evidence when the
        prompt is over the context window (it raises ValueError when there is nothing left to cut). stop_if_uncovered:
        a one-call path stops at the model's first line when it says the material does not answer the question."""
        why = "unknown"
        for _ in range(3):
            try:
                res = writer.stream_answer(inputs, evidence, self._emit, length, stop_if_uncovered)
            except writer.WriterUncovered:
                why = "the model's first line said these passages do not answer it, so it stopped before any text"
                break
            except ContextWindowExceededError:
                why = "over the context window"
                if self.sent or shrink is None:
                    break
                try:
                    evidence = shrink()
                except ValueError:
                    break
                continue
            except Exception as exc:  # a failed stream must never cost the writer their answer: another path runs
                why = f"{type(exc).__name__}: {' '.join(str(exc).split())[:160]}"
                log.warning("Streamed answer failed (%s): %s", label, why)
                break
            self.prompt_tokens += res.prompt_tokens
            self.completion_tokens += res.completion_tokens
            self.topic = res.topic
            self.trace.add("writer", f"{label}: streamed {len(res.answer)} chars in {res.chunks} chunks, "
                                     f"{len(res.citations)} citation(s), unsupported={res.unsupported}, "
                                     f"tokens {res.prompt_tokens}/{res.completion_tokens}")
            return res
        self.reset()
        self.trace.add("writer", f"{label}: failed ({why})")
        return None

    def extractor(self, length: str):
        """Replaces ReAct's answer step with the streamed writer. None hands it back to dspy's own answer step."""
        def extract(agent, trajectory, inputs):
            state = {"t": dict(trajectory)}

            def shrink() -> str:
                state["t"] = agent.truncate_trajectory(state["t"])
                return agent._format_trajectory(state["t"])

            res = self.write(inputs, agent._format_trajectory(trajectory), length, "agent answer", shrink)
            if res is None:
                self.trace.add("writer", "agent answer: falling back to the agent's own answer step (not streamed)")
                return None
            return dspy.Prediction(answer=res.answer, citations=res.citations, unsupported=res.unsupported)
        return extract


def _retry_malformed_steps(agent, trace: ChatTrace, extract=None):
    """dspy's ReAct needs every model reply to be JSON with next_thought, next_tool_name and next_tool_args. The model
    sometimes sends only the tool's arguments, which raises AdapterParseError and used to fail the whole message.
    Here the failing step is asked once more (a new request, not the cached one). If it fails again, a ValueError
    tells ReAct to stop researching and write the answer from what it has found so far.

    `extract(agent, trajectory, inputs)` takes over ReAct's answer step (the streamed writer, or capturing the
    trajectory for a multi-part question). When it returns None the agent's own answer step runs as before.

    Hooks ReAct's `_call_with_potential_trajectory_truncation` (dspy 2.6.*, pinned in requirements.txt). Without it the
    agent is returned unchanged."""
    original = getattr(agent, "_call_with_potential_trajectory_truncation", None)
    if original is None:
        return agent

    def call(module, trajectory, **inputs):
        if extract is not None and module is agent.extract:
            pred = extract(agent, trajectory, inputs)
            if pred is not None:
                return pred
        try:
            pred = original(module, trajectory, **inputs)
            if module is agent.react:
                selected = getattr(pred, "next_tool_name", "(missing)")
                argument_summary = arguments_shape(getattr(pred, "next_tool_args", None))
                trace.step("decision", f"main model selected {selected}; args={argument_summary}")
                tool_flow_log.info("AGENT TOOL DECISION chat=%s tool=%r args=%s",
                                   trace.chat_id[:8] or "-", selected, argument_summary)
            return pred
        except AdapterParseError as first:
            reply = " ".join(str(first.lm_response).split())[:160]
            log.warning("Malformed model reply, asking once more: %s", reply)
            trace.add("steps", f"! the model's reply was not in the expected shape: {reply!r}  ->  asking again once")
            try:
                pred = original(module, trajectory, **inputs, config={"temperature": RETRY_TEMPERATURE})
                if module is agent.react:
                    selected = getattr(pred, "next_tool_name", "(missing)")
                    argument_summary = arguments_shape(getattr(pred, "next_tool_args", None))
                    trace.step("decision", f"main model retry selected {selected}; args={argument_summary}")
                    tool_flow_log.info("AGENT TOOL DECISION chat=%s retry=true tool=%r args=%s",
                                       trace.chat_id[:8] or "-", selected, argument_summary)
                return pred
            except AdapterParseError as second:
                if module is agent.react:
                    trace.add("steps", "! still malformed: research stops here and the answer is written from "
                                       "what was found so far")
                    raise ValueError("the model could not produce a valid next step") from second
                raise

    agent._call_with_potential_trajectory_truncation = call
    return agent


_MULTI = re.compile(r"\b(compare|comparison|versus|vs\.?|differences? between|as well as|and also)\b|;|"
                    r"\n\s*(\d+[.)]|[-*])\s", re.IGNORECASE)


def looks_multipart(question: str) -> bool:
    """Cheap first check before asking the fast model to split: several subjects joined by and, commas or a list."""
    return bool(_MULTI.search(question)) or question.count(",") + len(re.findall(r"\band\b", question, re.I)) >= 2


def split_question(question: str, history: list[Turn], trace: ChatTrace) -> tuple[list[str], int, int]:
    """The parts of a multi-part question (fast model, one call), or [] to research it whole."""
    lm = fast_lm()
    try:
        with track_usage(lm) as usage, dspy.context(lm=lm):
            pred = dspy.Predict(SplitQuestion)(question=question, conversation=conversation_text(history, limit=4))
    except Exception as exc:
        trace.add("writer", f"split: the fast model failed ({type(exc).__name__}), so the question is researched whole")
        return [], 0, 0
    parts = [p.strip() for p in (pred.parts or []) if p and p.strip()][:MAX_PARTS]
    trace.add("writer", f"split: {len(parts)} part(s)" + (": " + " | ".join(parts) if parts and text_enabled() else "")
              + ("" if len(parts) >= 2 else ", so the question is researched whole"))
    return (parts if len(parts) >= 2 else []), usage.prompt_tokens, usage.completion_tokens


def _triage_detail(route: Triage) -> dict:
    """Who triaged, what Jev answered before our thresholds, and what the thresholds changed. Saved with the message."""
    return {"engine": route.engine, "jev": route.jev, "notes": route.notes}


def _trace_triage(trace: ChatTrace, route: Triage) -> None:
    """The triage section of the log: every Jev answer with its confidence, then what our thresholds did to it."""
    trace.add("triage", f"engine   : {route.engine or 'unknown'}")
    if route.jev:
        for qid in ("intent", "intent_retry1", "depth", "detail", "reuse", "memory", "topic"):
            a = route.jev.get(qid)
            if a:
                trace.add("triage", f"{qid:<9}: {a['choice']:<22} confidence {a['confidence']:.2f}   "
                                    f"[{probs_text(a['probabilities'])}]")
    else:
        trace.add("triage", "(a language model answered, so there are no probabilities or confidences)")
    trace.add("triage", "overrides: " + ("; ".join(route.notes) if route.notes
                                         else "none, the answers were used as given"))
    trace.add("triage", f"FINAL    : kind={route.kind} depth={route.depth} memory={route.memory} "
                        f"topic={route.topic or '-'} detail={route.detail} reuse={route.reuse}")
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
    on_delta: Callable[[str | None], None] | None = None,
    last_answer: LastAnswer | None = None,
    external_tools: list[dspy.Tool] | None = None,
    external_sources: list | None = None,
    external_widgets: list | None = None,
    external_aliases: set[str] | None = None,
    external_destinations: list[dict] | None = None,
    workspace_id=None,
    notebook_id=None,
) -> ResearchResult:
    """on_delta gets the answer text as it is written (None = take back what was sent, a different path writes it).
    The returned text is the verified answer, which replaces whatever was streamed."""
    history = history or []
    trace = trace or current_trace() or ChatTrace()  # a throwaway one when research() is called on its own
    external_tools = external_tools or []
    external_sources = external_sources if external_sources is not None else []
    external_widgets = external_widgets if external_widgets is not None else []
    external_destinations = external_destinations or []
    if not allowed and not external_tools:
        trace.add("route", "NO POSTS: the notebook has none, so a fixed reply was sent and no model was called")
        return ResearchResult("This notebook has no posts yet. Add some sources first.", True, [], kind="chitchat")

    canned = instant_reply(question, history)
    if canned:
        trace.add("route", "SMALL TALK: the message is only a greeting or thanks (regex), so a fixed reply was sent "
                           "and no model, Jev call or R2 read was needed")
        if context_log_enabled():
            context_log.info("=== CHAT CONTEXT === message %r is small talk: canned reply, no model call", question)
        return ResearchResult(canned, False, [], kind="chitchat", question=question)

    if delivery := previous_delivery_status(question, history):
        state, detail, url = delivery
        if state == "done" and url:
            trace.add("route", "PREVIOUS DELIVERY: returned the completed external destination URL")
            return ResearchResult(
                f"Here is the external destination: [Open it]({url})",
                False,
                [],
                kind="external_action",
                question=question,
                external_sources=[{"connection": "previous result", "tool": "conversation", "urls": [url]}],
            )
        if state == "working":
            trace.add("route", "PREVIOUS DELIVERY: still working; did not create a duplicate artifact")
            return ResearchResult(
                "The external destination is still being created. I’ll update the previous message with its "
                "destination link as soon as it finishes.",
                False,
                [],
                kind="external_action",
                question=question,
            )
        if state == "failed":
            trace.add("route", "PREVIOUS DELIVERY: failed; did not create a duplicate artifact")
            reason = detail or "The external destination could not be created."
            return ResearchResult(
                f"There is no external destination link because delivery failed: {reason}",
                True,
                [],
                kind="external_action",
                question=question,
            )

    if link := previous_created_link(question, history):
        trace.add("route", "PREVIOUS LINK: returned the URL already saved in the conversation; no model or tool call")
        return ResearchResult(
            f"Here it is: [Open the created page]({link})",
            False,
            [],
            kind="external_action",
            question=question,
            external_sources=[{"connection": "previous result", "tool": "conversation", "urls": [link]}],
        )

    if on_step:
        on_step("think", "Reading the conversation")
    # The posts sync (an R2 manifest check, usually skipped by the TTL) runs while triage decides what is needed.
    pool = ThreadPoolExecutor(max_workers=1)
    synced = pool.submit(contextvars.copy_context().run, corpus.sync, tuple(allowed))
    pool.shutdown(wait=False)
    with trace.stage("triage"):
        route = triage(question, history, notebook_brief(notebook_title, allowed), chat_memory)
    if route.kind == "off_topic" and route.engine == "jev":
        with trace.stage("recheck-off-topic"):
            try:
                synced.result()  # the openings are read from the synced posts
            except Exception:
                logging.getLogger(__name__).warning("Posts sync failed before the off topic recheck", exc_info=True)
            route = recheck_off_topic(route, question, history, notebook_brief_full(notebook_title, allowed, corpus))
    named_external_app = (
        names_external_app(question, external_aliases or set())
        if route.kind in {"create", "external_action"} and external_tools else None
    )
    external_only = (route.kind == "external_action" and bool(external_tools)) or bool(named_external_app)
    if named_external_app:
        # "generate a video using the blog2video plugin": the writer named a connected app, so its tools do the work
        # instead of the built-in feature that would only open its settings. This must also skip archive prefetch and
        # archive tools: the connected app, not a coincidental passage match, owns the request.
        route.notes.append(
            f"asks to make something, but names the connected app {named_external_app!r} -> external-only research"
        )
        route.kind, route.reply = "external_action", ""
    requested_artifact = compound_artifact_request(question) if external_only else None
    destination = compound_destination(named_external_app, external_destinations) if requested_artifact else None
    # A deterministic chain is used only for destinations whose exact artifact handoff we implement. Other connected
    # apps keep going through the external agent instead of being forced into a hard-coded integration.
    compound_artifact = requested_artifact if destination else None
    if compound_artifact and (workspace_id is None or notebook_id is None):
        trace.add("route", "COMPOUND ACTION: cannot create the NoteStack artifact without workspace/notebook scope")
        return ResearchResult(
            "I could not create the NoteStack artifact because this notebook context was unavailable.",
            True,
            [],
            kind="external_action",
            question=question,
        )
    _trace_triage(trace, route)
    if compound_artifact in TRANSFERABLE_ARTIFACTS and destination:
        adapter = str(destination["adapter"])
        destination_name = str(destination.get("name") or named_external_app or "the connected app")
        artifact_settings: dict = {}
        parse_prompt_tokens = parse_completion_tokens = 0
        try:
            action, _reply, parse_prompt_tokens, parse_completion_tokens = parse_create(
                question, conversation_text(history, limit=4),
            )
            if action and action.get("artifact") == compound_artifact:
                artifact_settings = action.get("settings") or {}
        except Exception:
            logging.getLogger(__name__).warning(
                "Could not parse settings for background %s; using Studio defaults", compound_artifact, exc_info=True,
            )
        page_url = None
        if destination.get("placeholder"):
            try:
                page_url = _create_notion_placeholder(
                    external_tools, external_sources, destination, question, compound_artifact,
                )
            except Exception:
                logging.getLogger(__name__).exception("Could not create the destination Notion page")
                return ResearchResult(
                    f"I could not create the {destination_name} destination, so I did not start the background artifact.",
                    True,
                    [],
                    kind="external_action",
                    question=question,
                )
        try:
            created = start_from_chat(
                workspace_id, notebook_id, notebook_title, compound_artifact, artifact_settings,
            )
        except Exception:
            logging.getLogger(__name__).exception("Could not start the background %s artifact", compound_artifact)
            destination_text = (
                f"The {destination_name} destination was created, but I could not start the NoteStack "
                f"{compound_artifact.replace('_', ' ')}.\n\n"
                f"- [Open it]({page_url})"
                if page_url else
                f"I could not start the NoteStack {compound_artifact.replace('_', ' ')}, so I did not create the "
                f"{destination_name} destination."
            )
            return ResearchResult(
                destination_text,
                True,
                [],
                kind="external_action",
                question=question,
            )
        label = compound_artifact.replace("_", " ")
        detail = (
            f"Created the {destination_name} destination; creating the NoteStack {label} in the background"
            if page_url else
            f"Creating the NoteStack {label}; {destination_name} delivery will follow automatically"
        )
        trace.add("route", "COMPOUND ACTION (BACKGROUND): " + detail)
        used_external = [
            {"connection": source.connection, "tool": source.tool,
             **({"urls": list(source.urls)} if source.urls else {})}
            for source in external_sources
        ]
        if page_url:
            reply = (
                f"The {destination_name} destination is ready. I’m creating the NoteStack {label} in the background "
                "and will add its exact content there when it is ready. I’ll update this message too.\n\n"
                f"- [Open it]({page_url})"
            )
        else:
            artifact_url = created.get("url")
            reply = (
                f"I’m creating the NoteStack {label} from this notebook’s posts. When it is ready, I’ll create the "
                f"{destination_name} destination from its exact content and update this message with the link."
                + (f"\n\n- [Open the NoteStack {label}]({artifact_url})" if artifact_url else "")
            )
        return ResearchResult(
            reply,
            False,
            [],
            route.prompt_tokens + parse_prompt_tokens,
            route.completion_tokens + parse_completion_tokens,
            steps=[("external", detail)],
            kind="external_action",
            question=question,
            recall={"route": _route_info(route), "triage_detail": _triage_detail(route)},
            created_artifacts=[created],
            background_action={
                "kind": "artifact_to_external",
                "artifact_id": created["id"],
                "artifact_type": compound_artifact,
                "artifact_url": created.get("url"),
                "adapter": adapter,
                "connection_id": destination.get("connection_id"),
                "destination_name": destination_name,
                **({"destination_url": page_url} if page_url else {}),
                "title": _page_title(question, compound_artifact),
                "question": question,
            },
            external_sources=used_external,
        )
    if route.kind == "create":
        action, reply, p_tok, c_tok = None, "", 0, 0
        with trace.stage("parse-create"):
            try:
                action, reply, p_tok, c_tok = parse_create(question, conversation_text(history, limit=4))
            except Exception:  # never fail the chat over it: the app help says where the Create panel is
                logging.getLogger(__name__).warning("Could not read the create request %r", question[:200], exc_info=True)
        recall = {"route": _route_info(route), "triage_detail": _triage_detail(route),
                  "memory_loaded": chat_memory is not None}
        prompt, completion = route.prompt_tokens + p_tok, route.completion_tokens + c_tok
        if action:
            trace.add("route", f"CREATE: opens the {action['artifact']} settings with {action['settings']} "
                               "(no research agent)")
            return ResearchResult(reply, False, [], prompt, completion, kind="create", question=question,
                                  recall={**recall, "action": action}, action=action)
        trace.add("route", "CREATE, but the request named nothing the app makes: the app help is sent instead")
        return ResearchResult(canned_reply("about_app", allowed), False, [], prompt, completion, kind="about_app",
                              question=question, recall=recall)
    if route.kind == "external_action" and not external_tools:
        reply = ("Connect and enable an external app that can handle this action, then try again. "
                 "I cannot perform it with notebook tools alone.")
        trace.add("route", "EXTERNAL ACTION: no external tools are enabled, so the research agent was not started")
        return ResearchResult(reply, True, [], route.prompt_tokens, route.completion_tokens,
                              kind="external_action", question=question,
                              recall={"route": _route_info(route), "triage_detail": _triage_detail(route),
                                      "memory_loaded": chat_memory is not None})
    if route.kind not in {"archive", "external_action"}:
        # App help is always the vetted template: a model would invent product facts.
        if context_log_enabled():
            context_log.info("=== CHAT CONTEXT === message %r triaged as %s: answered without the research agent",
                             question, route.kind)
        reply = canned_reply(route.kind, allowed) if route.kind == "about_app" or not route.reply else route.reply
        source = "a fixed template" if route.kind == "about_app" or not route.reply else "the triage model's reply"
        trace.add("route", f"{route.kind.upper()}: triage decided this needs no research, so the reply is {source} "
                           "(no research agent, no post reads; the posts sync started next to triage is not awaited)")
        trace.add("result", f"reply {len(reply)} chars | "
                            f"tokens (triage): {route.prompt_tokens}/{route.completion_tokens}")
        return ResearchResult(reply, False, [], route.prompt_tokens, route.completion_tokens,
                              kind=route.kind, question=question,
                              recall={"route": _route_info(route), "triage_detail": _triage_detail(route),
                                      "memory_loaded": chat_memory is not None})

    trace.add("route", (f"COMPOUND ACTION: create a real NoteStack {compound_artifact} artifact first, then pass its "
                        "exact content to the enabled external tool" if compound_artifact else
                       "EXTERNAL ACTION: Jev selected a connected-app action, so only enabled external tools are "
                        "given to the research agent" if external_only else
                       "ARCHIVE: the message needs the writer's posts, so the research agent runs"))
    if external_only:
        # The sync was already started beside triage, but an external action needs no notebook context. Let it finish
        # in the background instead of adding R2/post latency before the external tool can run.
        manifest = {}
        trace.add("context", "external action does not wait for the background posts sync")
    else:
        with trace.stage("sync-posts(wait)"):
            manifest = synced.result() or {}
    steps: list[tuple[str, str]] = []

    def log(kind: str, detail: str) -> None:
        steps.append((kind, detail))
        trace.step(kind, detail)
        if on_step:
            on_step(kind, detail)

    if external_only:
        log("external", "Using enabled external tools")

    tools = ScopedTools(corpus, allowed, on_step=log)
    stream = _Stream(on_delta, trace) if settings.chat_stream_answers else None
    extra_prompt = extra_completion = 0  # model calls outside the agent: the question split
    trace.start_agent()  # step offsets in the log count from here
    notes, with_chat_tools = ("", False)
    if chat_memory is not None:
        with trace.stage("build-memory"):
            notes, with_chat_tools = build_context(chat_memory, route.topic, route.memory)
        if notes or with_chat_tools:
            log("think", "Recalling earlier in this chat")
    chat_tools = ChatTools(chat_memory.corpus, on_step=log) if chat_memory is not None and with_chat_tools else None
    budget = min(QUICK_STEPS, settings.research_max_steps) if route.depth == "quick" else settings.research_max_steps
    created_artifacts: list[dict] = []
    if external_only:
        # Jev decides only whether the notebook is relevant. Once it has ruled the notebook out, do not let the
        # agent fall back to archive tools; the ReAct model chooses the matching enabled external tool.
        tool_list = list(external_tools)
    else:
        tool_list = [tools.list_files, tools.search, tools.read] if allowed else []
        if chat_tools:
            tool_list += [chat_tools.list_chat_topics, chat_tools.search_chats, chat_tools.read_chat]
        tool_list += external_tools
    inputs = dict(question=external_question(route.question) if external_only else route.question,
                  conversation=conversation_text(history),
                  archive_guide=archive_guide(tools), writer_profile=profile or "(none)", answer_length=route.detail,
                  prefetched="(none)")
    if external_only:
        signature = ResearchExternal
    elif notes or chat_tools:
        signature, inputs["chat_memory"] = ResearchArchiveWithMemory, notes or "(nothing filed yet)"
    else:
        signature = ResearchArchive
    lm = main_lm()
    recall = {
        "route": _route_info(route),
        "triage_detail": _triage_detail(route),
        "memory_loaded": chat_memory is not None,
        "memory_notes": notes[:4000],  # exactly what the agent was shown from earlier chats
        "chat_tools": chat_tools is not None,
        "chat_topics": [e.slug for e in chat_memory.tf.entries] if chat_memory is not None else [],
    }

    def finish(answer: str, proposed_cites, model_unsupported: bool, path: str, agent_prompt: int = 0,
               agent_completion: int = 0) -> ResearchResult:
        with trace.stage("verify"):
            text, cites = verify_citations(tools, answer, proposed_cites or [], chat_tools)
        used_external = [
            {
                "connection": source.connection,
                "tool": source.tool,
                **({"urls": list(source.urls)} if getattr(source, "urls", None) else {}),
            }
            for source in external_sources
        ]
        used_widgets = [widget.as_dict() for widget in external_widgets]
        unsupported = bool(model_unsupported) or (not cites and not used_external and not created_artifacts)
        refused = False
        if not cites and not used_external and not model_unsupported and not created_artifacts:
            # The model answered without anything we could verify: do not pass it off as grounded.
            text = ("I could not complete that with the connected apps, so I would rather not guess."
                    if external_only else
                    "I could not find support for that in these posts, so I would rather not guess.")
            refused = True
        text = _append_external_resource_links(text, used_external)
        for artifact in created_artifacts:
            url = str(artifact.get("url") or "")
            if url and url not in text:
                text = text.rstrip() + f"\n\n- [Open the {artifact.get('type', 'artifact')} in NoteStack]({url})"
        proposed = proposed_cites or []
        kept = {(c.path, c.line_start) for c in cites}
        dropped = [c for c in proposed if (c.path, c.line_start) not in kept]
        trace.add("citations",
                  f"the model proposed {len(proposed)}, verified {len(cites)} "
                  f"(posts {sum(1 for c in cites if not is_chat_path(c.path))}, "
                  f"earlier chats {sum(1 for c in cites if is_chat_path(c.path))}), dropped {len(dropped)}",
                  *[f"dropped: {c.path}:{c.line_start}-{c.line_end} (file not allowed here, or lines do not exist)"
                    for c in dropped[:6]])
        writer_prompt = stream.prompt_tokens if stream else 0
        writer_completion = stream.completion_tokens if stream else 0
        trace.add("result",
                  f"answer {len(text)} chars via {path} | unsupported={unsupported} | "
                  f"tokens prompt/completion: triage {route.prompt_tokens}/{route.completion_tokens}, "
                  f"agent {agent_prompt}/{agent_completion}"
                  + (f", writer {writer_prompt}/{writer_completion}" if stream else "")
                  + (f", split {extra_prompt}/{extra_completion}" if extra_prompt or extra_completion else ""),
                  *(["the model gave no verifiable citation, so the answer was replaced with the 'could not find "
                     "support' message"] if refused else []))
        return ResearchResult(
            text=strip_em_dashes(text),
            unsupported=unsupported,
            citations=cites,
            prompt_tokens=agent_prompt + route.prompt_tokens + writer_prompt + extra_prompt,
            completion_tokens=agent_completion + route.completion_tokens + writer_completion + extra_completion,
            steps=steps,
            kind="external_action" if external_only else "archive",
            question=route.question,
            recall={**recall, "path": path},
            topic=(stream.topic if stream and not refused else ""),
            external_sources=used_external,
            external_widgets=used_widgets,
            created_artifacts=list(created_artifacts),
        )

    # 1. Only reshape the previous answer ("make it shorter"): one streamed call over what it already cited.
    if stream and route.reuse == "rewrite_last" and last_answer and last_answer.citations:
        log("think", "Reworking the last answer")
        evidence = ("The assistant's previous answer:\n" + last_answer.text + "\n\nThe passages it cited (cite these "
                    "paths and line ranges again):\n\n" + "\n\n".join(
                        f"{c.path} lines {c.line_start}-{c.line_end}\n{c.quote}" for c in last_answer.citations))
        with trace.stage("rewrite"):
            res = stream.write(inputs, evidence, route.detail, "rewrite of the last answer", stop_if_uncovered=True)
        if res is not None:
            result = finish(res.answer, res.citations, res.unsupported, "rewrite")
            if result.citations:
                trace.add("writer", "rewrite: the previous answer was reshaped with no new research")
                return result
            stream.reset()
            trace.add("writer", "rewrite: no citation survived verification -> full research")
            steps.clear()
            trace.sections.pop("citations", None)
            trace.sections.pop("result", None)

    # 2. Keyword prefetch: the best passages go to the agent (and the writer) before any model call. A follow up
    # ("explain how to use it") is searched together with the question before it, which names what "it" is.
    query = route.question
    earlier = next((t.text for t in reversed(history) if t.role == "user"), "")
    if earlier and refers_back(route.question):
        query = f"{route.question} {earlier}"
    deep = route.depth == "deep"
    pre = None
    if not external_only:
        with trace.stage("prefetch"):
            try:
                pre = prefetch(corpus, allowed, manifest, query, *((DEEP_TOP_K, DEEP_PER_POST) if deep else ()))
            except Exception:  # a ranking problem only costs the head start
                logging.getLogger(__name__).warning("Prefetch failed", exc_info=True)
                pre = None
    else:
        trace.add("context", "archive prefetch skipped: Jev classified the request as an external action, "
                  "so only enabled external tools are available")
    if pre is not None:
        inputs["prefetched"] = pre.text
        trace.add("context", f"prefetch: {len(pre.passages)} passage(s) from "
                             f"{len({p.path for _, p in pre.passages})} post(s), the question's words covered "
                             f"{pre.coverage:.0%} ({len(pre.terms)} of {len(pre.asked)} content word(s) occur in the "
                             f"posts), top score {pre.top_score:.2f}"
                             + (f", {pre.for_coverage} picked to cover a word the top passages lacked"
                                if pre.for_coverage else "")
                             + (f", +{len(pre.added)} passage(s) from the same sections so topics arrive whole"
                                if pre.added else "")
                             + (", searched with the previous question" if query != route.question else "")
                             + "  [BM25 over the local disk cache]")

    if context_log_enabled():
        context_log.info(context_banner(chat_memory, route.topic, route.memory, inputs.get("chat_memory", "")))
        context_log.info(describe_context(question, route, inputs, signature,
                                          [getattr(t, "name", getattr(t, "__name__", type(t).__name__))
                                           for t in tool_list],
                                          chat_memory, chat_tools is not None))
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
              f"up to {budget} reasoning steps ({route.depth}) | answer length {route.detail}",
              f"tools    : {', '.join(getattr(t, 'name', getattr(t, '__name__', type(t).__name__)) for t in tool_list)}",
              f"question : {len(inputs['question'])} chars ("
              + ("the writer's raw message: Jev does not rewrite it" if route.engine == "jev"
                 else "rewritten as a standalone question by the triage model") + ")",
              f"conversation: {turns} turn(s), {len(inputs['conversation'])} chars  [Postgres, last messages]",
              f"writer notes: {len([ln for ln in profile.splitlines() if ln.strip()]) if profile else 0} line(s), "
              f"{len(profile)} chars  [Postgres WorkspaceMemory]",
              f"archive guide: {len(inputs['archive_guide'])} chars  [built in code]",
              memory_line)
    if external_tools:
        definitions = [str(tool) for tool in external_tools]
        trace.add("context", f"external definitions: {len(definitions)} tool(s), "
                  f"{sum(len(item) for item in definitions)} compact characters",
                  *[f"external[{index}]: {definition}" for index, definition in enumerate(definitions, start=1)])

    # 3. Overview: a question about the notebook as a whole (no subject to search for) is answered in one call from
    # the post list and the opening passage of the newest posts.
    one_call = (not external_only and stream is not None and settings.chat_fast_path
                and route.detail != "in_depth" and chat_tools is None)
    if one_call and pre is not None and pre.overview:
        listing = tools.list_files()  # shows as the one step: scanning the archive
        listed = [(row.split("|")[1].strip(), row.split("|")[2].strip()) for row in listing.splitlines()
                  if row.count("|") >= 2]
        evidence = (f"The notebook's posts, newest first (date | path | title | headings):\n"
                    f"{listing[:OVERVIEW_LIST_CHARS]}\n\nThe opening passage of the newest posts (citable, with line "
                    f"numbers):\n\n{openings(corpus, listed, OVERVIEW_BUDGET_CHARS)}")
        with trace.stage("overview"):
            res = stream.write(inputs, evidence, route.detail, "overview", stop_if_uncovered=True)
        if res is not None and not res.unsupported:
            result = finish(res.answer, res.citations, res.unsupported, "overview")
            if result.citations:
                trace.add("writer", "overview path: hit, one model call over the post list and openings, no agent")
                return result
            trace.sections.pop("citations", None)
            trace.sections.pop("result", None)
        stream.reset()
        trace.add("writer", "overview path: miss (the openings did not answer it) -> research agent")

    # 4. Fast path: a question the prefetch clearly covers is answered in one call, no agent.
    elif (one_call and pre is not None and pre.passages and pre.coverage >= FAST_PATH_MIN_COVERAGE):
        log("think", "Found matching passages")
        with trace.stage("fast-path"):
            res = stream.write(inputs, "(no research steps: answer from the prefetched passages above)",
                               route.detail, "fast path", stop_if_uncovered=True)
        if res is not None and not res.unsupported:
            result = finish(res.answer, res.citations, res.unsupported, "fast path")
            if result.citations:
                trace.add("writer", f"fast path: hit (coverage {pre.coverage:.0%}, {len(pre.passages)} passages), "
                                "one model call and no agent")
                return result
            trace.sections.pop("citations", None)
            trace.sections.pop("result", None)
        stream.reset()
        trace.add("writer", "fast path: miss (the passages did not answer it) -> research agent")
    elif stream and settings.chat_fast_path and pre is not None:
        trace.add("writer", f"fast path: not tried (detail={route.detail}, coverage {pre.coverage:.0%}, "
                            f"chat tools {'given' if chat_tools else 'not given'})")

    # 5. A question about several separate subjects: research the parts at once, then write one answer.
    if (stream and settings.chat_parallel_parts and route.depth == "deep" and chat_tools is None
            and not external_tools
            and looks_multipart(route.question)):
        with trace.stage("split"):
            parts, extra_prompt, extra_completion = split_question(route.question, history, trace)
        if parts:
            part_budget = max(2, budget // 2)

            def research_part(n: int, part: str) -> str:
                part_tools = ScopedTools(corpus, allowed, on_step=lambda k, d: log(k, f"[{n}] {d}"))
                captured: dict[str, str] = {}

                def capture(agent, trajectory, _inputs):
                    captured["t"] = agent._format_trajectory(trajectory)
                    return dspy.Prediction(answer="", citations=[], unsupported=False)

                agent = _retry_malformed_steps(
                    dspy.ReAct(signature, tools=[part_tools.list_files, part_tools.search, part_tools.read],
                               max_iters=part_budget), trace, capture)
                with dspy.context(lm=lm):
                    agent(**{**inputs, "question": part})
                return captured.get("t", "(nothing found)")

            with trace.stage("agent(parts)"), track_usage(lm) as usage:
                with ThreadPoolExecutor(max_workers=max(1, min(len(parts), settings.llm_max_concurrent))) as ex:
                    futures = [ex.submit(contextvars.copy_context().run, research_part, n, part)
                               for n, part in enumerate(parts, start=1)]
                    found = []
                    for n, (part, f) in enumerate(zip(parts, futures, strict=True), start=1):
                        try:
                            found.append(f"### Part {n}: {part}\n{f.result()}")
                        except Exception as exc:
                            trace.add("writer", f"part {n}: research failed ({type(exc).__name__})")
                            found.append(f"### Part {n}: {part}\n(research failed, nothing found)")
            trace.add("writer", f"parts: {len(parts)} researched in parallel, up to {part_budget} steps each")
            with trace.stage("write(parts)"):
                res = stream.write(inputs, "\n\n".join(found), route.detail, "answer over all parts")
            if res is not None:
                return finish(res.answer, res.citations, res.unsupported, "parallel parts",
                              usage.prompt_tokens, usage.completion_tokens)
            trace.add("writer", "parts: the combined answer failed -> one research agent over the whole question")

    # 6. The research agent; its answer step is the streamed writer when streaming is on.
    agent = _retry_malformed_steps(dspy.ReAct(signature, tools=tool_list, max_iters=budget), trace,
                                   stream.extractor(route.detail) if stream else None)
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
    return finish(pred.answer, pred.citations, pred.unsupported, "research agent",
                  usage.prompt_tokens, usage.completion_tokens)

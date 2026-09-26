"""Agentic research over the file system corpus: the model explores files with list/search/read,
then every citation is checked against the real file before it reaches the writer.

Cost control: every message is triaged first. Greetings and thanks are answered from a phrase list
(no model call). Everything else gets one cheap call on the fast model that reads the recent
conversation, answers off topic and app questions directly, and turns follow ups into standalone
questions. Only real archive questions run the research agent, with a small step budget for simple
lookups and the full budget for synthesis."""

import re
from collections.abc import Callable
from dataclasses import dataclass, field

import dspy

from app.config import settings
from app.corpus import Corpus, ScopedTools
from app.llm.postprocess import strip_em_dashes
from app.llm.provider import main_lm, track_usage, triage_lm
from app.llm.signatures import ResearchArchive, TriageMessage

_MARKER = re.compile(r"\[(\d+)\]")


@dataclass
class VerifiedCitation:
    marker: int
    path: str
    line_start: int
    line_end: int
    quote: str


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


@dataclass
class Turn:
    role: str  # user | assistant
    text: str


HISTORY_TURNS = 8
QUICK_STEPS = 4

_CHITCHAT = re.compile(
    r"^\s*(hi|hey|hello|yo|hiya|good (morning|afternoon|evening)|thanks|thank you|thx|ty|cheers|ok(ay)?|"
    r"cool|great|nice|awesome|perfect|got it|sounds good|bye|goodbye|see you|lol|haha)[\s!.,:)]*$",
    re.IGNORECASE,
)
_GREETING = re.compile(r"^\s*(hi|hey|hello|yo|hiya|good (morning|afternoon|evening))", re.IGNORECASE)
_BYE = re.compile(r"^\s*(bye|goodbye|see you)", re.IGNORECASE)


def conversation_text(history: list[Turn], limit: int = HISTORY_TURNS) -> str:
    """Last few turns, citation markers stripped, each trimmed, so the prompt stays small."""
    if not history:
        return "(new conversation)"
    lines = []
    for t in history[-limit:]:
        text = _MARKER.sub("", t.text).strip()
        if len(text) > 700:
            text = text[:700].rsplit(" ", 1)[0] + " ..."
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


def triage(message: str, history: list[Turn], notebook: str) -> Triage:
    """One cheap call: is this worth researching, and what exactly should be researched?"""
    lm = triage_lm()
    try:
        with track_usage(lm) as usage, dspy.context(lm=lm):
            pred = dspy.Predict(TriageMessage)(conversation=conversation_text(history), message=message,
                                               notebook=notebook)
    except Exception:
        # If triage fails, fall back to researching the raw message rather than failing the chat.
        return Triage("archive", message, "deep", "")
    kind = pred.kind if pred.kind in {"archive", "chitchat", "about_app", "off_topic"} else "archive"
    question = (pred.standalone_question or "").strip() or message
    reply = strip_em_dashes((pred.reply or "").strip())
    if kind != "archive" and not reply:
        kind = "archive"  # nothing to say without research: research it
    return Triage(kind, question, pred.depth if pred.depth in {"quick", "deep"} else "deep", reply,
                  usage.prompt_tokens, usage.completion_tokens)


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


def verify_citations(tools: ScopedTools, answer: str, citations) -> tuple[str, list[VerifiedCitation]]:
    """Keep only citations that point at real lines, renumber them 1..n, and drop dangling markers."""
    verified: list[VerifiedCitation] = []
    remap: dict[int, int] = {}
    for c in sorted(citations, key=lambda c: c.marker):
        if c.marker in remap:
            continue
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
    return text.strip(), verified


def research(
    corpus: Corpus,
    allowed: dict[str, str],
    question: str,
    on_step: Callable[[str, str], None] | None = None,
    history: list[Turn] | None = None,
    notebook_title: str = "",
) -> ResearchResult:
    history = history or []
    if not allowed:
        return ResearchResult("This notebook has no posts yet. Add some sources first.", True, [], kind="chitchat")

    canned = instant_reply(question, history)
    if canned:
        return ResearchResult(canned, False, [], kind="chitchat", question=question)

    if on_step:
        on_step("think", "Reading the conversation")
    route = triage(question, history, notebook_brief(notebook_title, allowed))
    if route.kind != "archive":
        return ResearchResult(route.reply, False, [], route.prompt_tokens, route.completion_tokens,
                              kind=route.kind, question=question)

    corpus.sync()
    steps: list[tuple[str, str]] = []

    def log(kind: str, detail: str) -> None:
        steps.append((kind, detail))
        if on_step:
            on_step(kind, detail)

    tools = ScopedTools(corpus, allowed, on_step=log)
    budget = min(QUICK_STEPS, settings.research_max_steps) if route.depth == "quick" else settings.research_max_steps
    agent = dspy.ReAct(
        ResearchArchive,
        tools=[tools.list_files, tools.search, tools.read],
        max_iters=budget,
    )
    lm = main_lm()
    with track_usage(lm) as usage, dspy.context(lm=lm):
        pred = agent(question=route.question, conversation=conversation_text(history),
                     archive_guide=archive_guide(tools))

    text, cites = verify_citations(tools, pred.answer, pred.citations or [])
    unsupported = bool(pred.unsupported) or not cites
    if not cites and not pred.unsupported:
        # The model answered without anything we could verify: do not pass it off as grounded.
        text = "I could not find support for that in these posts, so I would rather not guess."
    return ResearchResult(
        text=strip_em_dashes(text),
        unsupported=unsupported,
        citations=cites,
        prompt_tokens=usage.prompt_tokens + route.prompt_tokens,
        completion_tokens=usage.completion_tokens + route.completion_tokens,
        steps=steps,
        kind="archive",
        question=route.question,
    )

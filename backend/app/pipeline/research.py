"""Agentic research over the file system corpus: the model explores files with list/search/read,
then every citation is checked against the real file before it reaches the writer."""

import re
from collections.abc import Callable
from dataclasses import dataclass, field

import dspy

from app.config import settings
from app.corpus import Corpus, ScopedTools
from app.llm.postprocess import strip_em_dashes
from app.llm.provider import main_lm, track_usage
from app.llm.signatures import ResearchArchive

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
) -> ResearchResult:
    if not allowed:
        return ResearchResult("This notebook has no posts yet. Add some sources first.", True, [])
    corpus.sync()
    steps: list[tuple[str, str]] = []

    def log(kind: str, detail: str) -> None:
        steps.append((kind, detail))
        if on_step:
            on_step(kind, detail)

    tools = ScopedTools(corpus, allowed, on_step=log)
    agent = dspy.ReAct(
        ResearchArchive,
        tools=[tools.list_files, tools.search, tools.read],
        max_iters=settings.research_max_steps,
    )
    lm = main_lm()
    with track_usage(lm) as usage, dspy.context(lm=lm):
        pred = agent(question=question, archive_guide=archive_guide(tools))

    text, cites = verify_citations(tools, pred.answer, pred.citations or [])
    unsupported = bool(pred.unsupported) or not cites
    if not cites and not pred.unsupported:
        # The model answered without anything we could verify: do not pass it off as grounded.
        text = "I could not find support for that in these posts, so I would rather not guess."
    return ResearchResult(
        text=strip_em_dashes(text),
        unsupported=unsupported,
        citations=cites,
        prompt_tokens=usage.prompt_tokens,
        completion_tokens=usage.completion_tokens,
        steps=steps,
    )

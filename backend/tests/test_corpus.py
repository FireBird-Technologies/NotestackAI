import uuid
from datetime import UTC, datetime

import pytest

from app.corpus import INDEX, Corpus, CorpusError, ScopedTools, index_line, post_path, render_post
from app.llm.signatures import FileCitation
from app.pipeline.research import verify_citations


class MemoryStore:
    """Stands in for R2."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def put_text(self, key, text, content_type=None):
        self.objects[key] = text.encode()
        return key

    def get_bytes(self, key):
        return self.objects[key]

    def exists(self, key):
        return key in self.objects

    def delete(self, key):
        self.objects.pop(key, None)


PRICING = [("Why I raised prices", "I moved the paid tier from $5 to $8 a month.\n\nChurn stayed flat."),
           ("What readers said", "Most readers told me the archive alone was worth it.")]
HABITS = [(None, "I write every morning before email.")]


@pytest.fixture()
def corpus_pair(tmp_path):
    store = MemoryStore()
    ws = uuid.uuid4()
    writer = Corpus(ws, store=store, cache_dir=str(tmp_path / "worker"))
    d1 = datetime(2026, 3, 1, tzinfo=UTC)
    d2 = datetime(2025, 11, 9, tzinfo=UTC)
    p1 = post_path("ada-substack-com", "On pricing", "https://ada.substack.com/p/on-pricing", d1)
    p2 = post_path("ada-substack-com", "Habits", "https://ada.substack.com/p/habits", d2)
    writer.write_files({
        p1: render_post(
            title="On pricing", url="https://x/p/on-pricing", published_at=d1, source="ada", sections=PRICING
        ),
        p2: render_post(title="Habits", url="https://x/p/habits", published_at=d2, source="ada", sections=HABITS),
        INDEX: "\n".join([index_line(p1, "On pricing", d1, ["Why I raised prices"]), index_line(p2, "Habits", d2, [])]),
    })
    # A different process (the API container) with an empty cache
    reader = Corpus(ws, store=store, cache_dir=str(tmp_path / "api"))
    reader.sync()
    return reader, p1, p2


def test_paths_are_stable_and_readable():
    p = post_path("ada-substack-com", "Any Title", "https://ada.substack.com/p/on-pricing/", datetime(2026, 3, 1))
    assert p == "sources/ada-substack-com/2026-03-01-on-pricing.md"


def test_sync_mirrors_r2_into_a_fresh_cache(corpus_pair):
    reader, p1, _ = corpus_pair
    assert reader.exists(p1) and reader.exists(INDEX)
    assert "# On pricing" in reader.read_lines(p1)


def test_tools_search_read_and_scope(corpus_pair):
    reader, p1, p2 = corpus_pair
    steps = []
    tools = ScopedTools(reader, {p1: "On pricing"}, on_step=lambda k, d: steps.append(k))

    listing = tools.list_files()
    assert p1 in listing and p2 not in listing  # notebook scope hides other posts

    hits = tools.search(r"paid tier|price")
    assert f"{p1}:" in hits and "$5 to $8" in hits
    assert "Habits" not in hits

    body = tools.read(p1, 1, 5)
    assert "1| ---" in body

    with pytest.raises(CorpusError):
        tools.read(p2)  # outside the notebook
    with pytest.raises(CorpusError):
        tools.read("../../etc/passwd")
    assert tools.search("(unclosed")  # bad regex falls back to a literal search
    assert steps[:3] == ["list", "search", "read"]


def test_verify_citations_drops_fakes_and_renumbers(corpus_pair):
    reader, p1, p2 = corpus_pair
    tools = ScopedTools(reader, {p1: "On pricing"})
    line = next(i for i, t in enumerate(reader.read_lines(p1), 1) if "$5 to $8" in t)
    cites = [
        FileCitation(marker=1, path=p2, line_start=1, line_end=3),          # out of scope
        FileCitation(marker=2, path=p1, line_start=line, line_end=line),   # real
        FileCitation(marker=3, path=p1, line_start=9999, line_end=10000),  # past end of file
    ]
    text, verified = verify_citations(tools, "Habits matter [1]. Prices went to $8 [2]. Churn fell [3].", cites)
    assert [c.marker for c in verified] == [1]
    assert "$5 to $8" in verified[0].quote
    assert text == "Habits matter. Prices went to $8 [1]. Churn fell."


def test_react_agent_end_to_end_with_scripted_model(corpus_pair, monkeypatch):
    """Drives the real dspy.ReAct loop with a fake LM: search, read, then answer with a citation."""
    import dspy
    from dspy.utils.dummies import DummyLM

    import app.pipeline.research as research_mod

    reader, p1, _ = corpus_pair
    line = next(i for i, t in enumerate(reader.read_lines(p1), 1) if "$5 to $8" in t)
    lm = DummyLM([
        {"next_thought": "Search for pricing.", "next_tool_name": "search", "next_tool_args": {"pattern": "paid tier"}},
        {"next_thought": "Read the post.", "next_tool_name": "read",
         "next_tool_args": {"path": p1, "start_line": 1, "end_line": 30}},
        {"next_thought": "I have what I need.", "next_tool_name": "finish", "next_tool_args": {}},
        {"reasoning": "The post states the new price.",
         "answer": "You raised the paid tier from $5 to $8 a month [1].",
         "citations": [{"marker": 1, "path": p1, "line_start": line, "line_end": line}],
         "unsupported": False},
    ])
    monkeypatch.setattr(research_mod, "main_lm", lambda: lm)
    monkeypatch.setattr(research_mod, "track_usage", _no_usage)
    monkeypatch.setattr(research_mod, "triage", lambda *a: research_mod.Triage("archive", "What did I charge?",
                                                                                "deep", ""))
    seen = []
    with dspy.context(adapter=dspy.ChatAdapter()):
        result = research_mod.research(
            reader, {p1: "On pricing"}, "What did I charge?", on_step=lambda k, d: seen.append(k)
        )
    assert seen == ["think", "search", "read"]
    assert result.unsupported is False
    assert result.text.endswith("[1].")
    assert result.citations[0].path == p1 and "$5 to $8" in result.citations[0].quote


class _Usage:
    prompt_tokens = completion_tokens = 0


from contextlib import contextmanager  # noqa: E402


@contextmanager
def _no_usage(lm):
    yield _Usage()


def test_long_messages_keep_their_start_and_end():
    from app.pipeline.research import HISTORY_CHARS, Turn, conversation_text, shorten

    assert shorten("short and sweet") == "short and sweet"
    text = "OPENING " + "middle words " * 200 + "CLOSING?"
    out = shorten(text)
    assert out.startswith("OPENING") and out.endswith("CLOSING?") and " ... " in out
    assert "middle words" in out and len(out) < len(text) and len(out) <= HISTORY_CHARS + 5
    assert shorten("x" * 5000).count("...") == 1  # no spaces to cut on: still bounded
    assert len(shorten("x" * 5000)) <= HISTORY_CHARS + 5

    long_answer = "First [1] " + "point " * 300 + "Want more?"
    history = [Turn("user", "Compare my pricing posts"), Turn("assistant", long_answer)]
    lines = conversation_text(history).splitlines()
    assert lines[0] == "Writer: Compare my pricing posts"  # short messages are untouched
    assert lines[1].startswith("Assistant: First") and lines[1].endswith("Want more?") and "[1]" not in lines[1]
    assert "..." not in lines[1]  # the newest two messages are kept whole


def test_only_the_newest_two_messages_stay_whole():
    from app.pipeline.research import HISTORY_CHARS, RECENT_CHARS, Turn, conversation_text

    body = "start " + "filler " * 300 + "end"
    history = [Turn("user" if i % 2 == 0 else "assistant", f"m{i} {body}") for i in range(6)]
    lines = conversation_text(history).splitlines()
    assert len(lines) == 6
    assert all("..." in line and len(line) <= HISTORY_CHARS + 20 for line in lines[:4])  # older: head and tail
    assert all("..." not in line and line.endswith("end") for line in lines[4:])  # newest two: whole
    assert len(conversation_text(history, limit=3).splitlines()) == 3  # the window still applies

    huge = [Turn("user", "q"), Turn("assistant", "word " * 5000)]
    assert len(conversation_text(huge).splitlines()[1]) <= RECENT_CHARS + 30  # even the newest are bounded

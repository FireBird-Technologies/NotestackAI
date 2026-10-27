"""Chat speed: the streamed answer writer, answer length, the posts sync TTL, the keyword prefetch and fast path, the
answer cache, reshaping the last answer without research, and researching the parts of a question at once."""

import json
import re
import uuid
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.config import settings
from app.corpus import Corpus
from app.llm.signatures import FileCitation
from app.pipeline import prefetch as pf
from app.pipeline import research as r
from app.pipeline import writer as w
from app.pipeline.trace import ChatTrace
from app.services import jev

POST = """---
title: On Pricing
---

# On Pricing

Raise prices once a year and tell readers why.
A paid tier works best when the free tier stays generous.
"""
OTHER = """---
title: Hiring
---

# Hiring

Hire slowly and write down what the role is for.
"""


# The writer


def _chunks(*texts, usage=(100, 40), finish="stop"):
    out = [SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=t), finish_reason=None)], usage=None)
           for t in texts]
    out.append(SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=None), finish_reason=finish)],
                               usage=SimpleNamespace(prompt_tokens=usage[0], completion_tokens=usage[1])))
    return out


@pytest.fixture()
def fake_writer_lm(monkeypatch):
    monkeypatch.setattr(w, "writer_lm", lambda: SimpleNamespace(model="m", kwargs={"max_tokens": 16000}))


def test_the_sentinel_never_leaks_even_when_split_across_chunks():
    shown = []
    f = w.SentinelFilter(shown.append)
    for piece in ["Prices go up [1].\n<<<CIT", "ATIONS>>>\n{\"citations\": []", ", \"unsupported\": false}"]:
        f.feed(piece)
    f.close()
    assert "".join(shown) == "Prices go up [1].\n" and "<<<" not in "".join(shown)
    assert json.loads(f.tail) == {"citations": [], "unsupported": False}
    g = w.SentinelFilter(shown.append)
    g.feed("no citations line at all")
    with pytest.raises(w.WriterError):
        g.close()


def test_the_citations_tail_is_parsed_or_rejected():
    cites, unsupported, _ = w.parse_tail('\n```json\n{"citations": [{"marker": 1, "path": "a.md", "line_start": 3, '
                                      '"line_end": 4}], "unsupported": false}\n```')
    assert cites == [FileCitation(marker=1, path="a.md", line_start=3, line_end=4)] and unsupported is False
    for garbage in ["", "not json", '{"citations": [{"marker": "x"}]}']:
        with pytest.raises(w.WriterError):
            w.parse_tail(garbage)


def test_stream_answer_streams_text_caps_tokens_by_length_and_counts_usage(monkeypatch, fake_writer_lm):
    seen = {}

    def completion(**kw):
        seen.update(kw)
        return iter(_chunks("Raise prices ", "yearly [1]. ", "Done.\n<<<CITATIONS>>>\n",
                            '{"citations": [{"marker": 1, "path": "a.md", "line_start": 7, "line_end": 7}]}'))

    monkeypatch.setattr(w, "_completion", completion)
    shown = []
    res = w.stream_answer({"question": "q", "prefetched": "a.md lines 7-7"}, "evidence", shown.append, "standard")
    assert res.answer == "Raise prices yearly [1]. Done." and len(res.citations) == 1 and res.chunks >= 1
    assert (res.prompt_tokens, res.completion_tokens) == (100, 40)
    assert seen["stream"] is True and seen["max_tokens"] == w.WRITER_MAX_TOKENS["standard"]
    assert "## Answer length\nstandard" in seen["messages"][1]["content"] and "a.md lines 7-7" in seen["messages"][1]["content"]
    w.stream_answer({"question": "q"}, "e", shown.append, "in_depth")
    assert seen["max_tokens"] == 16000  # in depth keeps the model's own cap


def test_an_answer_cut_off_by_the_cap_is_an_error(monkeypatch, fake_writer_lm):
    monkeypatch.setattr(w, "_completion", lambda **kw: iter(_chunks("half an answer", finish="length")))
    with pytest.raises(w.WriterError, match="token cap"):
        w.stream_answer({"question": "q"}, "e", lambda t: None)


def test_a_failed_write_takes_back_the_draft_and_falls_back_to_the_agents_own_answer(monkeypatch):
    def broken(inputs, evidence, on_delta, length="standard", stop_if_uncovered=False):
        on_delta("Half an ans")
        raise w.WriterError("garbled")

    monkeypatch.setattr(w, "stream_answer", broken)
    deltas = []
    trace = ChatTrace()
    stream = r._Stream(deltas.append, trace)
    agent = SimpleNamespace(_format_trajectory=lambda t: "traj", truncate_trajectory=lambda t: t)
    assert stream.extractor("standard")(agent, {}, {"question": "q"}) is None
    assert deltas == ["Half an ans", None]  # None = the client clears what it showed
    assert "agent answer: failed (WriterError: garbled)" in trace.render()


def test_the_hook_hands_the_answer_step_to_the_writer_and_leaves_research_steps_alone():
    calls = []

    class Agent:
        react, extract = object(), object()

        def _call_with_potential_trajectory_truncation(self, module, trajectory, **inputs):
            calls.append("react" if module is self.react else "dspy extract")
            return "step"

    a = r._retry_malformed_steps(Agent(), ChatTrace(), lambda agent, traj, inputs: SimpleNamespace(answer="streamed"))
    assert a._call_with_potential_trajectory_truncation(a.react, {}) == "step"
    assert a._call_with_potential_trajectory_truncation(a.extract, {}).answer == "streamed"
    assert calls == ["react"]
    b = r._retry_malformed_steps(Agent(), ChatTrace(), lambda agent, traj, inputs: None)
    assert b._call_with_potential_trajectory_truncation(b.extract, {}) == "step"  # None: dspy's own answer step


# Answer length and reshaping, from Jev and from the words of the message


def _jev(monkeypatch, detail=None, reuse=None):
    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    asked = {}

    def decide(state, questions, timeout=6.0):
        asked.update(questions)
        out = {"intent": jev.Choice("archive", 0.9, {}), "depth": jev.Choice("quick", 0.8, {})}
        if detail:
            out["detail"] = jev.Choice(*detail, {})
        if reuse and "reuse" in questions:
            out["reuse"] = jev.Choice(*reuse, {})
        return out

    monkeypatch.setattr(jev, "decide", decide)
    return asked


def test_jev_detail_needs_confidence_and_the_default_is_standard(monkeypatch):
    _jev(monkeypatch, detail=("in_depth", 0.4))
    t = r.triage("tell me about pricing", [], "nb")
    assert t.detail == "standard" and any("detail 'in_depth' confidence 0.40" in n for n in t.notes)
    _jev(monkeypatch, detail=("in_depth", 0.8))
    assert r.triage("tell me about pricing", [], "nb").detail == "in_depth"
    _jev(monkeypatch)  # an old fake with no detail answer
    assert r.triage("tell me about pricing", [], "nb").detail == "standard"


def test_the_words_of_the_message_win_over_a_standard_guess(monkeypatch):
    _jev(monkeypatch, detail=("standard", 0.9))
    assert r.triage("Give me a deep dive on pricing", [], "nb").detail == "in_depth"
    assert r.triage("tl;dr my pricing posts", [], "nb").detail == "brief"
    assert r.answer_length_from_text("What have I written about pricing?") is None
    assert r.answer_length_from_text("explain it step by step") == "in_depth"


def test_reshaping_the_last_answer_is_asked_only_once_there_is_one(monkeypatch):
    asked = _jev(monkeypatch, reuse=("rewrite_last", 0.9))
    assert r.triage("make it shorter", [], "nb").reuse == "new_research" and "reuse" not in asked
    history = [r.Turn("user", "pricing?"), r.Turn("assistant", "You raise prices yearly [1].")]
    assert r.triage("put it in a table", history, "nb").reuse == "rewrite_last"
    _jev(monkeypatch, reuse=("rewrite_last", 0.3))
    assert r.triage("hmm, and hiring?", history, "nb").reuse == "new_research"
    _jev(monkeypatch, reuse=("new_research", 0.9))
    assert r.triage("make it shorter please", history, "nb").reuse == "rewrite_last"  # the phrase rule


# Posts sync TTL


def test_a_sync_within_the_ttl_skips_r2_unless_a_post_is_new(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "corpus_sync_ttl_seconds", 30.0)
    c = Corpus(uuid.uuid4(), cache_dir=str(tmp_path))
    c.write_files({"a.md": POST})
    reads = []
    real = c._read_manifest
    monkeypatch.setattr(c, "_read_manifest", lambda remote: reads.append(remote) or real(remote))
    assert "a.md" in c.sync(("a.md",)) and reads == []  # the write just brought it in line
    c.sync(("a.md", "b.md"))  # b.md is not in what the last sync saw: go to R2
    assert reads.count(True) == 1
    monkeypatch.setattr(settings, "corpus_sync_ttl_seconds", 0.0)
    c.sync()
    assert reads.count(True) == 2


# Prefetch and the fast path


def _corpus(tmp_path):
    c = Corpus(uuid.uuid4(), cache_dir=str(tmp_path))
    c.write_files({"sources/x/pricing.md": POST, "sources/x/hiring.md": OTHER})
    return c, {"sources/x/pricing.md": "On Pricing", "sources/x/hiring.md": "Hiring"}


def test_prefetch_finds_the_right_post_with_citable_line_numbers(tmp_path):
    c, allowed = _corpus(tmp_path)
    got = pf.prefetch(c, allowed, c.sync(), "What have I written about the paid tier and raising prices?")
    assert got.passages[0][1].path == "sources/x/pricing.md" and got.coverage >= 0.75
    assert "7| Raise prices once a year" in got.text
    assert pf.prefetch(c, allowed, {}, "what did I write?").passages == []  # no content words: nothing to rank


@contextmanager
def _no_usage(lm):
    yield SimpleNamespace(prompt_tokens=5, completion_tokens=3)


def _archive(monkeypatch, depth="quick", detail="standard", reuse="new_research"):
    monkeypatch.setattr(r, "triage", lambda *a: r.Triage("archive", a[0], depth, "", detail=detail, reuse=reuse,
                                                        engine="jev"))
    monkeypatch.setattr(r, "main_lm", lambda: SimpleNamespace(model="glm-test"))
    monkeypatch.setattr(r, "track_usage", _no_usage)
    monkeypatch.setattr(settings, "chat_stream_answers", True)
    monkeypatch.setattr(settings, "chat_memory_read", False)


def _writer(monkeypatch, answer, cites, unsupported=False):
    calls = []

    def fake(inputs, evidence, on_delta, length="standard", stop_if_uncovered=False):
        calls.append({"inputs": inputs, "evidence": evidence, "length": length})
        on_delta(answer[:5])
        on_delta(answer[5:])
        return w.WriterResult(answer, cites, unsupported, 10, 4, 2)

    monkeypatch.setattr(w, "stream_answer", fake)
    return calls


def _no_agent(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("the research agent should not run")
    monkeypatch.setattr(r.dspy, "ReAct", boom)


def test_a_quick_question_the_prefetch_covers_is_answered_in_one_call(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _archive(monkeypatch)
    monkeypatch.setattr(settings, "chat_fast_path", True)
    calls = _writer(monkeypatch, "You raise prices once a year [1].",
                    [FileCitation(marker=1, path="sources/x/pricing.md", line_start=7, line_end=7)])
    _no_agent(monkeypatch)
    deltas, t = [], ChatTrace()
    res = r.research(c, allowed, "How often do I raise prices?", on_delta=deltas.append, trace=t)
    assert res.citations and res.recall["path"] == "fast path" and len(calls) == 1
    assert "7| Raise prices once a year" in calls[0]["inputs"]["prefetched"]
    assert "".join(deltas) == "You raise prices once a year [1]."
    assert "fast path: hit" in t.render() and "writer 10/4" in t.render()
    assert res.prompt_tokens == 10 and res.completion_tokens == 4


def test_a_fast_path_miss_clears_the_draft_and_runs_the_agent(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _archive(monkeypatch)
    monkeypatch.setattr(settings, "chat_fast_path", True)
    _writer(monkeypatch, "Not covered.", [], unsupported=True)
    ran = []

    def fake_react(signature, tools, max_iters):
        def run(**inputs):
            ran.append(inputs["prefetched"])
            return SimpleNamespace(answer="x", citations=[], unsupported=True)
        return run

    monkeypatch.setattr(r.dspy, "ReAct", fake_react)
    deltas, t = [], ChatTrace()
    res = r.research(c, allowed, "How often do I raise prices?", on_delta=deltas.append, trace=t)
    assert ran and "Raise prices" in ran[0]  # the agent still gets the passages
    assert None in deltas and res.recall["path"] == "research agent"
    assert "fast path: miss" in t.render()


# Reshaping the last answer


def test_make_it_shorter_rewrites_the_last_answer_with_no_research(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _archive(monkeypatch, reuse="rewrite_last", detail="brief")
    calls = _writer(monkeypatch, "Yearly [1].",
                    [FileCitation(marker=1, path="sources/x/pricing.md", line_start=7, line_end=7)])
    _no_agent(monkeypatch)
    last = r.LastAnswer("You raise prices once a year and explain why [1].",
                        [r.VerifiedCitation(1, "sources/x/pricing.md", 7, 7, "Raise prices once a year")])
    res = r.research(c, allowed, "make it shorter", history=[r.Turn("user", "q"), r.Turn("assistant", last.text)],
                     last_answer=last, on_delta=lambda t: None)
    assert res.recall["path"] == "rewrite" and res.text == "Yearly [1]." and calls[0]["length"] == "brief"
    assert "You raise prices once a year" in calls[0]["evidence"] and "sources/x/pricing.md lines 7-7" in calls[0]["evidence"]


# Parts of a question, researched at once


def test_a_multi_part_question_is_researched_in_parallel_and_written_once(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _archive(monkeypatch, depth="deep")
    monkeypatch.setattr(settings, "chat_parallel_parts", True)
    monkeypatch.setattr(r, "split_question", lambda q, h, t: (["What about pricing?", "What about hiring?"], 2, 1))
    calls = _writer(monkeypatch, "Pricing [1]. Hiring [2].",
                    [FileCitation(marker=1, path="sources/x/pricing.md", line_start=7, line_end=7),
                     FileCitation(marker=2, path="sources/x/hiring.md", line_start=7, line_end=7)])
    questions = []

    class FakeReAct:
        def __init__(self, signature, tools, max_iters):
            self.tools, self.react, self.extract = tools, object(), object()

        def _format_trajectory(self, trajectory):
            return f"observation: {trajectory['observation_0']}"

        def _call_with_potential_trajectory_truncation(self, module, trajectory, **inputs):
            raise AssertionError("replaced by the hook")

        def __call__(self, **inputs):
            questions.append(inputs["question"])
            found = self.tools[1](inputs["question"].split()[-1].strip("?"))  # search
            return self._call_with_potential_trajectory_truncation(self.extract, {"observation_0": found}, **inputs)

    monkeypatch.setattr(r.dspy, "ReAct", FakeReAct)
    steps, t = [], ChatTrace()
    res = r.research(c, allowed, "Compare what I wrote on pricing and hiring", on_step=lambda k, d: steps.append(d),
                     on_delta=lambda x: None, trace=t)
    assert sorted(questions) == ["What about hiring?", "What about pricing?"] and len(calls) == 1
    assert "### Part 1: What about pricing?" in calls[0]["evidence"] and "hiring.md" in calls[0]["evidence"]
    assert len(res.citations) == 2 and res.recall["path"] == "parallel parts"
    assert any(d.startswith("[1] ") for d in steps) and any(d.startswith("[2] ") for d in steps)
    assert "split 2/1" in t.render()


def test_only_questions_that_look_multi_part_are_split():
    assert r.looks_multipart("Compare my posts on pricing and hiring")
    assert r.looks_multipart("pricing, hiring and AI")
    assert not r.looks_multipart("What have I written about pricing?")


# The endpoint: streamed text, the answer cache


def _notebook_with_post(client, db_session, email):
    from app.models import Document, Workspace
    from tests.test_memory import _signup

    auth = _signup(client, email)
    ws = db_session.scalars(select(Workspace)).all()[-1]
    doc = Document(workspace_id=ws.id, title="On Pricing", url=f"https://x.test/{uuid.uuid4()}",
                   path="sources/x/pricing.md", content_hash="h1")
    db_session.add(doc)
    db_session.commit()
    nb = client.post("/api/notebooks", json={"title": "N", "document_ids": [str(doc.id)]}, headers=auth).json()
    return auth, nb, doc


def test_the_endpoint_streams_deltas_before_the_verified_answer(client, db_session, monkeypatch):
    from app.routers import notebooks as nbr

    auth, nb, _ = _notebook_with_post(client, db_session, "stream@example.com")

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **kw):
        kw["on_delta"]("Draft ")
        kw["on_delta"](None)
        kw["on_delta"]("Prices go up [1].")
        cite = r.VerifiedCitation(1, "sources/x/pricing.md", 7, 7, "Raise prices once a year")
        return r.ResearchResult("Prices go up [1].", False, [cite], kind="archive", question=question)

    monkeypatch.setattr(nbr, "research", fake_research)
    res = client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "pricing?"}, headers=auth)
    events = re.findall(r"event: (\w+)", res.text)
    assert events.index("delta") < events.index("reset") < events.index("answer")
    assert res.headers["x-accel-buffering"] == "no"


def test_an_exact_repeat_reuses_the_answer_but_a_follow_up_never_does(client, db_session, monkeypatch):
    from app.models import Document, Message
    from app.routers import notebooks as nbr

    monkeypatch.setattr(settings, "chat_answer_cache_days", 7)
    auth, nb, doc = _notebook_with_post(client, db_session, "cache@example.com")
    runs = []

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **kw):
        runs.append(question)
        cite = r.VerifiedCitation(1, "sources/x/pricing.md", 7, 7, "Raise prices once a year")
        return r.ResearchResult("Prices go up yearly [1].", False, [cite], kind="archive", question=question)

    monkeypatch.setattr(nbr, "research", fake_research)

    def ask(q, chat_id=None):
        return client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": q, "chat_id": chat_id},
                           headers=auth).text

    first = ask("How often do I raise prices?")
    again = ask("how often do I raise prices")  # a new chat, same question
    assert len(runs) == 1
    answer = json.loads(re.search(r"event: answer\ndata: (.*)", again).group(1))
    assert answer["text"] == "Prices go up yearly [1]." and answer["citations"][0]["path"] == "sources/x/pricing.md"
    assert "event: delta" in again
    # The same question later in a chat is a repeat too.
    chat_id = json.loads(re.search(r"event: status\ndata: (.*)", first).group(1))["chat_id"]
    ask("How often do I raise prices?", chat_id)
    assert len(runs) == 1
    # A follow up depends on the conversation: never looked up, never saved with a key.
    ask("explain how to use it", chat_id)
    ask("explain how to use it", chat_id)
    assert runs[1:] == ["explain how to use it", "explain how to use it"]
    assert all(m.cache_key is None for m in db_session.scalars(select(Message)).all() if "use it" in m.content)
    # An edited post changes the key.
    db_session.get(Document, doc.id).content_hash = "h2"
    db_session.commit()
    ask("How often do I raise prices?")
    assert len(runs) == 4


def test_the_chat_loads_only_the_columns_it_needs_and_still_cites_titles(client, db_session, monkeypatch):
    from app.routers import notebooks as nbr

    auth, nb, doc = _notebook_with_post(client, db_session, "cols@example.com")

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **kw):
        assert allowed == {"sources/x/pricing.md": "On Pricing"}
        cite = r.VerifiedCitation(1, "sources/x/pricing.md", 7, 7, "Raise prices once a year")
        return r.ResearchResult("Yearly [1].", False, [cite], kind="archive", question=question)

    monkeypatch.setattr(nbr, "research", fake_research)
    body = client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "pricing?"}, headers=auth).text
    cite = json.loads(re.search(r"event: answer\ndata: (.*)", body).group(1))["citations"][0]
    assert cite["title"] == "On Pricing" and cite["url"] == doc.url and cite["document_id"] == str(doc.id)


# Round 2: typos, follow ups, deep questions and questions about the whole notebook


def test_a_typo_does_not_count_against_coverage(tmp_path):
    c, allowed = _corpus(tmp_path)
    got = pf.prefetch(c, allowed, c.sync(), "waht is the paid tier?")
    assert got.coverage == 1.0 and got.terms == ["paid", "tier"] and "waht" in got.asked


def test_a_question_about_the_whole_notebook_has_no_subject():
    c = None  # nothing is read when no content word is left
    assert pf.prefetch(c, {"a.md": "A"}, {}, "What are the strongest ideas across these posts?").overview


def test_referring_back_is_told_apart_from_naming_the_notebook():
    assert r.refers_back("explain how to use it") and r.refers_back("give me a brief intro of him")
    assert not r.refers_back("What are the strongest ideas across these posts?")
    assert not r.refers_back("what is bloghub?")


def test_a_follow_up_is_never_off_topic(monkeypatch):
    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    monkeypatch.setattr(jev, "decide", lambda *a, **k: {"intent": jev.Choice("off_topic", 0.9, {}),
                                                        "depth": jev.Choice("quick", 0.8, {})})
    history = [r.Turn("user", "who is muhammad mehdi"), r.Turn("assistant", "A software engineer in Lahore [1].")]
    t = r.triage("give me a brief intro of him", history, "nb")
    assert t.kind == "archive" and any("follow up" in n for n in t.notes)
    assert r.triage("what is the capital of France?", history, "nb").kind == "off_topic"
    assert r.triage("give me a brief intro of him", [], "nb").kind == "off_topic"  # nothing to refer back to


def test_a_deep_question_the_prefetch_covers_takes_the_fast_path_with_more_passages(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _archive(monkeypatch, depth="deep")
    monkeypatch.setattr(settings, "chat_fast_path", True)
    calls = _writer(monkeypatch, "Yearly [1].",
                    [FileCitation(marker=1, path="sources/x/pricing.md", line_start=7, line_end=7)])
    _no_agent(monkeypatch)
    seen = {}
    real = r.prefetch
    monkeypatch.setattr(r, "prefetch", lambda *a: seen.setdefault("args", a) and real(*a))
    res = r.research(c, allowed, "How has my pricing changed over time?", on_delta=lambda t: None)
    assert res.recall["path"] == "fast path" and len(calls) == 1 and seen["args"][-2:] == (pf.DEEP_TOP_K, pf.DEEP_PER_POST)


def test_a_follow_up_is_searched_with_the_question_before_it(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _archive(monkeypatch)
    monkeypatch.setattr(settings, "chat_fast_path", True)
    calls = _writer(monkeypatch, "Yearly [1].",
                    [FileCitation(marker=1, path="sources/x/pricing.md", line_start=7, line_end=7)])
    _no_agent(monkeypatch)
    history = [r.Turn("user", "what about the paid tier?"), r.Turn("assistant", "It works when [1].")]
    t = ChatTrace()
    res = r.research(c, allowed, "explain it", history=history, on_delta=lambda x: None, trace=t)
    assert res.recall["path"] == "fast path" and "paid tier works best" in calls[0]["inputs"]["prefetched"]
    assert "searched with the previous question" in t.render()


def test_a_question_about_the_whole_notebook_is_answered_from_the_openings(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _archive(monkeypatch, depth="deep")
    monkeypatch.setattr(settings, "chat_fast_path", True)
    calls = _writer(monkeypatch, "Price yearly [1] and hire slowly [2].",
                    [FileCitation(marker=1, path="sources/x/pricing.md", line_start=7, line_end=7),
                     FileCitation(marker=2, path="sources/x/hiring.md", line_start=7, line_end=7)])
    _no_agent(monkeypatch)
    t = ChatTrace()
    res = r.research(c, allowed, "What are the strongest ideas across these posts?", on_delta=lambda x: None, trace=t)
    assert res.recall["path"] == "overview" and len(res.citations) == 2 and len(calls) == 1
    assert "7| Raise prices once a year" in calls[0]["evidence"] and "7| Hire slowly" in calls[0]["evidence"]
    assert "sources/x/hiring.md" in calls[0]["evidence"].split("The opening passage")[0]  # the post list
    assert "overview path: hit" in t.render()


def test_an_overview_miss_falls_back_to_the_agent(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _archive(monkeypatch, depth="deep")
    monkeypatch.setattr(settings, "chat_fast_path", True)
    _writer(monkeypatch, "Not covered.", [], unsupported=True)
    ran = []

    def fake_react(signature, tools, max_iters):
        return lambda **inputs: ran.append(1) or SimpleNamespace(answer="x", citations=[], unsupported=True)

    monkeypatch.setattr(r.dspy, "ReAct", fake_react)
    deltas = []
    res = r.research(c, allowed, "What are the strongest ideas across these posts?", on_delta=deltas.append)
    assert ran and None in deltas and res.recall["path"] == "research agent"


def test_the_chat_survives_the_request_session_closing_before_the_stream_runs(client, db_session, monkeypatch):
    """FastAPI closes the request's session when the endpoint returns, before the stream body runs, and closing rolls
    back anything uncommitted. A chat row created outside the stream was lost that way and the chat hung."""
    from app.db import get_db
    from app.main import app
    from app.models import Chat, Message
    from app.routers import notebooks as nbr

    auth, nb, _ = _notebook_with_post(client, db_session, "close@example.com")

    def closing_db():
        try:
            yield db_session
        finally:
            db_session.rollback()  # what close() does to uncommitted work

    app.dependency_overrides[get_db] = closing_db
    monkeypatch.setattr(nbr, "research", lambda *a, **k: r.ResearchResult(
        "Yearly [1].", False, [r.VerifiedCitation(1, "sources/x/pricing.md", 7, 7, "Raise prices")], kind="archive"))
    body = client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "Hi, what is blog2video"},
                       headers=auth).text
    assert "event: answer" in body
    chat_id = json.loads(re.search(r"event: status\ndata: (.*)", body).group(1))["chat_id"]
    assert db_session.get(Chat, uuid.UUID(chat_id)) is not None
    assert [m.role for m in db_session.scalars(select(Message).where(Message.chat_id == uuid.UUID(chat_id)))] \
        == ["user", "assistant"]


def test_a_failure_while_loading_ends_the_stream_with_an_error(client, db_session, monkeypatch):
    from app.routers import notebooks as nbr

    auth, nb, _ = _notebook_with_post(client, db_session, "boom@example.com")

    def boom(*a, **k):
        raise RuntimeError("R2 down")

    monkeypatch.setattr(nbr, "load_chat_memory", boom)
    body = client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "pricing?"}, headers=auth).text
    assert "event: error" in body and "event: answer" not in body


def _crowded_corpus(tmp_path):
    """Five posts about BlogHub (a rare word, so it scores high) and twenty that each mention hiring once (a common
    word, so it scores low): by score alone, BlogHub fills every slot and hiring never makes the cut."""
    posts = {}
    for i in range(5):
        posts[f"sources/x/bloghub-{i}.md"] = (f"---\ntitle: Directory {i}\n---\n\n# Directory {i}\n\n"
                                              f"BlogHub BlogHub BlogHub listing number {i}.\n")
    for i in range(20):
        posts[f"sources/x/team-{i}.md"] = (f"---\ntitle: Week {i}\n---\n\n# Week {i}\n\n"
                                           f"Notes on shipping, writing and hiring in week {i}.\n")
    c = Corpus(uuid.uuid4(), cache_dir=str(tmp_path))
    c.write_files(posts)
    return c, {rel: rel for rel in posts}


def test_every_word_of_the_question_gets_a_passage_even_when_another_word_crowds_it_out(tmp_path):
    c, allowed = _crowded_corpus(tmp_path)
    manifest = c.sync()
    ranked = pf._index(c, allowed, manifest).search("hiring bloghub")
    old = pf._pick(ranked, [], 4, pf.PER_POST)  # score order alone: the old selection
    assert all("bloghub" in p.path for _, p in old)
    got = pf.prefetch(c, allowed, manifest, "How did hiring change after BlogHub?", k=4)
    paths = [p.path for _, p in got.passages]
    assert any("team-" in path for path in paths) and len(paths) == 4
    assert got.coverage == 1.0 and got.for_coverage == 1
    assert [s for s, _ in got.passages] == sorted((s for s, _ in got.passages), reverse=True)  # best first


def test_the_per_post_limit_gives_way_only_for_a_word_nothing_else_holds(tmp_path):
    c = Corpus(uuid.uuid4(), cache_dir=str(tmp_path))
    para = " ".join  # each section is about 500 characters: a passage of its own
    body = (f"## A\n\n{para(['alpha'] * 90)}\n\n## B\n\n{para(['beta'] * 90)}\n\n## G\n\n{para(['gamma'] * 90)}\n\n"
            f"## A again\n\n{para(['alpha'] * 90)}")
    c.write_files({"sources/x/notes.md": _post("Notes", body)})
    allowed = {"sources/x/notes.md": "Notes"}
    got = pf.prefetch(c, allowed, c.sync(), "alpha beta gamma", k=6, per_post_max=1)
    assert got.coverage == 1.0 and len(got.passages) == 3  # over the limit of 1, for each word's only passage
    got = pf.prefetch(c, allowed, c.sync(), "alpha", k=6, per_post_max=1)
    assert len(got.passages) == 1  # nothing missing: the limit holds


# Passages that follow sections, sized by characters, with the next passage of a topic sent along


def _post(title, body):
    return f"---\ntitle: {title}\n---\n\n# {title}\n\n{body}\n"


def _para(text, size):
    return " ".join([text] * max(1, size // (len(text) + 1)))


def _one_post(tmp_path, body, title="Guide"):
    c = Corpus(uuid.uuid4(), cache_dir=str(tmp_path / uuid.uuid4().hex))
    c.write_files({"sources/x/guide.md": _post(title, body)})
    return c, {"sources/x/guide.md": title}


def test_the_details_below_a_topics_opening_are_sent_even_without_its_keywords(tmp_path):
    body = ("## How it works\n\n" + _para("A featured listing on BlogHub puts you first.", 900) + "\n\n"
            + _para("Then you submit your profile, pay nine dollars a month and wait two days.", 900) + "\n\n"
            + _para("Approval emails arrive from the editors with next steps.", 900))
    c, allowed = _one_post(tmp_path, body)
    blocks = pf.passages_of(c, "sources/x/guide.md", "Guide")
    assert len(blocks) >= 2 and "nine dollars" not in " ".join(blocks[0].lines)
    got = pf.prefetch(c, allowed, c.sync(), "how do I get a featured listing on bloghub?")
    assert got.passages[0][1] == blocks[0] and blocks[1] in got.added  # the details came along
    assert "nine dollars" in got.text
    assert got.text.count("sources/x/guide.md lines") == 1  # joined into one passage with real line numbers
    line = next(ln for ln in got.text.splitlines() if "nine dollars" in ln)
    assert "nine dollars" in c.read_lines("sources/x/guide.md")[int(line.split("|")[0]) - 1]


def test_a_passage_never_crosses_a_heading_and_carries_its_headings_words(tmp_path):
    body = ("## Getting featured\n\n" + _para("Spots sit on top of each category page.", 900) + "\n\n"
            + _para("Pay nine dollars a month after approval.", 900) + "\n\n"
            + _para("Cancel any time from settings.", 900) + "\n\n## Writing tips\n\n" + _para("Write short.", 600))
    c, _ = _one_post(tmp_path, body)
    blocks = pf.passages_of(c, "sources/x/guide.md", "Guide")
    for b in blocks:
        assert not any(pf._HEADING.match(line) for line in b.lines[1:])  # a heading only ever opens a passage
    later = [b for b in blocks if b.heading == "Getting featured" and "featured" not in " ".join(b.lines).lower()]
    assert later and all("featur" in b.tokens for b in later)  # found through its heading
    assert blocks[-1].heading == "Writing tips" and blocks[-2].next is None  # no next across a heading


def test_sections_are_sized_by_characters_and_cut_at_paragraph_breaks(tmp_path):
    short_lines = "\n".join(["- a short bullet line here"] * 60)  # about 1,600 characters on 60 lines
    c, _ = _one_post(tmp_path, "## List\n\n" + short_lines)
    assert len(pf.passages_of(c, "sources/x/guide.md", "Guide")) == 1  # many lines, one passage
    paras = "\n\n".join(_para(f"Paragraph {i} says something useful.", 600) for i in range(8))  # ~4,800 characters
    c, _ = _one_post(tmp_path, "## Long\n\n" + paras)
    blocks = pf.passages_of(c, "sources/x/guide.md", "Guide")
    assert 3 <= len(blocks) <= 5
    lines = c.read_lines("sources/x/guide.md")
    for b in blocks[1:]:
        assert not lines[b.start - 2].strip()  # each cut falls right after a blank line: a paragraph break
    for a, b in zip(blocks, blocks[1:], strict=False):
        assert a.next is b and b.start == a.end + 1  # nothing lost between passages


def test_a_small_tail_joins_the_passage_before_and_a_tiny_section_joins_the_next(tmp_path):
    body = ("## Intro\n\nJust a line.\n\n## Main\n\n" + _para("Main text goes here.", 1100) + "\n\n"
            + _para("More main text.", 1100) + "\n\nThe end.")
    c, _ = _one_post(tmp_path, body)
    blocks = pf.passages_of(c, "sources/x/guide.md", "Guide")
    assert blocks[0].heading == "Intro / Main" and "Just a line." in blocks[0].lines
    assert "The end." in blocks[-1].lines and len(blocks) == 2  # the tail did not become a passage of its own


def test_one_huge_line_is_cut_at_sentence_ends_and_keeps_its_line_number(tmp_path):
    huge = " ".join(f"Sentence number {i} talks about pricing tiers." for i in range(90))  # about 4,000 characters
    c, allowed = _one_post(tmp_path, "## Wall\n\n" + huge)
    blocks = pf.passages_of(c, "sources/x/guide.md", "Guide")
    n = c.read_lines("sources/x/guide.md").index(huge) + 1
    pieces = [b for b in blocks if b.start == b.end == n]
    assert len(pieces) >= 3 and all(len(b.lines[0]) <= pf.BLOCK_CHARS for b in pieces)
    assert all(b.lines[0].rstrip().endswith(".") for b in pieces)  # cut at sentence ends
    got = pf.prefetch(c, allowed, c.sync(), "pricing tiers")
    assert f"{n}| " in got.text  # shown on its real line


def test_a_matching_section_is_sent_whole_once_and_not_counted_in_k(tmp_path, monkeypatch):
    paras = "\n\n".join(_para(f"Part {i} about widgets and gadgets.", 700) for i in range(6))  # about 4,200 characters
    c, allowed = _one_post(tmp_path, "## Widgets\n\n" + paras + "\n\n## Other\n\n" + _para("Something else.", 600))
    blocks = pf.passages_of(c, "sources/x/guide.md", "Guide")
    widgets = [b for b in blocks if b.heading == "Widgets"]
    assert len(widgets) >= 4
    got = pf.prefetch(c, allowed, c.sync(), "widgets", k=2, per_post_max=2)
    sent = [p for _, p in got.passages] + got.added
    assert len(got.passages) == 2 and len(sent) == len(widgets)  # the whole section, on top of k
    assert all(p in widgets for p in sent) and len({id(p) for p in sent}) == len(sent)  # nothing twice, nothing else
    assert got.text.count("sources/x/guide.md lines") == 1  # one passage, line by line
    monkeypatch.setattr(pf, "CONTEXT_BUDGET_CHARS", 1)
    assert pf.prefetch(c, allowed, c.sync(), "widgets", k=2, per_post_max=2).added == []


def test_a_long_section_sends_the_match_with_its_neighbours_not_all_of_it(tmp_path):
    paras = [_para(f"Filler part {i} on gardening and soil.", 1000) for i in range(10)]
    paras[5] = _para("The secret to tomatoes is deep watering.", 1000)
    c, allowed = _one_post(tmp_path, "## Garden\n\n" + "\n\n".join(paras))  # about 10,000 characters, one section
    blocks = pf.passages_of(c, "sources/x/guide.md", "Guide")
    assert sum(len(b.render()) for b in blocks) > pf.SECTION_WHOLE_CHARS
    got = pf.prefetch(c, allowed, c.sync(), "tomatoes watering")
    match = got.passages[0][1]
    at = blocks.index(match)
    assert len(got.passages) == 1 and got.added == [blocks[at + 1], blocks[at - 1]]  # next first, then the one before
    assert "Filler part 0" not in got.text and "Filler part 9" not in got.text


def test_a_section_that_no_longer_fits_falls_back_to_its_neighbours(tmp_path, monkeypatch):
    paras = "\n\n".join(_para(f"Part {i} about widgets and gadgets.", 700) for i in range(6))
    c, allowed = _one_post(tmp_path, "## Widgets\n\n" + paras)
    blocks = pf.passages_of(c, "sources/x/guide.md", "Guide")
    one = len(blocks[0].render())
    monkeypatch.setattr(pf, "CONTEXT_BUDGET_CHARS", one * 3 + 50)  # room for the match and two more, not all six
    got = pf.prefetch(c, allowed, c.sync(), "widgets", k=1)
    match = got.passages[0][1]
    at = blocks.index(match)
    assert got.added == [b for b in (blocks[at + 1:at + 2] + blocks[max(0, at - 1):at])]


def test_related_word_forms_meet_and_vague_words_do_not_count(tmp_path):
    c, allowed = _one_post(tmp_path, "## Money\n\nWe raised our prices twice and priced the new tier lower.")
    got = pf.prefetch(c, allowed, c.sync(), "what about my pricing?")
    assert got.terms == ["pric"] and got.passages and got.coverage == 1.0
    got = pf.prefetch(c, allowed, c.sync(), "how did pricing help into the tier?")
    assert got.coverage == 1.0 and "help" not in got.asked and "into" not in got.asked


# The COVERED line: a one-call path stops before showing anything when the passages do not answer the question


def test_the_covered_line_is_read_and_never_shown(monkeypatch, fake_writer_lm):
    monkeypatch.setattr(w, "_completion", lambda **kw: iter(_chunks(
        "COVER", "ED: yes\nRaise prices ", "yearly [1].\n<<<CITATIONS>>>\n",
        '{"citations": [{"marker": 1, "path": "a.md", "line_start": 7, "line_end": 7}]}')))
    shown = []
    res = w.stream_answer({"question": "q"}, "e", shown.append)
    assert res.answer == "Raise prices yearly [1]." and "COVERED" not in "".join(shown)


def test_covered_no_stops_a_one_call_path_before_any_text(monkeypatch, fake_writer_lm):
    pulled = []

    def stream():
        for piece in ["COVERED: no\n", "The archive does not cover this.", "\n<<<CITATIONS>>>\n{}"]:
            pulled.append(piece)
            yield from _chunks(piece)[:1]

    monkeypatch.setattr(w, "_completion", lambda **kw: stream())
    shown = []
    with pytest.raises(w.WriterUncovered):
        w.stream_answer({"question": "q"}, "e", shown.append, stop_if_uncovered=True)
    assert shown == [] and pulled == ["COVERED: no\n"]  # stopped at the first line, nothing sent
    pulled.clear()
    monkeypatch.setattr(w, "_completion", lambda **kw: stream())
    res = w.stream_answer({"question": "q"}, "e", shown.append)  # the agent's answer step: an honest "not covered"
    assert res.answer == "The archive does not cover this." and "".join(shown).strip() == res.answer


def test_an_answer_without_the_covered_line_is_kept_whole(monkeypatch, fake_writer_lm):
    monkeypatch.setattr(w, "_completion", lambda **kw: iter(_chunks(
        "Short.\n<<<CITATIONS>>>\n", '{"citations": []}')))
    assert w.stream_answer({"question": "q"}, "e", lambda t: None).answer == "Short."


def test_a_fast_path_the_passages_do_not_cover_hands_over_without_a_reset(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _archive(monkeypatch)
    monkeypatch.setattr(settings, "chat_fast_path", True)

    def uncovered(inputs, evidence, on_delta, length="standard", stop_if_uncovered=False):
        assert stop_if_uncovered
        raise w.WriterUncovered("no")

    monkeypatch.setattr(w, "stream_answer", uncovered)
    monkeypatch.setattr(r.dspy, "ReAct", lambda signature, tools, max_iters: (
        lambda **inputs: SimpleNamespace(answer="x", citations=[], unsupported=True)))
    deltas, t = [], ChatTrace()
    res = r.research(c, allowed, "How often do I raise prices?", on_delta=deltas.append, trace=t)
    assert deltas == [] and res.recall["path"] == "research agent"  # nothing shown, nothing taken back
    assert "stopped before any text" in t.render()


# The answer's topic, for the next-step suggestions under it


def test_the_writer_returns_a_short_clean_topic():
    _, _, topic = w.parse_tail('{"citations": [], "unsupported": false, "topic": "  BlogHub\'s featured listings. "}')
    assert topic == "BlogHub's featured listings"
    assert w.parse_tail('{"citations": [], "unsupported": false}')[2] == ""  # older replies without one
    assert w.parse_tail('{"citations": [], "topic": 42}')[2] == ""
    long = w.clean_topic("the many different ways I described growing a newsletter through directories and notes")
    assert len(long) <= w.TOPIC_MAX_CHARS and not long.endswith(" ")


def test_the_topic_is_sent_with_the_answer_saved_and_returned_with_the_chat(client, db_session, monkeypatch):
    from app.routers import notebooks as nbr

    auth, nb, _ = _notebook_with_post(client, db_session, "topic@example.com")

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **kw):
        cite = r.VerifiedCitation(1, "sources/x/pricing.md", 7, 7, "Raise prices once a year")
        return r.ResearchResult("Yearly [1].", False, [cite], kind="archive", question=question,
                                topic="your pricing posts")

    monkeypatch.setattr(nbr, "research", fake_research)
    body = client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "pricing?"}, headers=auth).text
    assert json.loads(re.search(r"event: answer\ndata: (.*)", body).group(1))["topic"] == "your pricing posts"
    chat_id = json.loads(re.search(r"event: status\ndata: (.*)", body).group(1))["chat_id"]
    msgs = client.get(f"/api/notebooks/chats/{chat_id}/messages", headers=auth).json()
    assert [m["topic"] for m in msgs] == ["", "your pricing posts"]


def test_a_cached_answer_saved_before_topics_is_answered_afresh(client, db_session, monkeypatch):
    from app.models import Message
    from app.routers import notebooks as nbr

    monkeypatch.setattr(settings, "chat_answer_cache_days", 7)
    auth, nb, _ = _notebook_with_post(client, db_session, "oldcache@example.com")
    runs = []

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **kw):
        runs.append(question)
        cite = r.VerifiedCitation(1, "sources/x/pricing.md", 7, 7, "Raise prices once a year")
        return r.ResearchResult("Yearly [1].", False, [cite], kind="archive", question=question, topic="your pricing")

    monkeypatch.setattr(nbr, "research", fake_research)
    ask = lambda: client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "pricing?"},  # noqa: E731
                              headers=auth).text
    ask()
    old = db_session.scalars(select(Message).where(Message.cache_key.is_not(None))).one()
    old.recall_json = {k: v for k, v in old.recall_json.items() if k != "topic"}  # as saved before topics
    db_session.commit()
    body = ask()
    assert len(runs) == 2 and json.loads(re.search(r"event: answer\ndata: (.*)", body).group(1))["topic"] == "your pricing"
    ask()  # the fresh answer, with its topic, is now the one reused
    assert len(runs) == 2


# Off topic is rechecked with every title and each post's opening before the writer is brushed off


def _off_topic_jev(monkeypatch, *retries):
    """The first look says off_topic; each recheck answers the next of `retries` as (choice, confidence)."""
    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    seen = []

    def decide(state, questions, timeout=6.0):
        seen.append((state, questions))
        if len(seen) == 1:
            return {"intent": jev.Choice("off_topic", 0.9, {}), "depth": jev.Choice("quick", 0.8, {})}
        got = retries[len(seen) - 2]
        if isinstance(got, Exception):
            raise got
        return {"intent": jev.Choice(*got, {})}

    monkeypatch.setattr(jev, "decide", decide)
    return seen


def _recheck(monkeypatch, tmp_path, *retries):
    seen = _off_topic_jev(monkeypatch, *retries)
    c, allowed = _corpus(tmp_path)
    t = ChatTrace()
    monkeypatch.setattr(r, "instant_reply", lambda *a: None)
    # An archive verdict would start the research agent: stop there, the route is what matters.
    monkeypatch.setattr(r, "archive_guide", lambda *a: (_ for _ in ()).throw(RuntimeError("research started")))
    try:
        res = r.research(c, allowed, "Which wine goes with fish?", trace=t)
    except RuntimeError as exc:
        assert "research started" in str(exc)
        res = None
    return res, seen, t


def test_the_recheck_brief_has_every_title_and_the_first_two_paragraphs(tmp_path):
    c, allowed = _corpus(tmp_path)
    brief = r.notebook_brief_full("nb", allowed, c)
    assert "On Pricing" in brief and "Hiring" in brief and "Raise prices once a year" in brief
    many = {f"sources/x/p{i}.md": f"Post {i}" for i in range(40)}
    assert all(f"- Post {i}" in r.notebook_brief_full("nb", many, c) for i in range(40))  # titles of posts past 25


def test_a_recheck_that_finds_the_subject_sends_it_to_research(monkeypatch, tmp_path):
    res, seen, t = _recheck(monkeypatch, tmp_path, ("archive", 0.8))
    assert res is None and len(seen) == 2  # research started after one recheck; the second was not needed
    assert "Raise prices once a year" in seen[1][0]["notebook"]
    assert "intent_retry1" in t.sections["triage"] or "recheck 1" in "".join(t.sections["triage"])


def test_two_rechecks_that_agree_keep_it_off_topic(monkeypatch, tmp_path):
    res, seen, _ = _recheck(monkeypatch, tmp_path, ("off_topic", 0.9), ("off_topic", 0.8))
    assert len(seen) == 3 and res.kind == "off_topic" and "I only answer from the posts" in res.text


def test_the_second_recheck_can_still_save_it_and_an_unsure_one_researches(monkeypatch, tmp_path):
    res, seen, _ = _recheck(monkeypatch, tmp_path, ("off_topic", 0.9), ("archive", 0.7))
    assert res is None and len(seen) == 3
    res, seen, _ = _recheck(monkeypatch, tmp_path, ("off_topic", 0.3))  # below the confidence cutoff
    assert res is None and len(seen) == 2


def test_a_failed_recheck_researches_instead_of_brushing_off(monkeypatch, tmp_path):
    res, seen, _ = _recheck(monkeypatch, tmp_path, jev.JevError("down"))
    assert res is None and len(seen) == 2

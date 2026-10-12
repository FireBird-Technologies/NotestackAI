"""The per-message trace block (logger notestack.chat_trace): what Jev chose and what our thresholds changed, which path
ran, what the agent was given, and how long each stage took."""

import logging
import uuid
from contextlib import contextmanager
from types import SimpleNamespace

from app.chat_memory.files import TopicEntry, TopicsFile
from app.config import settings
from app.pipeline import research as r
from app.pipeline.trace import ChatTrace, ms
from app.services import jev


def _memory(*slugs):
    tf = TopicsFile(chat_id="c", entries=[TopicEntry(s, s.title(), "2026-10-01", 1, "kw", "gist") for s in slugs])
    return SimpleNamespace(tf=tf, latest=lambda: slugs[0] if slugs else None)


def _jev(monkeypatch, **answers):
    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    monkeypatch.setattr(jev, "decide", lambda *a, **k: answers)


def test_the_trace_shows_every_jev_answer_and_what_a_threshold_changed(monkeypatch):
    _jev(monkeypatch,
         intent=jev.Choice("archive", 0.91, {"archive": 0.91, "off_topic": 0.09}),
         depth=jev.Choice("deep", 0.77, {"deep": 0.77, "quick": 0.23}),
         memory=jev.Choice("replay", 0.41, {"replay": 0.41, "compose": 0.39, "lookup": 0.2}),
         topic=jev.Choice("evals", 0.3, {"evals": 0.3, "none": 0.7}))
    route = r.triage("what did you say about MMLU?", [], "nb", _memory("evals"))
    assert (route.kind, route.memory, route.topic, route.engine) == ("archive", "lookup", "", "jev")
    assert route.jev["memory"] == {"choice": "replay", "confidence": 0.41,
                                   "probabilities": {"replay": 0.41, "compose": 0.39, "lookup": 0.2}}
    assert any("memory 'replay' confidence 0.41" in n and "-> lookup" in n for n in route.notes)
    assert any("topic 'evals'" in n and "confidence 0.30" in n for n in route.notes)

    trace = ChatTrace(notebook="nb", message="what did you say about MMLU?")
    r._trace_triage(trace, route)
    text = trace.render()
    assert "engine   : jev" in text
    assert "memory   : replay" in text and "confidence 0.41" in text and "compose 0.39" in text
    assert "overrides: memory 'replay' confidence 0.41" in text
    assert "FINAL    : kind=archive depth=deep memory=lookup topic=-" in text
    assert "memory=lookup means:" in text


def test_a_trace_without_jev_says_why_and_that_there_are_no_confidences(monkeypatch):
    monkeypatch.setattr(settings, "typesafe_api_key", "")
    monkeypatch.setattr(r, "triage_llm", lambda *a: r.Triage("archive", "q", "quick", ""))
    route = r.triage("hello?", [], "nb")
    trace = ChatTrace()
    r._trace_triage(trace, route)
    assert "llm triage (Jev is not configured" in trace.render() and "no probabilities or confidences" in trace.render()

    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")

    def down(*a, **k):
        raise jev.JevError("503 busy")

    monkeypatch.setattr(jev, "decide", down)
    assert "Jev failed: 503 busy" in r.triage("hello?", [], "nb").engine


def test_each_path_says_which_one_ran(monkeypatch, tmp_path):
    from app.corpus import Corpus

    corpus = Corpus(uuid.uuid4(), cache_dir=str(tmp_path))
    allowed = {"a.md": "On Pricing"}
    t = ChatTrace()
    r.research(corpus, {}, "hi", trace=t)
    assert "NO POSTS" in t.render()
    t = ChatTrace()
    r.research(corpus, allowed, "thanks!", trace=t)
    assert "SMALL TALK" in t.render() and "no model, Jev call or R2 read" in t.render()
    t = ChatTrace()
    monkeypatch.setattr(r, "triage", lambda *a: r.Triage("off_topic", "q", "quick", "", engine="jev"))
    r.research(corpus, allowed, "what is the capital of France?", trace=t)
    out = t.render()
    assert "OFF_TOPIC: triage decided this needs no research" in out and "a fixed template" in out
    assert "post reads" in out and "[TIMING]  triage" in out


def test_the_archive_trace_lists_what_the_agent_was_given(monkeypatch, tmp_path):
    from app.corpus import Corpus

    @contextmanager
    def no_usage(lm):
        yield SimpleNamespace(prompt_tokens=11, completion_tokens=7)

    seen = {}

    def fake_react(signature, tools, max_iters):
        seen["tools"] = [t.__name__ for t in tools]

        def run(**inputs):
            return SimpleNamespace(answer="x", citations=[], unsupported=True)
        return run

    monkeypatch.setattr(r.dspy, "ReAct", fake_react)
    monkeypatch.setattr(r, "main_lm", lambda: SimpleNamespace(model="glm-test"))
    monkeypatch.setattr(r, "track_usage", no_usage)
    monkeypatch.setattr(r, "triage", lambda *a: r.Triage("archive", "q", "quick", "", engine="jev"))
    corpus = Corpus(uuid.uuid4(), cache_dir=str(tmp_path))
    monkeypatch.setattr(corpus, "sync", lambda: {})
    monkeypatch.setattr(settings, "chat_memory_read", False)
    t = ChatTrace()
    t.step("search", "pric(e|ing)")
    r.research(corpus, {"a.md": "On Pricing"}, "What did I charge?", profile="- audience: founders\n- tone: brief",
               history=[r.Turn("user", "hi there"), r.Turn("assistant", "hello")], trace=t)
    text = t.render()
    assert "ARCHIVE: the message needs the writer's posts" in text
    assert "signature: ResearchArchive | model glm-test | up to 4 reasoning steps (quick)" in text
    assert "tools    : list_files, search, read" in text
    assert "conversation: 2 turn(s)" in text and "writer notes: 2 line(s)" in text
    assert "chat memory: OFF (CHAT_MEMORY_READ=false)" in text
    assert "the model proposed 0, verified 0" in text and "tokens prompt/completion: triage 0/0, agent 11/7" in text
    assert "could not find support" not in text  # unsupported=True: the model's own "not covered" answer is kept
    assert "search" in text and "[posts, local disk cache]" in text
    assert "[TIMING]  triage" in text and "sync-posts" in text and "agent" in text and "verify" in text


def test_the_chat_endpoint_writes_one_trace_block_per_message(client, monkeypatch, caplog):
    from app.routers import notebooks as nbr
    from tests.test_memory import _signup

    auth = _signup(client, "trace1@example.com")
    nb = client.post("/api/notebooks", json={"title": "My notebook"}, headers=auth).json()

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **kw):
        from app.pipeline.trace import current_trace

        current_trace().add("route", "ARCHIVE: fake")  # research() finds the request's trace through the context
        return r.ResearchResult("ok", True, [], kind="archive", question=question)

    monkeypatch.setattr(nbr, "research", fake_research)
    monkeypatch.setattr(settings, "chat_context_log", True)
    monkeypatch.setattr(settings, "chat_memory_read", False)
    with caplog.at_level(logging.INFO, logger="notestack.chat_trace"):
        client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "hello there friend"}, headers=auth)
    blocks = [rec.getMessage() for rec in caplog.records if rec.name == "notestack.chat_trace"]
    assert len(blocks) == 1
    text = blocks[0]
    assert text.startswith("CHAT TRACE  chat=") and "notebook='My notebook'" in text
    assert "'hello there friend'" in text  # text logging is on
    assert "[1 LOAD (Postgres, R2)]" in text and "history: 0 message(s) of this chat  [Postgres]" in text
    assert "chat memory: OFF (CHAT_MEMORY_READ=false), nothing read from R2" in text
    assert "[2 PATH]" in text and "ARCHIVE: fake" in text
    assert "answer sent after" in text and "assistant message saved to Postgres" in text
    assert "workspace notes: not updated (no LLM_API_KEY)" in text
    assert "[TIMING]  db-history+notes" in text and "save-answer" in text


def test_the_trace_hides_the_message_when_text_logging_is_off(client, monkeypatch, caplog):
    from app.routers import notebooks as nbr
    from tests.test_memory import _signup

    auth = _signup(client, "trace2@example.com")
    nb = client.post("/api/notebooks", json={"title": "N"}, headers=auth).json()
    monkeypatch.setattr(nbr, "research", lambda *a, **k: r.ResearchResult("ok", True, [], kind="archive"))
    monkeypatch.setattr(settings, "chat_context_log", False)
    with caplog.at_level(logging.INFO, logger="notestack.chat_trace"):
        client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "my secret question"}, headers=auth)
    assert "CHAT TRACE" in caplog.text and "my secret question" not in caplog.text
    assert "message : 18 chars" in caplog.text


def test_the_notes_gate_logs_what_jev_said_and_what_it_did(monkeypatch, caplog):
    from app.pipeline import memory as m

    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    monkeypatch.setattr(jev, "decide", lambda *a, **k: {"remember": jev.Choice("no", 0.93, {"no": 0.93, "yes": 0.07})})
    with caplog.at_level(logging.INFO, logger="app.pipeline.memory"):
        assert m.worth_remembering("What did I write about pricing?") is False
    assert "NOTES GATE  Jev says 'no', confidence 0.93 [no 0.93  yes 0.07]  ->  SKIP the extraction" in caplog.text
    caplog.clear()
    monkeypatch.setattr(jev, "decide", lambda *a, **k: {"remember": jev.Choice("no", 0.6, {"no": 0.6, "yes": 0.4})})
    with caplog.at_level(logging.INFO, logger="app.pipeline.memory"):
        assert m.worth_remembering("Please be brief. What did I write?") is True
    assert "RUN the extraction model" in caplog.text


def test_durations_read_naturally():
    assert ms(12) == "12ms" and ms(1500) == "1.5s"


# A model reply that is not in the shape ReAct needs (it sent only the tool's arguments)


def _malformed():
    import dspy
    from dspy.utils.exceptions import AdapterParseError

    return AdapterParseError("JSONAdapter", dspy.Signature("question -> answer"),
                             '{"path": "sources/x.md", "start_line": 1, "end_line": 100}')


def _real_react(react, extract):
    import dspy

    def search(query: str) -> str:
        """Search."""
        return "observation"

    agent = dspy.ReAct("question -> answer", tools=[search], max_iters=3)
    agent.react, agent.extract = react, extract
    return agent


def test_react_still_has_the_hook_the_retry_uses():
    import dspy

    assert hasattr(dspy.ReAct, "_call_with_potential_trajectory_truncation")  # fails loudly if dspy is upgraded


def test_a_malformed_step_is_asked_again_once_with_a_different_request():
    import dspy

    configs = []

    def react(**kw):
        configs.append(kw.get("config"))
        if len(configs) == 1:
            raise _malformed()
        return dspy.Prediction(next_thought="done", next_tool_name="finish", next_tool_args={})

    trace = ChatTrace()
    agent = r._retry_malformed_steps(_real_react(react, lambda **kw: dspy.Prediction(answer="ok")), trace)
    assert agent(question="q").answer == "ok"
    assert configs == [None, {"temperature": r.RETRY_TEMPERATURE}]  # the retry is not the cached request
    assert "not in the expected shape" in trace.render() and "asking again once" in trace.render()


def test_a_step_that_stays_malformed_ends_the_research_but_still_answers():
    import dspy

    calls = []

    def react(**kw):
        calls.append(1)
        raise _malformed()

    trace = ChatTrace()
    agent = r._retry_malformed_steps(_real_react(react, lambda **kw: dspy.Prediction(answer="from what I had")), trace)
    assert agent(question="q").answer == "from what I had"  # ReAct stopped and wrote the answer from the trajectory
    assert len(calls) == 2 and "still malformed" in trace.render()  # asked twice, not more


def test_an_answer_step_that_stays_malformed_saves_a_plain_reply_and_is_not_filed(monkeypatch, tmp_path):
    from app.chat_memory.organize import is_off_topic
    from app.corpus import Corpus

    def fake_react(signature, tools, max_iters):
        def run(**inputs):
            raise _malformed()
        return run

    @contextmanager
    def no_usage(lm):
        yield SimpleNamespace(prompt_tokens=0, completion_tokens=0)

    monkeypatch.setattr(r.dspy, "ReAct", fake_react)
    monkeypatch.setattr(r, "main_lm", lambda: SimpleNamespace(model="m"))
    monkeypatch.setattr(r, "track_usage", no_usage)
    monkeypatch.setattr(r, "triage", lambda *a: r.Triage("archive", "q", "quick", "", engine="jev"))
    corpus = Corpus(uuid.uuid4(), cache_dir=str(tmp_path))
    monkeypatch.setattr(corpus, "sync", lambda: {})
    t = ChatTrace()
    out = r.research(corpus, {"a.md": "On Pricing"}, "What did I charge?", trace=t)
    assert out.text == r.FAILED_REPLY and out.kind == "error" and out.unsupported and out.citations == []
    assert out.recall["failed"] == "malformed model reply" and "plain 'please send that again'" in t.render()
    round_ = SimpleNamespace(assistant=SimpleNamespace(recall_json={"kind": out.kind}, citations=[], content=out.text))
    assert is_off_topic(round_)  # the failure reply is never filed as a topic

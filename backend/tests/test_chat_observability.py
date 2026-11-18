"""Chat observability: the Langfuse trace of a message (stages, steps, writer generations, outcome tags), outcome codes,
ratings and judge scores sent as Langfuse scores, and that everything is a no-op when Langfuse is off."""

import asyncio
import json
import re
from types import SimpleNamespace

import pytest

from app.config import settings
from app.observability import langfuse_client as lf
from app.pipeline import research as r
from app.pipeline.research import ResearchResult, VerifiedCitation, outcome_of
from app.pipeline.trace import OUTCOMES, ChatTrace
from tests.test_buildout import auth, connect, docs, feed  # noqa: F401  (fixtures and helpers)


class FakeSpan:
    def __init__(self, store, name, as_type, kwargs):
        self.store, self.name, self.as_type, self.kwargs = store, name, as_type, kwargs
        self.updates: list[dict] = []
        self.attributes: dict = {}
        self.ended = False
        self._otel_span = SimpleNamespace(set_attribute=lambda k, v: self.attributes.__setitem__(k, v))

    def start_observation(self, *, name, as_type="span", **kwargs):
        child = FakeSpan(self.store, name, as_type, kwargs)
        self.store.append(child)
        return child

    def update(self, **kwargs):
        self.updates.append(kwargs)
        return self

    def end(self):
        self.ended = True


class FakeLangfuse:
    def __init__(self):
        self.observations: list[FakeSpan] = []
        self.scores: list[dict] = []
        self.flushed = 0

    def create_trace_id(self):
        return "a" * 32

    def start_observation(self, *, trace_context, name, as_type="span", **kwargs):
        root = FakeSpan(self.observations, name, as_type, {**kwargs, "trace_context": trace_context})
        self.observations.append(root)
        return root

    def create_score(self, **kwargs):
        self.scores.append(kwargs)

    def flush(self):
        self.flushed += 1


@pytest.fixture()
def langfuse(monkeypatch):
    fake = FakeLangfuse()
    monkeypatch.setattr(lf, "client", lambda: fake)
    monkeypatch.setattr(settings, "langfuse_mask_text", True)
    return fake


def test_without_langfuse_the_trace_works_as_before(monkeypatch):
    monkeypatch.setattr(settings, "langfuse_public_key", "")
    lf.reset_for_tests()
    trace = ChatTrace(notebook="nb", message="what about pricing?")
    assert trace.start_langfuse(user="u1", session="c1") == ""
    with trace.stage("triage") as obs:
        obs.update(metadata={"ignored": True})
    with trace.observe("writer", as_type="generation") as gen:
        gen.update(output="x")
    trace.step("search", "pricing")
    trace.set_outcome("answered")
    trace.emit()
    assert trace.stages[0][0] == "triage" and "outcome:answered" in trace.tags
    assert "outcome : answered" in trace.render()
    assert lf.score("t" * 32, "user_feedback", 1.0) is False


def test_the_message_trace_has_stages_steps_generations_and_outcome_tags(langfuse):
    trace = ChatTrace(chat_id="c1", notebook="nb", message="what about pricing?")
    assert trace.start_langfuse(user="user-1", session="c1", metadata={"notebook_id": "n1"}) == "a" * 32
    root = langfuse.observations[0]
    assert root.name == "notebook-chat" and root.kwargs["input"] == {"chars": 19}  # masked: size, not text
    assert root.attributes["session.id"] == "c1"
    assert root.attributes["user.id"] == lf.pseudonym("user-1") != "user-1"

    with trace.stage("prefetch"):
        pass
    trace.step("search", "pric(e|ing)")
    with pytest.raises(RuntimeError), trace.observe("writer: fast path", as_type="generation", model="m"):
        raise RuntimeError("stream broke")
    trace.add("triage", "FINAL : kind=archive")
    trace.add("steps", "search pric(e|ing)")  # writers' words: not sent while text is masked
    trace.set_outcome("cites_dropped")
    trace.tag("retrieval_empty")
    trace.output = "I could not find support"
    trace.emit()

    by_name = {o.name: o for o in langfuse.observations}
    assert by_name["prefetch"].as_type == "span" and by_name["prefetch"].ended
    assert by_name["step:search"].as_type == "event" and by_name["step:search"].kwargs["input"] == {"chars": 11}
    writer = by_name["writer: fast path"]
    assert writer.as_type == "generation" and writer.ended and writer.updates[-1]["level"] == "ERROR"
    assert root.ended and root.attributes["langfuse.trace.tags"] == ["outcome:cites_dropped", "retrieval_empty",
                                                                      "verdict:fail"]
    final = root.updates[-1]
    assert final["name"] == "FAIL · cites_dropped" == root.attributes["langfuse.trace.name"]
    assert final["level"] == "ERROR" and "none passed verification" in final["status_message"]
    assert langfuse.scores[-1]["name"] == "verdict" and langfuse.scores[-1]["value"] == "fail"
    assert final["output"] == {"chars": len("I could not find support")}
    assert final["metadata"]["outcome"] == "cites_dropped" and "prefetch" in final["metadata"]["stages_ms"]
    assert "triage" in final["metadata"]["sections"] and "steps" not in final["metadata"]["sections"]


@pytest.mark.parametrize("outcome, name, level", [
    ("answered", "PASS · answered", None), ("triage_off_topic", "REVIEW · triage_off_topic", "WARNING"),
    ("writer_uncovered", "FAIL · writer_uncovered", "ERROR"), ("timeout", "FAIL · timeout", "ERROR"),
])
def test_every_trace_says_pass_fail_or_review(langfuse, outcome, name, level):
    trace = ChatTrace(message="q")
    trace.start_langfuse()
    trace.set_outcome(outcome)
    trace.emit()
    final = langfuse.observations[0].updates[-1]
    assert final["name"] == name and final.get("level") == level
    assert langfuse.scores[-1]["value"] == name.split(" · ")[0].lower()


def test_unmasked_text_is_sent_only_when_masking_is_off(langfuse, monkeypatch):
    monkeypatch.setattr(settings, "langfuse_mask_text", False)
    trace = ChatTrace(notebook="nb", message="what about pricing?")
    trace.start_langfuse()
    trace.add("steps", "search pricing")
    trace.emit()
    root = langfuse.observations[0]
    assert root.kwargs["input"] == "what about pricing?"
    assert "steps" in root.updates[-1]["metadata"]["sections"]


def _cite():
    return VerifiedCitation(1, "sources/a/x.md", 3, 4, "q")


@pytest.mark.parametrize("result, expected", [
    (ResearchResult("ok", False, [_cite()], kind="archive", recall={"refused": False}), "answered"),
    (ResearchResult("no", True, [], kind="archive", recall={"refused": False, "model_unsupported": True}),
     "writer_uncovered"),
    (ResearchResult("no", True, [], kind="archive", recall={"refused": True, "proposed_cites": 0}), "refused_no_cites"),
    (ResearchResult("no", True, [], kind="archive", recall={"refused": True, "proposed_cites": 3}), "cites_dropped"),
    (ResearchResult("bye", False, [], kind="off_topic"), "triage_off_topic"),
    (ResearchResult("hi", False, [], kind="chitchat"), "triage_other"),
    (ResearchResult("x", False, [], kind="create"), "triage_other"),
    (ResearchResult("done", False, [], kind="external_action"), "external_done"),
    (ResearchResult("fail", True, [], kind="external_action"), "external_failed"),
    (ResearchResult(r.FAILED_REPLY, True, [], kind="error"), "agent_malformed"),
])
def test_every_result_gets_a_known_outcome_code(result, expected):
    assert outcome_of(result) == expected and expected in OUTCOMES


def test_a_refusal_records_how_many_citations_were_proposed_and_dropped():
    class Tools:
        allowed = {"sources/a/x.md": "X"}

        def quote(self, *_):
            return None  # every proposed line range fails verification

    cites = [SimpleNamespace(marker=1, path="sources/a/x.md", line_start=900, line_end=901)]
    text, kept = r.verify_citations(Tools(), "Claim [1].", cites)
    assert kept == [] and text == "Claim."  # no corpus to repair from: dropped, never invented


def test_a_client_that_leaves_early_is_tagged(monkeypatch):
    from app.routers import notebooks as nbr

    left: list[str] = []

    async def stream():
        for i in range(5):
            yield f"chunk {i}"
            await asyncio.sleep(0)

    async def main():
        reader = nbr._detached(stream(), keepalive=1.0, on_leave=lambda: left.append("gone"))
        first = await reader.__anext__()
        await reader.aclose()  # the phone locked
        return first

    assert asyncio.run(main()) == "chunk 0" and left == ["gone"]

    async def whole():
        reader = nbr._detached(stream(), keepalive=1.0, on_leave=lambda: left.append("again"))
        return [c async for c in reader]

    assert len(asyncio.run(whole())) == 5 and left == ["gone"]  # read to the end: not a leave


def test_chat_saves_outcome_and_trace_id_and_rating_becomes_a_score(client, auth, run_jobs, feed, monkeypatch,  # noqa: F811
                                                                    db_session, langfuse):
    from app.models import Job, Message
    from app.routers import notebooks as nbr

    connect(client, auth, run_jobs)
    doc = docs(client, auth)[0]
    nb = client.post("/api/notebooks", json={"title": "N", "document_ids": [doc["id"]]}, headers=auth).json()

    def fake_research(corpus, allowed, question, *a, **k):
        return ResearchResult("I could not find support", True, [], kind="archive",
                              recall={"path": "fast path", "refused": True, "proposed_cites": 2,
                                      "prefetch": {"passages": 0}})

    monkeypatch.setattr(nbr, "research", fake_research)
    monkeypatch.setattr(settings, "llm_api_key", "sk-test")
    monkeypatch.setattr(settings, "chat_judge_sample_rate", 1.0)
    body = client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "What about pricing?"},
                       headers=auth).text
    msg_id = json.loads(re.search(r"event: answer\ndata: (.*)", body).group(1))["message_id"]
    msg = db_session.get(Message, __import__("uuid").UUID(msg_id))
    db_session.refresh(msg)
    assert msg.recall_json["outcome"] == "cites_dropped" and msg.recall_json["trace_id"] == "a" * 32
    root = langfuse.observations[0]
    tags = root.attributes["langfuse.trace.tags"]
    assert {"outcome:cites_dropped", "kind:archive", "path:fast path", "retrieval_empty", "posts:1-10"} <= set(tags)
    assert db_session.query(Job).filter_by(kind="chat_judge").count() == 1

    client.put(f"/api/notebooks/messages/{msg_id}/feedback", json={"rating": "down", "reasons": ["missed"]},
               headers=auth)
    score = langfuse.scores[-1]
    assert score == {"name": "user_feedback", "value": -1.0, "trace_id": "a" * 32, "comment": "missed",
                     "score_id": f"{msg_id}-user_feedback"}


def test_no_judge_job_without_langfuse(client, auth, run_jobs, feed, monkeypatch, db_session):  # noqa: F811
    from app.models import Job
    from app.routers import notebooks as nbr

    monkeypatch.setattr(settings, "langfuse_public_key", "")
    lf.reset_for_tests()
    connect(client, auth, run_jobs)
    doc = docs(client, auth)[0]
    nb = client.post("/api/notebooks", json={"title": "N", "document_ids": [doc["id"]]}, headers=auth).json()
    monkeypatch.setattr(nbr, "research", lambda *a, **k: ResearchResult("ok", False, [_cite()], kind="archive"))
    monkeypatch.setattr(settings, "chat_judge_sample_rate", 1.0)
    client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "What about pricing?"}, headers=auth)
    assert db_session.query(Job).filter_by(kind="chat_judge").count() == 0


def test_the_judge_scores_a_refusal_as_false_when_the_notebook_held_the_answer(db_session, monkeypatch, langfuse):
    import uuid

    from app.pipeline import chat_judge

    msg = SimpleNamespace(id=uuid.uuid4(), role="assistant", chat_id=uuid.uuid4(), content="I could not find it",
                          citations=[], recall_json={"outcome": "refused_no_cites", "trace_id": "b" * 32})
    chat = SimpleNamespace(notebook_id=uuid.uuid4(), workspace_id=uuid.uuid4())
    db = SimpleNamespace(get=lambda model, _id: msg if model.__name__ == "Message" else chat,
                         commit=lambda: None)
    monkeypatch.setattr(chat_judge, "_question_for", lambda *_: "how do I get paid subscribers?")
    monkeypatch.setattr(chat_judge, "_judge_refusal", lambda *_: {"evidence_existed": True,
                                                                  "best_path": "sources/a/x.md", "reason": "it does"})
    monkeypatch.setattr(chat_judge, "fast_lm", lambda: None)
    out = chat_judge.judge_message(db, msg.id)
    assert out["evidence_existed"] is True and msg.recall_json["judge"]["best_path"] == "sources/a/x.md"
    assert langfuse.scores == [{"name": "false_refusal", "value": 1.0, "trace_id": "b" * 32, "comment": "it does",
                                "data_type": "BOOLEAN", "score_id": f"{msg.id}-false_refusal"}]

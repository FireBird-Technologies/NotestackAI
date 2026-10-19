"""Making things from the chat: "create a 10 minute audio overview" is routed to create, its settings are snapped to
the options the dialog offers, and the answer carries the dialog to open (live and when the chat is reloaded)."""

import json
import re
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from app.config import settings
from app.pipeline import create_intent as ci
from app.pipeline import research as r
from app.pipeline.trace import ChatTrace
from tests.test_chat_limit import _answer, _ask
from tests.test_chat_speed import _corpus
from tests.test_memory import _signup


def _raw(**kw):
    return {k: kw.get(k, "") for k in ("minutes", "slide_count", "hosts", "style", "difficulty", "question_types",
                                       "theme", "orientation", "voice", "language", "topic", "requests")}


# Snapping to the dialog's options


def test_audio_minutes_snap_to_the_nearest_length():
    assert ci.snap("audio_overview", _raw(minutes="10"))["minutes"] == "12"
    assert ci.snap("audio_overview", _raw(minutes="2"))["minutes"] == "3"
    assert ci.snap("audio_overview", _raw(minutes="5 minutes"))["minutes"] == "6"
    assert ci.snap("audio_overview", _raw(minutes="45"))["minutes"] == "12"
    assert "minutes" not in ci.snap("audio_overview", _raw())


def test_a_debate_gets_two_hosts_and_the_topic_becomes_the_focus():
    got = ci.snap("audio_overview", _raw(style="debate", hosts="1", topic="pricing"))
    assert got == {"style": "debate", "hosts": "2", "focus": "pricing"}


def test_slide_counts_snap_to_a_deck_length():
    assert ci.snap("slide_deck", _raw(slide_count="15"))["length"] == "long"
    assert ci.snap("slide_deck", _raw(slide_count="7"))["length"] == "short"
    assert ci.snap("slide_deck", _raw(slide_count="10"))["length"] == "default"
    got = ci.snap("slide_deck", _raw(style="presenter", theme="light", language="french"))
    assert got == {"format": "presenter", "theme": "light-space", "language": "French"}


def test_unknown_values_are_dropped_so_the_dialog_default_applies():
    assert ci.snap("slide_deck", _raw(theme="neon pink", language="Klingon", style="whatever")) == {}
    assert ci.snap("infographic", _raw(style="bubbles")) == {}


def test_quiz_level_and_question_types():
    got = ci.snap("quiz", _raw(difficulty="really difficult", question_types="fill in the blank, multiple choice"))
    assert got == {"level": "hard", "types": ["multiple_choice", "fill_blank"]}
    assert ci.snap("flashcards", _raw(difficulty="easy", topic="onboarding")) == {"level": "easy", "focus": "onboarding"}


def test_infographic_report_video_and_map():
    assert ci.snap("infographic", _raw(style="timeline", theme="white with orbits")) == {"style": "timeline",
                                                                                         "theme": "paper"}
    assert ci.snap("report", _raw(style="interactive", topic="AI")) == {"format": "interactive", "about": "AI"}
    assert ci.snap("report", _raw(style="study guide")) == {"format": "document", "template": "study_guide"}
    assert ci.snap("video", _raw(orientation="vertical for TikTok", voice="male", topic="hiring")) == {
        "aspect_ratio": "portrait", "voice_gender": "male", "focus": "hiring"}
    assert ci.snap("mind_map", _raw(topic="growth")) == {"focus": "growth"}


def test_the_reply_names_the_closest_match():
    raw = _raw(minutes="10", topic="pricing")
    text = ci.reply_text("audio_overview", ci.snap("audio_overview", raw), raw)
    assert text == ("Opening the audio overview settings: Long (about 12 min, the closest to the 10 you asked for), "
                    "about pricing. Check them and press Generate.")
    assert ci.reply_text("quiz", {}, _raw()) == "Opening the quiz settings. Check them and press Generate."


# Routing


@pytest.mark.parametrize("message", ["create an audio overview of 5 minutes", "Can you make me a hard quiz",
                                     "turn this into slides", "make a 7 slide presenter deck in French",
                                     "quiz me on onboarding", "I want a vertical video about hiring"])
def test_an_explicit_create_request_routes_to_create(message):
    route = r._phrase_rules(r.Triage("archive", message, "quick", ""), message, [])
    assert route.kind == "create"


@pytest.mark.parametrize("message", ["what did I write about audio?", "What did I make of the report?",
                                     "How do I add another Substack?", "do I have any posts about video?"])
def test_questions_are_not_create_requests(message):
    route = r._phrase_rules(r.Triage("archive", message, "quick", ""), message, [])
    assert route.kind == "archive"


@contextmanager
def _usage(lm):
    yield SimpleNamespace(prompt_tokens=7, completion_tokens=2)


def test_research_returns_the_action_without_the_agent(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    monkeypatch.setattr(r, "triage", lambda *a: r.Triage("create", a[0], "quick", "", engine="jev"))
    monkeypatch.setattr(settings, "chat_memory_read", False)
    monkeypatch.setattr(r.dspy, "ReAct", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no agent")))
    monkeypatch.setattr(ci, "triage_lm", lambda: SimpleNamespace(model="m"))
    monkeypatch.setattr(ci, "track_usage", _usage)

    class FakePredict:
        def __init__(self, sig):
            pass

        def __call__(self, **inputs):
            return SimpleNamespace(artifact="slide_deck", **{**_raw(slide_count="15", language="Spanish"),
                                                            "topic": "none"})

    monkeypatch.setattr(ci.dspy, "Predict", FakePredict)
    monkeypatch.setattr(ci.dspy, "context", lambda **k: contextmanager(lambda: (yield))())
    res = r.research(c, allowed, "make a 15 slide deck in Spanish", trace=ChatTrace())
    assert res.kind == "create" and res.citations == []
    assert res.action == {"artifact": "slide_deck", "settings": {"length": "long", "language": "Spanish"}}
    assert res.recall["action"] == res.action and res.prompt_tokens == 7
    assert res.text.startswith("Opening the slide deck settings: Long (12 to 16 slides)")


def test_a_failed_parse_falls_back_to_the_app_help(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    monkeypatch.setattr(r, "triage", lambda *a: r.Triage("create", a[0], "quick", "", engine="jev"))
    monkeypatch.setattr(settings, "chat_memory_read", False)

    def boom(*a):
        raise RuntimeError("model down")

    monkeypatch.setattr(r, "parse_create", boom)
    res = r.research(c, allowed, "make something", trace=ChatTrace())
    assert res.kind == "about_app" and res.action is None and "Studio panel" in res.text


# The chat endpoint


def test_the_answer_and_the_reloaded_chat_carry_the_action(client, monkeypatch):
    from app.routers import notebooks as nbr

    action = {"artifact": "audio_overview", "settings": {"minutes": "12"}}

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **kw):
        return r.ResearchResult("Opening the audio overview settings.", False, [], kind="create", question=question,
                                recall={"action": action}, action=action)

    monkeypatch.setattr(nbr, "research", fake_research)
    monkeypatch.setattr(settings, "chat_answer_cache_days", 0)
    auth = _signup(client, "ada@example.com")
    nb = client.post("/api/notebooks", json={"title": "N"}, headers=auth).json()
    resp = _ask(client, auth, nb, "create a 10 minute audio overview")
    assert resp.status_code == 200 and _answer(resp)["action"] == action
    chat_id = json.loads(re.search(r"event: status\ndata: (.*)", resp.text).group(1))["chat_id"]
    msgs = client.get(f"/api/notebooks/chats/{chat_id}/messages", headers=auth).json()
    assert msgs[-1]["action"] == action and msgs[0]["action"] is None


def test_a_topic_the_message_never_named_is_not_carried_over_from_the_chat():
    assert ci._from_message("onboarding checklists", "make a 15 slide deck in Spanish") is False
    assert ci._from_message("onboarding checklists", "turn this into slides") is True
    assert ci._from_message("AI", "an interactive report on AI") is True
    assert ci._from_message("", "make a quiz") is True

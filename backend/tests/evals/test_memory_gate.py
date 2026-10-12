"""The memory gate: Jev decides whether a chat message is worth an extraction call.

These tests pin the gate so nobody changes it by accident:
- the Jev wording and the skip threshold (static tests, always run),
- the decision rule (fake Jev, always run),
- the labeled messages below, checked against the real Jev (live test, off unless a key is supplied).

The messages are the ones the wording was tuned on (2026-09-30). The old wording skipped 4 of the 15 messages that
should be saved, including a real one ("Im a writer and have been asisgend..."), because Jev answered "no" with high
confidence. The current wording skips none of them and still skips 12 of the 14 that need no memory. Each row records
Jev's chance of "yes" under the old and the current wording (one run each; Jev varies a little between runs).

Run the live test after touching JEV_REMEMBER, JEV_REMEMBER_QUESTION or MEMORY_SKIP_CONFIDENCE:

    LIVE_EVALS=1 pytest tests/evals/test_memory_gate.py -k live

It reads TYPESAFE_API_KEY from the same .env files the app uses (set JEV_LIVE_TEST_KEY to use a different key). It is
opt-in because it makes about 30 real calls to TypeSafe and sends the messages below to them.
"""

import os

import pytest

from app.config import settings
from app.pipeline import memory as gate
from app.pipeline import research
from app.services import jev
from tests.evals.live import env_value


def live_key() -> str:
    """The TypeSafe key for the live test (JEV_LIVE_TEST_KEY overrides the one in .env)."""
    return os.environ.get("JEV_LIVE_TEST_KEY") or env_value("TYPESAFE_API_KEY")


REAL_MESSAGE = ("Im a writer and have been asisgend. atask to wriet an article on eval and bechnamrks but shoudl hve a "
                "uniur stuff with references as well so make a nice blogpost on it")

# (kind, message, Jev's chance of "yes" with the old wording, and with the current wording)
SHOULD_SAVE = [
    ("role", "As a freelance journalist covering fintech, what have I written about pricing models?", 0.01, 0.97),
    ("role", "I run a newsletter for indie hackers, so find the posts where I talk about churn.", 0.56, 1.00),
    ("role", "Being a solo founder, I always struggle with focus. Which of my posts touch on that?", 0.29, 0.99),
    ("audience", "My readers are mostly product managers, so summarize my take on roadmaps for them.", 0.90, 0.99),
    ("audience", "I write for complete beginners, so explain what I said about SEO in simple terms.", 0.93, 1.00),
    ("answer style", "Keep it short please. What did I say about pricing?", 0.04, 0.77),
    ("answer style", "I hate bullet points, so give me prose: summarize my posts on AI.", 0.97, 0.98),
    ("answer style",
     "English isn't my first language, so use simple words. What are my main ideas on habits?", 0.97, 1.00),
    ("project", "I'm working on a book about remote work. Pull my best posts on it.", 0.23, 0.99),
    ("goal", "I'm trying to reach 10k subscribers this year, which topics should I lean into?", 0.42, 0.96),
    ("term",
     "When I say 'runway' I mean personal savings, not startup cash. What have I written about runway?", 0.79, 0.98),
    ("constraint", "Ignore anything before 2022, my views changed a lot since. What's my take on pricing?", 0.29, 0.36),
    ("background",
     "I'm based in Lagos and write in British English. Draft a post from my notes on mobile payments.", 0.94, 0.99),
    ("mixed", "I'm a marketing lead assigned to write a report on churn, so make a solid summary with references.",
     0.47, 0.99),
    ("mixed, real message", REAL_MESSAGE, 0.13, 0.97),
]
SHOULD_NOT_SAVE = [
    ("plain question", "What did I write about pricing?", 0.00, 0.00),
    ("plain question", "Summarize my post on habits.", 0.00, 0.00),
    ("follow up", "Tell me more about that.", 0.00, 0.00),
    ("small talk", "Thanks, that helps!", 0.00, 0.00),
    ("task", "Which post is most worth updating, and why?", 0.00, 0.00),
    ("off topic", "Write me a python script to rename files.", 0.00, 0.00),
    ("compare", "Compare my 2023 and 2024 posts on AI.", 0.00, 0.00),
    ("someone else", "My friend is a writer. What did I say about interviews?", 0.00, 0.23),
    ("hypothetical", "If I were a founder, how would my pricing posts apply?", 0.00, 0.16),
    ("temporary", "I'm tired today, what did I write about burnout?", 0.00, 0.02),
    ("plain request", "Write a blog post from my archive about evals and benchmarks with references.", 0.00, 0.05),
    ("plain request", "make me a nice article on pricing using only what I wrote before", 0.00, 0.02),
    ("plain request", "Draft an outline for a report on churn using my posts, with links to the sources.", 0.00, 0.31),
    ("plain request", "Can you give me a summary of everything I've said about hiring, with quotes?", 0.00, 0.01),
]
# With the current wording, at most this many of the SHOULD_NOT_SAVE messages may run the extractor (a harmless
# extra call). The recorded run had 3; the live test allows a little more for Jev's run to run variation.
MAX_EXTRA_RUNS = 4


# The wording and threshold, pinned


def test_the_wording_says_a_fact_can_sit_inside_a_request():
    yes, no = gate.JEV_REMEMBER["yes"], gate.JEV_REMEMBER["no"]
    assert "even inside a question or a task" in yes["what"]
    for topic in ("job or role", "who they write for", "how they want answers written", "project or goal",
                  "term they use in a special way"):
        assert topic in yes["what"]
    assert yes["examples"] == [
        "As a food blogger, summarize my posts about baking",
        "Please be brief. What did I write about hiring?",
        "I teach high school physics, so find posts that would suit students",
        "I'm a consultant preparing a report on onboarding, draft an outline from my notes",
    ]
    assert "says nothing lasting about the writer themselves" in no["what"]
    assert set(gate.JEV_REMEMBER) == {"yes", "no"}


def test_the_question_and_criteria_are_what_jev_receives(monkeypatch):
    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    seen = {}

    def decide(state, questions, timeout=6.0):
        seen.update(state=state, questions=questions)
        return {"remember": jev.Choice("no", 1.0, {})}

    monkeypatch.setattr(jev, "decide", decide)
    gate.worth_remembering("hello")
    assert seen["state"] == {"message": "hello"}
    assert seen["questions"]["remember"]["instructions"] == (
        "Does this message from a writer state something lasting that a research assistant should remember for "
        "every future chat?")
    assert seen["questions"]["remember"]["criteria"] is gate.JEV_REMEMBER


def test_the_skip_threshold_is_its_own_setting():
    assert gate.MEMORY_SKIP_CONFIDENCE == 0.8
    assert not hasattr(gate, "JEV_MIN_CONFIDENCE")  # the chat triage threshold must not decide this gate


@pytest.mark.parametrize("choice,confidence,runs", [
    ("yes", 0.99, True),  # a "yes" always runs, however sure
    ("yes", 0.10, True),
    ("no", 0.98, False),  # both of these were wrongly skipped in the old test set only because the wording was
    ("no", 0.80, False),  # narrow; with a firm "no" the extractor is skipped
    ("no", 0.79, True),   # just under the threshold: the extractor decides
    ("no", 0.55, True),   # the old threshold no longer skips
    ("no", 0.04, True),
])
def test_the_decision_rule(monkeypatch, choice, confidence, runs):
    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    monkeypatch.setattr(jev, "decide", lambda *a, **k: {"remember": jev.Choice(choice, confidence, {})})
    assert gate.worth_remembering("anything") is runs


def test_the_chat_triage_threshold_does_not_change_the_gate(monkeypatch):
    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    monkeypatch.setattr(jev, "decide", lambda *a, **k: {"remember": jev.Choice("no", 0.7, {})})
    monkeypatch.setattr(research, "JEV_MIN_CONFIDENCE", 0.0)
    assert gate.worth_remembering("anything") is True


def test_the_extractor_runs_when_jev_is_off_or_down(monkeypatch):
    monkeypatch.setattr(settings, "typesafe_api_key", "")
    assert gate.worth_remembering("anything") is True
    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")

    def down(*a, **k):
        raise jev.JevError("down")

    monkeypatch.setattr(jev, "decide", down)
    assert gate.worth_remembering("anything") is True


# The labeled messages, pinned


def test_the_labeled_messages_are_intact():
    assert len(SHOULD_SAVE) == 15 and len(SHOULD_NOT_SAVE) == 14
    assert any(message == REAL_MESSAGE for _, message, _, _ in SHOULD_SAVE)
    everything = SHOULD_SAVE + SHOULD_NOT_SAVE
    assert len({message for _, message, _, _ in everything}) == len(everything)  # no duplicates
    # The recorded results say the old wording missed messages and the current wording does not.
    assert sum(old < 0.3 for *_, old, _ in SHOULD_SAVE) >= 4
    assert all(new >= 0.3 for *_, new in SHOULD_SAVE)


@pytest.mark.skipif(not os.environ.get("LIVE_EVALS"), reason="opt in with LIVE_EVALS=1 (calls the real Jev)")
@pytest.mark.skipif(not live_key(), reason="no TYPESAFE_API_KEY found in .env")
def test_live_jev_never_skips_a_message_that_should_be_saved(monkeypatch):
    monkeypatch.setattr(settings, "typesafe_api_key", live_key())
    skipped = [message for _, message, *_ in SHOULD_SAVE if not gate.worth_remembering(message)]
    assert skipped == [], f"the gate would lose a note for: {skipped}"
    extra_runs = [message for _, message, *_ in SHOULD_NOT_SAVE if gate.worth_remembering(message)]
    assert len(extra_runs) <= MAX_EXTRA_RUNS, f"too many ordinary messages now cost a call: {extra_runs}"

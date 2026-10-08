"""Chat memory: does the model file a chat's rounds under the right topics?

The static tests pin the prompts and the labeled scenarios and always run. The live tests (opt-in) run the real model on
scripted chats, the one that motivated the feature first: a chat about evals and benchmarks, a detour about Obama's
birthday, then a follow up that only makes sense against the evals topic.

    LIVE_EVALS=1 pytest tests/evals/test_chat_recall.py -k live

It uses LLM_API_KEY from the app's .env files and makes about 4 calls on the fast model. Run it after touching
OrganizeChat in app/llm/signatures.py."""

import os

import dspy
import pytest

from app.chat_memory import files
from app.chat_memory.context import JEV_MEMORY, MEMORY_LEVELS
from app.config import settings
from app.llm import provider
from app.llm.signatures import OrganizeChat, ResearchArchiveWithMemory, TriageWithMemory
from tests.evals.live import env_value

PROMPT = " ".join(OrganizeChat.__doc__.split())


def test_the_organizer_prompt_files_by_topic_and_keeps_the_old_details():
    assert "Continue the most recent topic unless the round clearly starts something else" in PROMPT
    assert "Reopen an older topic when the round belongs to it" in PROMPT
    assert "a one off question (for example the date of someone's birthday) is also a topic of its own" in PROMPT
    assert "Use SKIP only for greetings and thanks" in PROMPT
    assert "extend it and keep what still matters, so earlier details survive" in PROMPT


def test_the_organizer_prompt_keeps_summaries_honest_and_synonyms_in():
    assert "State who said what" in PROMPT and "name the post paths the assistant used" in PROMPT
    assert "the summary says what was discussed, not what is true" in PROMPT
    assert "the other words a writer might later use for the same thing (synonyms, related terms)" in PROMPT
    assert "Use only labels that appear in the rounds" in PROMPT
    assert "Never use em dashes" in PROMPT
    assert set(OrganizeChat.input_fields) == {"topics", "rounds"}
    assert set(OrganizeChat.output_fields) == {"assignments", "updates"}


def test_the_read_side_prompts_treat_chat_notes_as_context_not_evidence():
    agent = " ".join(ResearchArchiveWithMemory.__doc__.split())
    assert "never as evidence about the posts" in agent and "cite only text you read from the posts" in agent
    assert "each such place is a citation" in agent and "exact=true for a literal phrase" in agent
    triage = " ".join(TriageWithMemory.__doc__.split())
    assert all(level in triage for level in MEMORY_LEVELS)
    assert set(ResearchArchiveWithMemory.input_fields) >= {"question", "chat_memory"}


def test_every_memory_level_has_examples_and_no_example_is_shared():
    assert set(JEV_MEMORY) == set(MEMORY_LEVELS)
    seen = [e for c in JEV_MEMORY.values() for e in c["examples"]]
    assert len(seen) == len(set(seen)) and all(c["examples"] for c in JEV_MEMORY.values())


# The scripted chats. Each round is (question, answer).

EVALS = [
    ("What have I written about evals and benchmarks?",
     "You argued MMLU is saturated and that benchmark scores hide failure modes. Your post 'Benchmarks are broken' "
     "says to build your own eval set. [1]"),
    ("Which benchmarks are best for small models?",
     "The best benchmarks for small models are 1. GSM8K, 2. ARC and 3. HellaSwag, because they are cheap to run [1]."),
]
OBAMA = [
    ("When is Obama's birthday?", "Barack Obama was born on August 4, 1961."),
    ("And how old is he now?", "He is 65 as of 2026."),
]
PRICING = [
    ("What did I say about raising prices?",
     "You moved the paid tier from $5 to $8 a month and churn stayed flat [1]."),
]


def render(rounds, start=1):
    """The prompt text for scripted rounds, labeled the way the job labels them."""
    out, n = [], 0
    for i, (q, a) in enumerate(rounds, start=start):
        out += [f"r{i}", f"m{n + 1} Writer: {q}", f"m{n + 2} Assistant: {a}", ""]
        n += 2
    return "\n".join(out).strip()


def organize(topics: str, rounds_text: str) -> dict:
    lm = dspy.LM(settings.llm_fast_model, api_base=settings.llm_api_base, api_key=env_value("LLM_API_KEY"),
                 temperature=settings.llm_temperature, max_tokens=8000, cache=False, **provider._extra_kwargs("low"))
    with dspy.context(lm=lm, adapter=dspy.JSONAdapter()):  # the adapter the app uses
        out = dspy.Predict(OrganizeChat)(topics=topics, rounds=rounds_text)
    return {"assignments": {a.round: a.topic for a in out.assignments},
            "updates": {u.topic: u for u in out.updates}}


def test_the_scripted_chats_are_intact():
    assert len(EVALS) == 2 and len(OBAMA) == 2 and len(PRICING) == 1
    assert "r1" in render(EVALS) and "m4 Assistant" in render(EVALS)


@pytest.mark.skipif(not os.environ.get("LIVE_EVALS"), reason="opt in with LIVE_EVALS=1 (calls the real model)")
@pytest.mark.skipif(not env_value("LLM_API_KEY"), reason="no LLM_API_KEY found in .env")
class TestLiveOrganizer:
    def test_a_detour_becomes_its_own_topic(self):
        out = organize("(none)", render(EVALS + OBAMA))
        # The model may write the same new topic as "NEW:Evals" in one round and "Evals" in the next. The job reads both
        # as one topic (it compares slugs), so the eval does too.
        a = {r: files.topic_slug(t.removeprefix("NEW:").removeprefix("new:")) for r, t in out["assignments"].items()}
        assert a["r1"] == a["r2"], out["assignments"]  # both evals rounds together
        assert a["r3"] == a["r4"] and a["r3"] != a["r1"], out["assignments"]  # the detour is a separate topic
        by_slug = {files.topic_slug(t.removeprefix("NEW:").removeprefix("new:")): u for t, u in out["updates"].items()}
        evals, obama = by_slug[a["r1"]], by_slug[a["r3"]]
        assert "obama" not in evals.summary.lower() and "benchmark" in evals.summary.lower()
        assert "obama" in obama.summary.lower() or "birthday" in obama.summary.lower()

    def test_coming_back_after_a_detour_reopens_the_old_topic(self):
        topics = ("evals-and-benchmarks | Evals and benchmarks | Research on evals | eval, benchmark, mmlu\n"
                  "obama-birthday | Obama birthday | A one off date question | obama, birthday\n\n"
                  "Summary of evals-and-benchmarks: The writer asked about benchmarks. The assistant said MMLU is "
                  "saturated and ranked GSM8K, ARC and HellaSwag best for small models.\n"
                  "Summary of obama-birthday: The writer asked when Obama was born and his age.")
        rounds = [("Which of those benchmarks did you say was best?", "I said GSM8K was the first choice.")]
        out = organize(topics, render(rounds))
        assert out["assignments"]["r1"] == "evals-and-benchmarks", out["assignments"]
        assert "gsm8k" in out["updates"]["evals-and-benchmarks"].summary.lower()  # earlier details survive

    def test_keywords_carry_synonyms_so_a_related_word_can_find_the_topic(self):
        out = organize("(none)", render(PRICING))
        update = next(iter(out["updates"].values()))
        words = " ".join(update.keywords).lower()
        assert any(w in words for w in ("fee", "cost", "charge", "subscription")), update.keywords

    def test_the_assistants_key_answer_is_chosen_for_keeping(self):
        out = organize("(none)", render(EVALS))
        update = next(iter(out["updates"].values()))
        assert "m4" in update.keep, update.keep  # the ranking is the answer worth saving word for word
        assert all(k in {"m1", "m2", "m3", "m4"} for k in update.keep)

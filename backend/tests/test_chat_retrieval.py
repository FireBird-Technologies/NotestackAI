"""Chat retrieval: the search tool's robustness fixes, long paragraphs, citation repair, post cards, and the router
(Tier A whole notebook, Tier B cards + passages, Tier C agent)."""

import json
import uuid
from types import SimpleNamespace

import httpx
import pytest

from app.config import settings
from app.corpus import Corpus, ScopedTools, card_rel, render_post, split_long
from app.llm.signatures import FileCitation
from app.pipeline import cards as cards_mod
from app.pipeline import context_router as cr
from app.pipeline import prefetch as pf
from app.pipeline import research as r
from app.pipeline import writer as w
from app.pipeline.trace import ChatTrace
from app.services import jev
from tests.test_chat_speed import _archive, _corpus, _no_agent, _writer

LONG = "x " * 400 + "the paid tier is generous " + "y " * 400


# The search tool


def test_one_missing_post_does_not_fail_the_whole_search(tmp_path):
    c, allowed = _corpus(tmp_path)
    tools = ScopedTools(c, {**allowed, "sources/x/gone.md": "Gone"})
    out = tools.search("raise prices")
    assert "sources/x/pricing.md:7" in out and "1 post(s) could not be read" in out


def test_a_hit_deep_in_a_long_line_shows_the_match(tmp_path):
    c = Corpus(uuid.uuid4(), cache_dir=str(tmp_path))
    c.write_files({"sources/x/long.md": f"# T\n\n{LONG}\n"})
    out = ScopedTools(c, {"sources/x/long.md": "T"}).search("paid tier")
    assert "the paid tier is generous" in out and out.count("...") >= 1


def test_posts_with_more_matches_come_first(tmp_path):
    c = Corpus(uuid.uuid4(), cache_dir=str(tmp_path))
    c.write_files({"sources/x/a.md": "# A\n\npricing once\n", "sources/x/b.md": "# B\n\npricing\n\npricing again\n"})
    out = ScopedTools(c, {"sources/x/a.md": "A", "sources/x/b.md": "B"}).search("pricing")
    assert out.splitlines()[0].startswith("sources/x/b.md")


def test_read_is_capped_by_characters_too(tmp_path):
    c = Corpus(uuid.uuid4(), cache_dir=str(tmp_path))
    c.write_files({"sources/x/big.md": "\n".join("z" * 5000 for _ in range(10))})
    out = ScopedTools(c, {"sources/x/big.md": "Big"}).read("sources/x/big.md")
    assert len(out) < 13_000 and "more lines" in out


def test_long_paragraphs_are_stored_as_several_lines_of_one_paragraph():
    para = " ".join(f"Sentence number {i} says something useful." for i in range(120))
    pieces = split_long(para)
    assert len(pieces) > 1 and all(len(p) <= 1_500 for p in pieces) and " ".join(pieces) == para
    text = render_post(title="T", url="u", published_at=None, source="s", sections=[(None, para)])
    body = text.split("# T\n\n", 1)[1].rstrip("\n").split("\n")
    assert body == pieces  # consecutive lines, no blank line between: still one paragraph
    assert split_long("```py\n" + "a" * 3000 + "\n```") == ["```py\n" + "a" * 3000 + "\n```"]


@pytest.mark.parametrize("message, expected", [
    ("explain how to use it", True), ("give me a brief intro of him", True), ("why?", True),
    ("what about hiring?", True), ("tell me more about the second point", True), ("you said it was yearly", True),
    ("what is bloghub?", False), ("What are the strongest ideas across these posts?", False),
    ("How do I price my newsletter when it has fewer than a thousand readers?", False),
    ("What did I write about pricing and why it matters for creators?", False),
])
def test_refers_back_only_for_real_follow_ups(message, expected):
    assert r.refers_back(message) is expected


def test_writing_about_writing_keeps_the_word_write():
    assert pf.content_words("what did I write?") == []
    assert pf.content_words("have I ever written about it") == []
    assert "writ" in pf.content_words("how do I write a better intro?")
    assert "intro" in pf.content_words("how do I write a better intro?")


# Citation repair


def test_a_citation_with_wrong_line_numbers_is_repaired_from_the_cited_sentence(tmp_path):
    c, allowed = _corpus(tmp_path)
    tools = ScopedTools(c, allowed)
    cites = [SimpleNamespace(marker=1, path="sources/x/pricing.md", line_start=90, line_end=92)]
    text, kept = r.verify_citations(tools, "A paid tier works best when the free tier stays generous [1].", cites)
    assert kept and kept[0].line_start == 8 and kept[0].repaired and text.endswith("[1].")


def test_a_citation_that_matches_nothing_is_still_dropped(tmp_path):
    c, allowed = _corpus(tmp_path)
    cites = [SimpleNamespace(marker=1, path="sources/x/pricing.md", line_start=90, line_end=92)]
    _, kept = r.verify_citations(ScopedTools(c, allowed), "Kubernetes clusters scale horizontally [1].", cites)
    assert kept == []


# Jev


def test_jev_tries_once_more_when_the_connection_drops(monkeypatch):
    monkeypatch.setattr(settings, "typesafe_api_key", "k")
    monkeypatch.setattr(jev, "RETRY_DELAY", 0)
    calls = []

    def post(*a, **k):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("[SSL: UNEXPECTED_EOF_WHILE_READING]")
        return httpx.Response(200, json={"answers": {"intent": {"choice": "archive", "confidence": 0.9}}})

    monkeypatch.setattr(jev.httpx, "post", post)
    assert jev.decide({}, {"intent": {}})["intent"].choice == "archive" and len(calls) == 2


# Post cards

CARD = {"version": 1, "title": "On Pricing", "summary": "How to charge readers.", "topics": ["monetization"],
        "entities": ["Substack"], "synonyms": ["what to charge", "subscription cost", "paying members"],
        "questions": ["How much should I charge?"]}


def _with_cards(c, cards):
    manifest = c.sync()
    c.write_files({card_rel(p): json.dumps({**card, "post_hash": manifest[p]}) for p, card in cards.items()})
    return c.sync()


def test_build_cards_writes_a_card_per_post_and_skips_up_to_date_ones(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    made = []
    monkeypatch.setattr(cards_mod, "make_card", lambda title, text: made.append(title) or {**CARD, "title": title})
    assert cards_mod.build_cards(c, allowed) == {"made": 2, "failed": 0, "up_to_date": 0}
    assert cards_mod.load_cards(c, allowed)["sources/x/pricing.md"]["synonyms"][0] == "what to charge"
    assert cards_mod.build_cards(c, allowed) == {"made": 0, "failed": 0, "up_to_date": 2} and len(made) == 2


def test_a_removed_post_takes_its_card_with_it(tmp_path):
    c, allowed = _corpus(tmp_path)
    _with_cards(c, {"sources/x/pricing.md": CARD})
    c.write_files({}, remove={"sources/x/pricing.md"})
    assert card_rel("sources/x/pricing.md") not in c.sync()


def test_a_question_in_other_words_finds_the_post_through_its_card(tmp_path):
    c, allowed = _corpus(tmp_path)
    question = "what subscription cost should paying members see?"
    assert pf.prefetch(c, allowed, c.sync(), question).passages == []  # the post never says these words
    manifest = _with_cards(c, {"sources/x/pricing.md": CARD})
    cards = cards_mod.load_cards(c, allowed)
    got = pf.prefetch(c, allowed, manifest, question, cards=cards)
    assert got.passages and got.passages[0][1].path == "sources/x/pricing.md"
    found = pf.retrieve(c, allowed, manifest, cards, [question])
    assert found.posts[0] == "sources/x/pricing.md"


# The router


def _router(monkeypatch, full_tokens=60_000):
    _archive(monkeypatch)
    monkeypatch.setattr(settings, "chat_router", True)
    monkeypatch.setattr(settings, "chat_query_expansion", False)
    monkeypatch.setattr(settings, "chat_full_notebook_tokens", full_tokens)


def test_a_small_notebook_is_read_whole_in_one_call(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _router(monkeypatch)
    calls = _writer(monkeypatch, "Hire slowly [1].",
                    [FileCitation(marker=1, path="sources/x/hiring.md", line_start=7, line_end=7)])
    _no_agent(monkeypatch)
    t = ChatTrace()
    res = r.research(c, allowed, "What is my advice on bringing people onto the team?", on_delta=lambda x: None,
                     trace=t)
    assert res.recall["path"] == "tier A" and res.recall["router"]["tier"] == "A" and len(calls) == 1
    assert "7| Hire slowly" in calls[0]["evidence"] and "7| Raise prices" in calls[0]["evidence"]
    assert "tier:A" in t.tags and r.outcome_of(res) == "answered"


def test_when_the_whole_notebook_does_not_cover_it_the_answer_says_so_without_the_agent(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _router(monkeypatch)

    def uncovered(*a, **k):
        raise w.WriterUncovered("no")

    monkeypatch.setattr(w, "stream_answer", uncovered)
    _no_agent(monkeypatch)
    res = r.research(c, allowed, "What is my take on Kubernetes?", on_delta=lambda x: None, trace=ChatTrace())
    assert res.unsupported and "do not cover" in res.text and r.outcome_of(res) == "writer_uncovered"


def test_a_big_notebook_sends_the_posts_its_cards_point_to(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _with_cards(c, {"sources/x/pricing.md": CARD})
    _router(monkeypatch, full_tokens=1)  # everything is "too big": Tier B
    calls = _writer(monkeypatch, "Charge for depth [1].",
                    [FileCitation(marker=1, path="sources/x/pricing.md", line_start=8, line_end=8)])
    _no_agent(monkeypatch)
    t = ChatTrace()
    res = r.research(c, allowed, "what subscription cost should paying members see?", on_delta=lambda x: None,
                     trace=t)
    assert res.recall["path"] == "tier B" and res.recall["router"]["tier"] == "B"
    assert calls[0]["evidence"].startswith("FILE sources/x/pricing.md") and "hiring" not in calls[0]["evidence"]
    assert res.recall["prefetch"]["posts"] >= 1 and "cards:some" in t.tags


def test_a_tier_b_miss_hands_its_evidence_to_the_agent(monkeypatch, tmp_path):
    c, allowed = _corpus(tmp_path)
    _router(monkeypatch, full_tokens=1)
    _writer(monkeypatch, "Not covered.", [], unsupported=True)
    ran = []

    def fake_react(signature, tools, max_iters):
        def run(**inputs):
            ran.append(inputs["prefetched"])
            return SimpleNamespace(answer="Raise prices yearly [1].", unsupported=False,
                                   citations=[SimpleNamespace(marker=1, path="sources/x/pricing.md", line_start=7,
                                                              line_end=7)])
        return run

    monkeypatch.setattr(r.dspy, "ReAct", fake_react)
    t = ChatTrace()
    res = r.research(c, allowed, "how often do I raise prices?", on_delta=lambda x: None, trace=t)
    assert ran and "Raise prices" in ran[0] and res.recall["path"] == "research agent"
    assert res.recall["router"]["tier"] == "B>C" and "tier:C" in t.tags


def test_tier_b_evidence_fits_the_budget(tmp_path):
    c, allowed = _corpus(tmp_path)
    found = pf.retrieve(c, allowed, c.sync(), {}, ["raise prices paid tier", "hire slowly"])
    ev = cr.tier_b_evidence(c, allowed, found, budget_chars=10_000)
    assert ev.posts and ev.whole == len(ev.posts) and len(ev.text) <= 10_000
    small = cr.tier_b_evidence(c, allowed, found, budget_chars=150)
    assert len(small.text) <= 150


def test_the_answer_cache_changes_with_the_pipeline(monkeypatch):
    from app.routers import notebooks as nbr

    nid = uuid.uuid4()
    monkeypatch.setattr(settings, "chat_router", False)
    off = nbr.answer_cache_key(nid, "q", [], "")
    monkeypatch.setattr(settings, "chat_router", True)
    assert nbr.answer_cache_key(nid, "q", [], "") != off


# Off topic triage that only saw the titles

RESUME = """---
title: Muhammad Mehdi Resume
---

# Muhammad Mehdi Resume

Software Engineer with experience in full-stack development across multiple technology stacks.

## Experience

Engineered AI-driven content-to-video pipelines for Blog2Video using DSPy, enabling automated video generation.
"""


def _resume(tmp_path):
    c = Corpus(uuid.uuid4(), cache_dir=str(tmp_path))
    c.write_files({"sources/u/resume.md": RESUME})
    return c, {"sources/u/resume.md": "Muhammad Mehdi Resume"}


def _off_topic(monkeypatch):
    _archive(monkeypatch)
    monkeypatch.setattr(r, "triage", lambda *a, **k: r.Triage("off_topic", a[0], "quick", "", engine="jev"))
    rechecked = []
    monkeypatch.setattr(r, "recheck_off_topic", lambda route, *a: rechecked.append(1) or route)
    return rechecked


def test_an_off_topic_call_is_overruled_when_the_posts_mention_the_subject(monkeypatch, tmp_path):
    c, allowed = _resume(tmp_path)
    rechecked = _off_topic(monkeypatch)
    monkeypatch.setattr(settings, "chat_fast_path", True)
    _writer(monkeypatch, "Blog2Video is built with DSPy [1].",
            [FileCitation(marker=1, path="sources/u/resume.md", line_start=11, line_end=11)])
    _no_agent(monkeypatch)
    res = r.research(c, allowed, "what is the tech stack for blog2video?", on_delta=lambda x: None, trace=ChatTrace())
    assert res.kind == "archive" and res.citations and "DSPy" in res.text
    assert any("the posts mention" in n and "blog2video" in n for n in res.recall["triage_detail"]["notes"])
    assert rechecked == []  # the keyword check settled it: no second Jev call


def test_a_really_off_topic_question_still_gets_the_brush_off(monkeypatch, tmp_path):
    c, allowed = _resume(tmp_path)
    rechecked = _off_topic(monkeypatch)
    _no_agent(monkeypatch)
    res = r.research(c, allowed, "What is the capital of France?", on_delta=lambda x: None, trace=ChatTrace())
    assert res.kind == "off_topic" and rechecked == [1]

"""Reports built around themes: the posts' stored ideas are grouped into weighted themes, a blueprint plans the whole report, each
section is written from its own evidence. The model is always faked here (by signature name, as the other report tests do)."""

import logging
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.config import settings
from app.corpus import Corpus
from app.llm import run
from app.models import Document, Workspace
from app.pipeline import report_blueprint, report_evidence, report_themes
from app.pipeline.generate import ideas_fresh
from app.pipeline.report_blueprint import Blueprint, Section
from app.pipeline.report_themes import Idea, Theme, ThemesUnavailable
from tests.conftest import last_code
from tests.test_idea_pool import _notebook, make_posts


@pytest.fixture()
def owner(client, db_session):
    client.post("/api/auth/email/register/start", json={"email": "ada@example.com", "password": "stardust-42", "name": "Ada"})
    r = client.post("/api/auth/email/register/verify", json={"email": "ada@example.com", "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}, db_session.scalar(select(Workspace))


def fake_doc() -> SimpleNamespace:
    return SimpleNamespace(id=uuid.uuid4(), path="sources/x/a.md", title="A")


def theme(tid: str, name: str, posts: int, *, asked: bool = False, tier: str = "minor", weight: float = 0.1) -> Theme:
    t = Theme(id=tid, name=name, summary=f"About {name}.", ideas=[Idea(f"{tid}.{n}", fake_doc(), f"{name} {n}", "n") for n in range(posts)],
              asked=asked)
    t.tier, t.weight, t.pinned = tier, weight, asked
    return t


# Weights are counted in code


def test_weights_come_from_counting_posts_and_ideas_and_a_priority_theme_moves_up():
    a, b, c = theme("t1", "A", 8), theme("t2", "B", 4), theme("t3", "C", 1, asked=True)
    themes = [a, b, c]
    report_themes.weigh(themes, total_posts=13, total_ideas=13)
    assert round(sum(t.weight for t in themes), 3) == 1.0
    assert (a.weight, b.weight, c.weight) == (0.6154, 0.3077, 0.0769)
    assert (a.tier, b.tier) == ("major", "major")
    assert c.tier == "medium" and c.pinned  # minor by share, asked for: one tier up and pinned


def test_the_heaviest_theme_is_major_even_when_the_weights_are_flat():
    themes = [theme(f"t{n}", f"T{n}", 3) for n in range(1, 11)]  # ten equal themes: 0.1 each, medium
    report_themes.weigh(themes, total_posts=30, total_ideas=30)
    assert sum(t.tier == "major" for t in themes) == 1


# Grouping: the model names themes, code files what it left out


def _ideas(db_session, ws, n=8):
    docs = make_posts(db_session, ws, n, ideas_each=2)
    corpus = Corpus(ws.id)
    corpus.sync()
    return docs, report_themes.collect_ideas(docs, corpus)


def test_ideas_the_model_left_out_are_filed_by_code_and_the_rest_are_dropped_or_caught(owner, db_session, monkeypatch):
    _, ws = owner
    docs, ideas = _ideas(db_session, ws)  # post i has ideas p{i}.0 and p{i}.1; posts cycle Pricing, Growth, Craft

    def predict(sig, *, db, workspace_id, job=None, lm=None, **inputs):
        assert sig.__name__ == "GroupThemes" and "p0.0 | Pricing idea 0.0:" in inputs["ideas"][0]
        return {"themes": [
            {"name": "Pricing", "summary": "s", "matches_request": False,
             "idea_ids": ["p0.0", "p0.1", "p3.0", "p3.1", "p6.0", "p6.1", "nope"]},
            {"name": "Audience Growth", "summary": "s", "matches_request": True,
             "idea_ids": ["p1.0", "p1.1", "p4.0", "p4.1", "p0.0"]},
            {"name": "", "summary": "no name", "idea_ids": ["p2.0"], "matches_request": False}],
            "relations": [{"a": "pricing", "b": "Audience Growth", "relation": "Price decides who stays."},
                          {"a": "Pricing", "b": "Ghost", "relation": "unknown theme"}]}

    monkeypatch.setattr(run, "predict", predict)
    themes, relations = report_themes.group_themes(db_session, None, ws.id, "Money", "a report", ideas)
    by_name = {t.name: t for t in themes}
    assert set(by_name) == {"Pricing", "Audience Growth", report_themes.CATCH_ALL}
    assert len(by_name["Pricing"].ideas) == 6  # the invented id was dropped
    assert "p0.0" not in [i.id for i in by_name["Audience Growth"].ideas]  # an idea belongs to one theme only
    growth = {i.id for i in by_name["Audience Growth"].ideas}
    assert {"p7.0", "p7.1"} <= growth  # filed by the words it shares with the theme
    assert {i.doc.path for i in by_name[report_themes.CATCH_ALL].ideas} == {docs[2].path, docs[5].path}  # nothing fits them
    assert sum(len(t.ideas) for t in themes) == len(ideas)  # every idea counts, so the weights cover all posts
    assert by_name["Audience Growth"].pinned and [t.id for t in themes] == ["t1", "t2", "t3"]
    assert relations == [{"a": "t1", "b": "t2", "relation": "Price decides who stays."}]


def test_too_few_themes_means_the_posts_are_read_as_before(owner, db_session, monkeypatch):
    _, ws = owner
    _, ideas = _ideas(db_session, ws)
    monkeypatch.setattr(run, "predict", lambda *a, **k: {"themes": [{"name": "Only", "summary": "", "idea_ids": ["p0.0"]}],
                                                         "relations": []})
    with pytest.raises(ThemesUnavailable):
        report_themes.group_themes(db_session, None, ws.id, "Money", "r", ideas)


def test_the_model_sees_at_most_300_ideas_one_round_of_every_post_at_a_time(owner, db_session):
    _, ws = owner
    docs = make_posts(db_session, ws, 120, ideas_each=8)
    corpus = Corpus(ws.id)
    corpus.sync()
    ideas = report_themes.collect_ideas(docs, corpus)
    listed = report_themes.listed_ideas(ideas)
    assert len(ideas) == 960 and len(listed) == report_themes.MAX_LISTED_IDEAS
    assert len({i.doc.id for i in listed}) == 120  # every post is in the sample


def test_a_post_without_ideas_is_represented_by_its_opening(owner, db_session):
    _, ws = owner
    docs = make_posts(db_session, ws, 2, with_ideas=0)
    corpus = Corpus(ws.id)
    corpus.sync()
    ideas = report_themes.collect_ideas(docs, corpus)
    assert [i.bare for i in ideas] == [True, True] and ideas[0].label == docs[0].title
    assert ideas[0].sources[0]["path"] == docs[0].path and ideas[0].sources[0]["line_start"] >= 1


def test_ideas_are_extracted_together_for_at_most_the_inline_limit(owner, db_session, monkeypatch):
    _, ws = owner
    docs = make_posts(db_session, ws, 6, with_ideas=0)
    seen = {}

    def predict_many(sig, inputs_list, *, db, workspace_id, lm=None, workers=5):
        seen["n"] = len(inputs_list)
        return [{"ideas": [{"label": "Idea", "note": "n", "details": [],
                            "sources": [{"path": docs[0].path, "line_start": 7, "line_end": 9}]}]} for _ in inputs_list]

    monkeypatch.setattr(run, "predict_many", predict_many)
    monkeypatch.setattr(run, "predict", lambda *a, **k: pytest.fail("together, not one by one"))
    monkeypatch.setattr(settings, "report_inline_ideas", 4)
    report_themes.ensure_ideas(db_session, None, ws.id, docs)
    assert seen["n"] == 4 and sum(ideas_fresh(d) for d in docs) == 4
    assert report_themes.fresh_share(docs) == pytest.approx(4 / 6)


# The blueprint is checked against the weights


def _bp(*sections: Section, connections=None) -> Blueprint:
    return Blueprint(title="T", storyline="S", sections=list(sections), connections=connections or [])


def _sec(heading, role="body", ids=(), depth="standard", must=()):
    return Section(heading=heading, role=role, brief=f"{heading} brief", theme_ids=list(ids), depth=depth, must_cover=list(must))


def test_the_plan_is_made_to_cover_every_major_and_asked_for_theme_in_its_own_section():
    themes = [theme("t1", "Pricing", 5, tier="major", weight=0.5), theme("t2", "Hiring", 3, tier="major", weight=0.3),
              theme("t3", "Tools", 1, weight=0.1), theme("t4", "Remote", 1, asked=True, tier="medium", weight=0.1)]
    plan = _bp(_sec("Summary", "summary"), _sec("Pricing power", ids=["t1", "t1", "ghost"], depth="brief", must=["a"]),
               _sec("Also pricing", ids=["t1"]), _sec("Opening", "intro"),
               connections=[{"theme_ids": ["t1", "t2"], "relation": "linked", "section": "pricing POWER"},
                            {"theme_ids": ["t1", "zzz"], "relation": "unknown theme", "section": "x"}])
    fixed = report_blueprint.repair(plan, themes)
    heads = [s.heading for s in fixed.sections]
    assert heads == ["Opening", "Pricing power", "Hiring", "Remote", "More to know", "Summary"]  # intro first, summary last
    by = {s.heading: s for s in fixed.sections}
    assert by["Pricing power"].theme_ids == ["t1"] and by["Pricing power"].depth == "deep"  # depth follows the weight
    assert by["Remote"].depth == "deep" and by["More to know"].theme_ids == ["t3"] and by["More to know"].depth == "brief"
    assert by["Summary"].theme_ids == ["t1", "t2", "t4"] and by["Summary"].depth == "brief"
    assert "Hiring: About Hiring." in by["Pricing power"].covered_elsewhere
    assert not any(c.startswith("Pricing power") for c in by["Pricing power"].covered_elsewhere)
    assert by["Opening"].covered_elsewhere == [] and by["Summary"].covered_elsewhere == []
    assert fixed.connections == [{"theme_ids": ["t1", "t2"], "relation": "linked", "section": "Pricing power"}]


def test_too_many_sections_merge_the_lightest_but_never_a_major_theme():
    themes = [theme("t1", "Big", 5, tier="major", weight=0.4)] + \
        [theme(f"t{n}", f"Small {n}", 1, weight=0.05 + n / 1000) for n in range(2, 12)]
    plan = _bp(_sec("Open", "intro"), _sec("Big one", ids=["t1"]), *[_sec(f"S{n}", ids=[f"t{n}"]) for n in range(2, 12)],
               _sec("End", "summary"))
    fixed = report_blueprint.repair(plan, themes)
    assert len(fixed.sections) == report_blueprint.MAX_SECTIONS
    assert [s for s in fixed.sections if s.heading == "Big one"][0].theme_ids == ["t1"]
    assert sorted(i for s in fixed.sections if s.role == "body" for i in s.theme_ids) == sorted(t.id for t in themes)  # none lost


def test_a_plan_with_one_section_is_not_usable():
    with pytest.raises(report_blueprint.BlueprintUnavailable):
        report_blueprint.repair(_bp(_sec("Only", ids=["t1"])), [theme("t1", "A", 1, tier="major", weight=1.0), ])


# The evidence of a section


def _themes_from(docs, ideas, groups):
    """Themes from an index range of posts each, weighed."""
    themes = [Theme(id=f"t{n}", name=name, summary=f"About {name}.", ideas=[i for i in ideas if lo <= docs.index(i.doc) < hi])
              for n, (name, lo, hi) in enumerate(groups, start=1)]
    report_themes.weigh(themes, len(docs), len(ideas))
    return themes


def test_a_deep_section_reads_several_posts_as_written_and_summarises_the_rest(owner, db_session):
    _, ws = owner
    docs, ideas = _ideas(db_session, ws, 10)
    corpus = Corpus(ws.id)
    t = _themes_from(docs, ideas, [("Everything", 0, 10), ("Other", 0, 0)][:1])
    sec = _sec("Deep", ids=["t1"], depth="deep")
    ev = report_evidence.build(corpus, sec, {x.id: x for x in t})
    raw = [b for b in ev.blocks if b.startswith("POST ")]
    assert 2 <= len(raw) == ev.raw_posts == 5  # a deep section reads five posts as written, never one
    assert any(b.startswith("SUMMARIES of other posts") for b in ev.blocks)
    assert len(ev.posts) == 10  # the other five are represented by their summaries
    assert "Sentence 1 about" in raw[0] and "[themes: Everything]" in raw[0]  # the post's own words
    assert "7| " not in raw[0] and "sources/x" not in raw[0]  # nothing is cited, so no line numbers and no paths
    assert sum(len(b) for b in ev.blocks) <= report_evidence.BUDGETS["deep"]


def test_a_brief_section_gets_summaries_only_and_a_standard_one_three_posts(owner, db_session):
    _, ws = owner
    docs, ideas = _ideas(db_session, ws, 10)
    corpus = Corpus(ws.id)
    t = _themes_from(docs, ideas, [("Everything", 0, 10)])
    by_id = {x.id: x for x in t}
    brief = report_evidence.build(corpus, _sec("Brief", ids=["t1"], depth="brief"), by_id)
    assert brief.raw_posts == 0 and not any(b.startswith("POST ") for b in brief.blocks)
    assert sum(len(b) for b in brief.blocks) <= report_evidence.BUDGETS["brief"]
    assert all(' (from "Post ' in line for line in brief.blocks[0].splitlines()[1:])  # each summary says which post it is from
    standard = report_evidence.build(corpus, _sec("Std", ids=["t1"], depth="standard"), by_id)
    assert standard.raw_posts == 3


def test_a_section_about_two_themes_starts_with_the_posts_that_speak_of_both(owner, db_session):
    _, ws = owner
    docs, ideas = _ideas(db_session, ws, 8)
    corpus = Corpus(ws.id)
    a, b = Theme("t1", "A", "", []), Theme("t2", "B", "", [])
    for d in docs:
        mine = [i for i in ideas if i.doc is d]
        a.ideas.append(mine[0])
        if d in docs[5:7]:  # only these two posts have an idea in each theme
            b.ideas.append(mine[1])
    report_themes.weigh([a, b], 8, len(ideas))
    ev = report_evidence.build(corpus, _sec("Bridge", "synthesis", ids=["t1", "t2"], depth="standard"), {"t1": a, "t2": b})
    first = [b_ for b_ in ev.blocks if b_.startswith("POST ")][:2]
    assert {docs[5].title, docs[6].title} == {blk.split(" [themes")[0][5:] for blk in first}


def test_an_unreadable_post_falls_back_to_its_summary(owner, db_session):
    _, ws = owner
    docs, ideas = _ideas(db_session, ws, 6)
    ideas[0].doc.path = "sources/x/missing.md"
    corpus = Corpus(ws.id)
    t = _themes_from(docs, ideas, [("All", 0, 6)])
    ev = report_evidence.build(corpus, _sec("S", ids=["t1"], depth="deep"), {"t1": t[0]})
    assert "sources/x/missing.md" in ev.posts and ev.raw_posts == 5  # the five others


# The whole report


@pytest.fixture()
def free_to_make(monkeypatch):
    monkeypatch.setattr("app.routers.artifacts.check_limit", lambda *a, **k: None)


class Fake:
    """The model, by signature name. `calls` is every call in order; `sections` the inputs of every WriteThemedSection."""

    def __init__(self, monkeypatch, docs, groups, ask=None, fail=(), quiz_themes=()):
        self.docs, self.calls, self.sections, self.fail = docs, [], [], set(fail)
        self.quiz_themes = list(quiz_themes)
        self.groups, self.ask, self.plan_inputs, self.report_inputs = groups, ask, None, None
        monkeypatch.setattr(run, "predict", self.predict)
        monkeypatch.setattr(run, "predict_many", self.predict_many)

    def predict(self, sig, *, db, workspace_id, job=None, lm=None, **inputs):
        name = sig.__name__
        self.calls.append(name)
        if name == "GroupThemes":
            ids = [line.split(" | ")[0] for line in inputs["ideas"]]
            out = []
            for title, lo, hi in self.groups:
                mine = [i for i in ids if lo <= int(i[1:].split(".")[0]) < hi]
                out.append({"name": title, "summary": f"About {title}.", "idea_ids": mine, "matches_request": title == self.ask})
            rel = [{"a": self.groups[0][0], "b": self.groups[1][0], "relation": "One shapes the other."}] if len(self.groups) > 1 else []
            return {"themes": out, "relations": rel}
        if name == "PlanReportBlueprint":
            self.plan_inputs = inputs
            return {"report_title": "Pricing and growth", "storyline": "Prices set expectations and growth follows.", "sections": [
                {"heading": "Why this matters", "role": "intro", "brief": "Opens.", "theme_ids": [], "depth": "brief",
                 "must_cover": ["scope"]},
                {"heading": "Pricing power", "role": "body", "brief": "Pricing.", "theme_ids": ["t1"], "depth": "deep",
                 "must_cover": ["raise slowly"],
                 "embed": {"kind": "flashcards", "title": "Terms", "brief": "Price terms", "why": "Learn them"}},
                {"heading": "Audience growth", "role": "body", "brief": "Growth.", "theme_ids": ["t2"], "depth": "standard",
                 "must_cover": ["retention"]},
                {"heading": "Quick quiz", "role": "body", "brief": "Test it.", "theme_ids": self.quiz_themes, "depth": "brief",
                 "must_cover": []},
                {"heading": "Wrap up", "role": "summary", "brief": "Closes.", "theme_ids": [], "depth": "brief",
                 "must_cover": ["main points"]}],
                "connections": [{"theme_ids": ["t1", "t2"], "relation": "Price shapes who stays.",
                                 "section": "Audience growth"}]}
        if name == "WriteThemedReport":
            self.report_inputs = inputs
            text = "## Why this matters\nIntro [1].\n\n## Pricing power\nBody [2].\n\n## Wrap up\nEnd."
            return {"report_title": "One Piece", "markdown": text}
        if name == "WriteReport":
            return {"report_title": "Legacy", "markdown": "## One\nText."}
        raise AssertionError(f"unexpected {name}")

    def predict_many(self, sig, inputs_list, *, db, workspace_id, lm=None, workers=5):
        assert sig.__name__ == "WriteThemedSection"
        out = []
        for inp in inputs_list:
            self.sections.append(inp)
            self.calls.append("WriteThemedSection")
            if inp["heading"] in self.fail:
                out.append(None)
            else:
                out.append({"markdown": f"{inp['heading']} text [1]."})  # a marker the model wrote anyway
        return out


def _report(client, owner, docs, fmt, **extra):
    headers, _ = owner
    nb = _notebook(client, owner, docs)
    return client.post("/api/artifacts/generate", json={
        "type": "report", "notebook_id": nb["id"], "document_ids": [str(d.id) for d in docs], "report_format": fmt,
        "instructions": "Write a report.", **extra}, headers=headers).json()


def _content(client, owner, art):
    return client.get(f"/api/artifacts/{art['id']}", headers=owner[0]).json()["content"]


GROUPS = [("Pricing", 0, 6), ("Audience Growth", 6, 8), ("Writing Craft", 8, 10)]  # 60%, 20%, 20% of the posts


def test_an_interactive_report_is_planned_then_written_section_by_section_from_its_own_evidence(client, owner, db_session, run_jobs,
                                                                                               monkeypatch, free_to_make):
    docs = make_posts(db_session, owner[1], 10, ideas_each=2)
    fake = Fake(monkeypatch, docs, GROUPS, quiz_themes=["t3"])  # the plan wrongly makes a section of a quiz
    art = _report(client, owner, docs, "interactive")
    run_jobs()
    c = _content(client, owner, art)
    assert c["format"] == "interactive" and c["plan"]["planner"] == "themes"
    assert [b["text"].split("\n")[0] for b in c["blocks"]] == [
        "## Why this matters", "## Pricing power", "## Audience growth", "## Wrap up"]
    assert "PlanInteractiveReport" not in fake.calls and "WriteReportSection" not in fake.calls and "WriteReport" not in fake.calls
    assert fake.calls[:2] == ["GroupThemes", "PlanReportBlueprint"]
    # The weights are counted: Pricing is in six of ten posts
    themes = {t["name"]: t for t in c["plan"]["themes"]}
    assert themes["Pricing"]["tier"] == "major" and themes["Pricing"]["weight"] == 0.6 and themes["Audience Growth"]["tier"] == "medium"
    assert c["plan"]["posts_total"] == 10 and c["source"]["total"] == 10 and len(c["source"]["document_ids"]) == 10
    # Nothing is cited. The Sources list is every post the report was made from, shown in a drop-down with the prompt
    assert c["citations"] == [] and not any("[" in b["text"] for b in c["blocks"])
    assert c["source"]["read"] == c["plan"]["posts_used"] == len(c["sources"]) == 10
    assert {x["document_id"] for x in c["sources"]} == {str(d.id) for d in docs} and all("markers" not in x for x in c["sources"])
    assert c["instructions"] == "Write a report."
    # The planner saw the allowed visuals and the themes, never the posts
    assert fake.plan_inputs["allowed_kinds"] and all("POST" not in line for line in fake.plan_inputs["themes"])
    # Body sections first, then the introduction and the summary, written from what the sections say
    written = [s["heading"] for s in fake.sections]
    assert written[:2] == ["Pricing power", "Audience growth"] and written[2:] == ["Why this matters", "Wrap up"]
    pricing = fake.sections[0]
    assert pricing["storyline"].startswith("Prices set") and len(pricing["outline"]) == 4
    assert pricing["covered_elsewhere"][0].startswith("Audience growth:")
    assert all(not x.startswith("Pricing power") for x in pricing["covered_elsewhere"])
    assert sum(e.startswith("POST ") for e in pricing["evidence"]) >= 2  # several posts as written
    growth = fake.sections[1]
    assert growth["bridges"] == ["Pricing + Audience Growth: Price shapes who stays. (bridged in: Audience growth)"]
    assert fake.sections[2]["evidence"][0].startswith("Pricing power: Pricing power text") and fake.sections[2]["role"] == "intro"
    assert "Restate the main points about: Pricing" in fake.sections[3]["must_cover"][-1]
    assert growth["evidence"] and "Writing Craft" in growth["evidence"][-1]  # the quiz section's theme stayed in the report
    # Visuals are only suggested; the quiz section became a suggestion
    # The plan suggested no infographic, so one is offered after the last section before the summary
    assert [(s["after_block_id"], s["kind"]) for s in c["suggestions"]] == [
        ("b2", "flashcards"), ("b3", "quiz"), ("b3", "infographic")]
    assert "failed_sections" not in c


def test_a_document_report_is_written_in_one_piece_from_the_plan_and_offers_no_visuals(client, owner, db_session, run_jobs,
                                                                                      monkeypatch, free_to_make):
    docs = make_posts(db_session, owner[1], 10, ideas_each=2)
    fake = Fake(monkeypatch, docs, GROUPS)
    art = _report(client, owner, docs, "document")
    run_jobs()
    c = _content(client, owner, art)
    assert c["format"] == "document" and c["plan"]["planner"] == "themes"
    assert c["suggestions"] == []  # never in a document
    assert fake.calls == ["GroupThemes", "PlanReportBlueprint", "WriteThemedReport"]
    assert fake.plan_inputs["allowed_kinds"] == []
    sections = fake.report_inputs["sections"]
    assert sections[0].startswith("SECTION 1: Why this matters") and all(s.startswith("SECTION") for s in sections)
    assert "Evidence:\nPOST " in sections[1] and fake.report_inputs["storyline"].startswith("Prices set")
    assert [b["text"].split("\n")[0] for b in c["blocks"]] == ["## Why this matters", "## Pricing power", "## Wrap up"]
    assert c["citations"] == [] and not any("[" in b["text"] for b in c["blocks"]) and len(c["sources"]) == 10
    assert sum(len(s) for s in sections) < report_evidence.BUDGETS["deep"] * 4  # the evidence fits its budget


def test_more_than_twenty_posts_are_all_used(client, owner, db_session, run_jobs, monkeypatch, free_to_make):
    docs = make_posts(db_session, owner[1], 30, ideas_each=2)
    fake = Fake(monkeypatch, docs, [("Pricing", 0, 20), ("Audience Growth", 20, 25), ("Writing Craft", 25, 30)])
    art = _report(client, owner, docs, "interactive")
    run_jobs()
    c = _content(client, owner, art)
    assert c["plan"]["posts_total"] == 30 and len(c["source"]["document_ids"]) == 30
    assert {t["name"]: t["posts"] for t in c["plan"]["themes"]} == {"Pricing": 20, "Audience Growth": 5, "Writing Craft": 5}
    assert fake.calls[0] == "GroupThemes"


def test_a_theme_the_reader_asked_for_gets_its_own_deep_section(client, owner, db_session, run_jobs, monkeypatch, free_to_make):
    docs = make_posts(db_session, owner[1], 10, ideas_each=2)
    Fake(monkeypatch, docs, GROUPS, ask="Writing Craft")
    art = _report(client, owner, docs, "interactive", instructions="Focus on writing craft.")
    run_jobs()
    c = _content(client, owner, art)
    sections = {s["heading"]: s for s in c["plan"]["sections"]}
    assert sections["Writing Craft"]["depth"] == "deep" and sections["Writing Craft"]["theme_ids"] == ["t3"]
    assert {t["name"]: t["pinned"] for t in c["plan"]["themes"]}["Writing Craft"] is True


def test_a_section_that_fails_is_tried_again_then_reported_not_hidden(client, owner, db_session, run_jobs, monkeypatch, free_to_make):
    docs = make_posts(db_session, owner[1], 10, ideas_each=2)
    seen: list[str] = []

    class Flaky(Fake):
        def predict_many(self, sig, inputs_list, **kw):
            seen.extend(i["heading"] for i in inputs_list)
            return super().predict_many(sig, inputs_list, **kw)

    Flaky(monkeypatch, docs, GROUPS, fail=["Audience growth"])
    art = _report(client, owner, docs, "interactive")
    run_jobs()
    c = _content(client, owner, art)
    assert seen.count("Audience growth") == 2  # once, then once more
    assert c["failed_sections"] == ["Audience growth"]
    assert [b["text"].split("\n")[0] for b in c["blocks"]] == ["## Why this matters", "## Pricing power", "## More to know", "## Wrap up"]


def test_when_the_ideas_cannot_be_themed_the_posts_are_read_as_before(client, owner, db_session, run_jobs, monkeypatch, free_to_make):
    docs = make_posts(db_session, owner[1], 10, ideas_each=2)
    fake = Fake(monkeypatch, docs, [("Only", 0, 10)])  # a single theme is no plan
    art = _report(client, owner, docs, "document")
    run_jobs()
    c = _content(client, owner, art)
    assert fake.calls == ["GroupThemes", "WriteReport"] and "plan" not in c and c["title"] == "Legacy"


def test_small_selections_chats_and_the_legacy_setting_keep_the_old_way(client, owner, db_session, run_jobs, monkeypatch, free_to_make):
    docs = make_posts(db_session, owner[1], 10, ideas_each=2)
    fake = Fake(monkeypatch, docs, GROUPS)
    small = _report(client, owner, docs[:5], "document")  # five posts or fewer: read whole
    run_jobs()
    assert fake.calls == ["WriteReport"] and "plan" not in _content(client, owner, small)
    fake.calls.clear()
    monkeypatch.setattr(settings, "report_planner", "legacy")
    _report(client, owner, docs, "document")
    run_jobs()
    assert fake.calls == ["WriteReport"]


def test_posts_without_ideas_use_the_old_way_until_half_have_them(client, owner, db_session, run_jobs, monkeypatch, free_to_make):
    docs = make_posts(db_session, owner[1], 10, with_ideas=3, ideas_each=2)
    monkeypatch.setattr(settings, "report_inline_ideas", 0)  # nothing is extracted while the report is made
    fake = Fake(monkeypatch, docs, GROUPS)
    _report(client, owner, docs, "document")
    run_jobs()
    assert fake.calls == ["WriteReport"]
    assert [d for d in db_session.scalars(select(Document)) if ideas_fresh(d)].__len__() == 3


def test_every_step_of_a_themed_report_is_logged(client, owner, db_session, run_jobs, monkeypatch, free_to_make, caplog):
    caplog.set_level(logging.INFO, logger="app")
    docs = make_posts(db_session, owner[1], 10, ideas_each=2)
    Fake(monkeypatch, docs, GROUPS)
    _report(client, owner, docs, "interactive")
    run_jobs()
    text = "\n".join(r.getMessage() for r in caplog.records)
    for expected in ("report posts: ", "themed report starting: ", "report ideas collected: ", "report themes: asking the model",
                     "report theme: id=t1 name='Pricing' weight=0.600 tier=major", "report blueprint checked: ",
                     "report section 1: heading='Why this matters'", "report evidence: section='Pricing power' depth=deep",
                     "report wave 1: ", "report wave 2: ", "report interactive written: ", "themed report done: ",
                     "report: job="):
        assert expected in text, expected
    assert "way=themes" in text


def test_a_fallback_says_why(client, owner, db_session, run_jobs, monkeypatch, free_to_make, caplog):
    caplog.set_level(logging.INFO, logger="app")
    docs = make_posts(db_session, owner[1], 10, ideas_each=2)
    Fake(monkeypatch, docs, [("Only", 0, 10)])
    _report(client, owner, docs, "document")
    run_jobs()
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "report themes unusable: usable=1 needed=2" in text and "reading the posts instead" in text and "way=legacy" in text
    caplog.clear()
    _report(client, owner, docs[:5], "document")
    run_jobs()
    assert "report route: legacy" in "\n".join(r.getMessage() for r in caplog.records)


def test_a_report_always_offers_visuals_and_never_repeats_what_the_plan_suggested():
    from app.pipeline import report

    blocks = [{"id": f"b{n}", "type": "prose"} for n in range(1, 6)]
    kinds = list(report.EMBED_KINDS)
    nothing = report.fill_suggestions([], blocks, kinds)
    assert [(s["kind"], s["after_block_id"]) for s in nothing] == [("infographic", "b4"), ("flashcards", "b2"), ("quiz", "b3")]
    planned = [{"id": "s1", "after_block_id": "b1", "kind": "infographic", "brief": "x", "why": "y"}]
    kept = report.fill_suggestions(planned, blocks, kinds)
    assert kept[0] == planned[0] and [s["kind"] for s in kept] == ["infographic", "flashcards", "quiz"]  # not offered twice
    assert [s["kind"] for s in report.fill_suggestions([], blocks, ["infographic", "mind_map"])] == ["infographic", "mind_map"]
    assert report.fill_suggestions([], blocks, []) == [] and report.fill_suggestions([], [], kinds) == []
    chat = report.fill_suggestions([], blocks, [k for k in kinds if k != "mind_map"])
    assert "mind_map" not in {s["kind"] for s in chat}


def test_an_older_report_without_suggestions_gets_them_once_when_opened(client, owner, db_session, run_jobs, monkeypatch, free_to_make):
    from app.models import Artifact

    docs = make_posts(db_session, owner[1], 10, ideas_each=2)
    Fake(monkeypatch, docs, GROUPS)
    art = _report(client, owner, docs, "interactive")
    run_jobs()
    row = db_session.get(Artifact, uuid.UUID(art["id"]))
    row.content_json = {k: v for k, v in row.content_json.items() if k not in ("suggestions", "suggestions_offered")}  # as an old one
    db_session.commit()
    first = _content(client, owner, art)
    assert {"infographic", "flashcards", "quiz"} <= {s["kind"] for s in first["suggestions"]} and first["suggestions_offered"]
    # Once: a reader who has added or taken everything away is not offered them again
    row = db_session.get(Artifact, uuid.UUID(art["id"]))
    db_session.refresh(row)
    row.content_json = {**row.content_json, "suggestions": []}
    db_session.commit()
    assert _content(client, owner, art)["suggestions"] == []


def test_a_document_report_is_never_given_suggestions_not_even_an_old_one_when_opened(client, owner, db_session, run_jobs, monkeypatch,
                                                                                     free_to_make):
    from app.models import Artifact

    docs = make_posts(db_session, owner[1], 10, ideas_each=2)
    Fake(monkeypatch, docs, GROUPS)
    art = _report(client, owner, docs, "document")
    run_jobs()
    row = db_session.get(Artifact, uuid.UUID(art["id"]))
    row.content_json = {k: v for k, v in row.content_json.items() if k not in ("suggestions", "suggestions_offered")}
    db_session.commit()
    assert _content(client, owner, art).get("suggestions", []) == []

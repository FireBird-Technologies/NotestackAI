# ruff: noqa: F811
"""Chat memory, the read side: ranked search, the chat tools, the context block, triage's memory decision, and the
research agent's wiring. No model and no network.

The scenario used throughout is the one the feature exists for: a chat about evals and benchmarks, a long detour about
Obama's birthday, and then a follow up that only makes sense against the evals topic."""

import json
import re
import uuid
from contextlib import contextmanager
from types import SimpleNamespace

import dspy
import pytest
from sqlalchemy import select

from app.chat_memory import files, organize, search
from app.chat_memory.context import ChatMemory, build_context, load_chat_memory, topic_question, topics_digest
from app.chat_memory.files import Quote, Topic
from app.chat_memory.tools import ChatTools, is_chat_path
from app.config import settings
from app.corpus import Corpus, CorpusError
from app.llm.signatures import FileCitation, ResearchArchive, ResearchArchiveWithMemory, ResearchExternal
from app.models import Artifact, Job, Message, User
from app.pipeline import compound_action
from app.pipeline import research as r
from app.services import jev
from tests.test_chat_memory import (  # noqa: F401  (world is a fixture)
    EVALS_A,
    EVALS_Q,
    OBAMA_A,
    OBAMA_Q,
    MemoryStore,
    evals_then_obama,
    fake_predict,
    world,
)


def remembered(world, monkeypatch):
    """A chat that has been filed: an evals topic and an Obama topic."""
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    world.ask(c, OBAMA_Q, OBAMA_A)
    fake_predict(monkeypatch, evals_then_obama)
    organize.organize_chat(world.db, None, c, world.corpus())
    monkeypatch.setattr(settings, "chat_memory_read", True)
    return c


def load(world, chat, history_ids=()):
    return load_chat_memory(world.db, world.ws.id, world.nb.id, chat.id, set(history_ids),
                            corpus=world.corpus(cache="reader"))


# Ranked search


def test_tokenizer_drops_filler_and_plurals():
    assert search.tokenize("What did the Benchmarks say about prices?") == ["benchmark", "price"]
    assert search.tokenize("class pass") == ["class", "pass"]  # "ss" endings are not plurals


def _topic_file(label, keywords, quotes, summary="A summary.", slug=None, last="2026-09-28"):
    return files.render_topic(Topic(
        label=label, slug=slug or files.topic_slug(label), chat_id="c1", first=last, last=last, rounds=1,
        keywords=keywords, gist=label, summary=summary,
        verbatim=[Quote(str(uuid.uuid4()), "assistant", last, q) for q in quotes]))


def test_a_related_word_finds_the_topic_through_its_keywords():
    pricing = _topic_file("Pricing", ["fee", "charge", "subscription"], ["You moved the tier from $5 to $8."])
    habits = _topic_file("Habits", ["routine", "morning"], ["You write every morning before email."])
    units = search.units_for("c1/pricing.md", pricing) + search.units_for("c1/habits.md", habits)
    hits = search.Bm25(units).search("what did I say about the fee")
    assert hits and hits[0][1].topic == "Pricing"  # the word "fee" never appears in the text, only in the keywords
    assert all(u.topic != "Habits" for _, u in hits)


def test_results_are_cut_by_score_not_by_count():
    docs = [_topic_file(f"T{i}", ["zzz"], [f"alpha beta {'gamma ' * i}"]) for i in range(1, 12)]
    units = [u for i, d in enumerate(docs) for u in search.units_for(f"c/{i}.md", d)]
    scored = search.Bm25(units).search("alpha")
    kept = search.cut(scored)
    assert 1 <= len(kept) <= search.MAX_RESULTS
    assert kept[0][0] >= kept[-1][0] >= kept[0][0] * search.CUTOFF
    assert search.cut([]) == []


def test_since_filters_by_the_topics_last_active_date():
    old = _topic_file("Old", ["pricing"], ["pricing talk"], last="2026-01-01")
    new = _topic_file("New", ["pricing"], ["pricing talk"], last="2026-09-01")
    units = search.units_for("c/old.md", old) + search.units_for("c/new.md", new)
    assert {u.topic for _, u in search.Bm25(units).search("pricing", since="2026-06-01")} == {"New"}


def test_units_point_at_the_real_lines():
    text = _topic_file("Evals", ["eval"], ["First saved line.", "Second saved line."])
    lines = text.splitlines()
    for u in search.units_for("c/evals.md", text):
        assert u.text.splitlines()[0] in lines[u.line - 1]


# The chat tools


def test_tools_list_search_grep_and_read_with_chat_paths(world, monkeypatch):
    c = remembered(world, monkeypatch)
    corpus = world.corpus(cache="reader")
    corpus.sync()
    seen = []
    tools = ChatTools(corpus, on_step=lambda k, d: seen.append((k, d)))
    listing = tools.list_chat_topics()
    assert f"chats/{c.id}/evals-and-benchmarks.md" in listing and "Obama birthday" in listing
    assert "Obama" not in tools.list_chat_topics(contains="benchmark")
    assert tools.list_chat_topics(since="2999-01-01") == "No matching topics."
    found = tools.search_chats("benchmarks for small models")
    assert found.splitlines()[0].startswith(f"chats/{c.id}/evals-and-benchmarks.md:")
    assert "obama" not in found.lower()
    assert "Best for small models" in tools.grep_chats(r"small\s+models")
    assert tools.search_chats(r"small\s+models", exact=True) == tools.grep_chats(r"small\s+models")  # the agent's route
    assert tools.grep_chats("nothing like this") == "No matches in earlier chats."
    path = f"chats/{c.id}/evals-and-benchmarks.md"
    assert tools.read_chat(path).startswith(f"{path} (")
    assert all(kind == "recall" for kind, _ in seen)


def test_tools_cannot_reach_other_files(world, monkeypatch):
    c = remembered(world, monkeypatch)
    corpus = world.corpus(cache="reader")
    corpus.sync()
    tools = ChatTools(corpus)
    for bad in (f"chats/{c.id}/TOPICS.md", "INDEX.md", "../manifest.json", f"chats/{c.id}/missing.md", "/etc/passwd"):
        with pytest.raises(CorpusError):
            tools.read_chat(bad)
        assert tools.quote(bad, 1, 2) is None
    assert is_chat_path("chats/x/y.md") and not is_chat_path("sources/site/post.md")
    assert not any("TOPICS" in p or p.endswith("INDEX.md") for p in tools.topic_files())


def test_other_notebooks_are_out_of_reach(world, monkeypatch):
    from app.models import Notebook

    remembered(world, monkeypatch)
    other = Notebook(workspace_id=world.ws.id, title="Other")
    world.db.add(other)
    world.db.commit()
    elsewhere = world.corpus(notebook=other, cache="elsewhere")
    elsewhere.sync()
    tools = ChatTools(elsewhere)
    assert tools.list_chat_topics() == "No earlier chat topics yet."
    assert tools.search_chats("benchmarks").startswith("No matches")


# The context block


def test_the_read_path_is_off_by_default(world, monkeypatch):
    c = remembered(world, monkeypatch)
    monkeypatch.setattr(settings, "chat_memory_read", False)
    assert load(world, c) is None


def test_a_follow_up_after_a_detour_gets_the_evals_topic_and_none_of_obama(world, monkeypatch):
    c = remembered(world, monkeypatch)
    mem = load(world, c)
    block, tools = build_context(mem, "evals-and-benchmarks", "lookup")
    assert tools is False
    assert "saturated" in block and "Best for small models" in block  # summary and the topic's latest messages
    assert "Obama" not in block and "August" not in block


def test_replay_gives_exact_words_with_lines_the_agent_can_cite(world, monkeypatch):
    c = remembered(world, monkeypatch)
    mem = load(world, c)
    block, tools = build_context(mem, "evals-and-benchmarks", "replay")
    assert tools is True and "Exact words kept" in block
    refs = re.findall(r"(chats/[\w-]+/[\w-]+\.md):(\d+)\]", block)
    assert refs, block
    chat_tools = ChatTools(mem.corpus)
    for path, line in refs:
        assert chat_tools.quote(path, int(line), int(line)), (path, line)  # every cited line is real
    exact = next(p for p, ln in refs if "Best for small models" in (chat_tools.quote(p, int(ln), int(ln)) or ""))
    assert exact == f"chats/{c.id}/evals-and-benchmarks.md"


def test_compose_gives_the_notebook_index_and_the_tools(world, monkeypatch):
    c = remembered(world, monkeypatch)
    block, tools = build_context(load(world, c), "", "compose")
    assert tools is True and "Obama birthday" in block and "Evals and benchmarks" in block


def test_none_adds_nothing_and_an_unknown_topic_falls_back_to_the_latest(world, monkeypatch):
    c = remembered(world, monkeypatch)
    mem = load(world, c)
    assert build_context(mem, "evals-and-benchmarks", "none") == ("", False)
    block, _ = build_context(mem, "no-such-topic", "lookup")
    assert block.startswith("Topic: ")


def test_the_block_is_capped(world, monkeypatch):
    c = remembered(world, monkeypatch)
    monkeypatch.setattr(settings, "chat_memory_context_chars", 200)
    block, _ = build_context(load(world, c), "evals-and-benchmarks", "replay")
    assert len(block) <= 230


def test_messages_the_job_has_not_filed_are_added_back_when_it_is_far_behind(world, monkeypatch):
    c = remembered(world, monkeypatch)
    late = [world.ask(c, f"later question {i}", f"later answer {i}") for i in range(5)]
    in_window = {str(m.id) for pair in late[-2:] for m in pair}
    mem = load(world, c, history_ids=in_window)
    assert mem.backlog and all("later" in s.text for s in mem.backlog)
    assert not any(s.text in ("later question 4", "later answer 4") for s in mem.backlog)  # already in the history
    assert "Messages not yet filed" in build_context(mem, "evals-and-benchmarks", "lookup")[0]


def test_a_broken_memory_means_no_memory_not_a_broken_chat(world, monkeypatch):
    c = remembered(world, monkeypatch)

    def boom(self):
        raise OSError("r2 is down")

    monkeypatch.setattr(Corpus, "sync", boom)
    assert load(world, c) is None


def test_a_notebook_with_no_memory_yet_loads_nothing(world, monkeypatch):
    monkeypatch.setattr(settings, "chat_memory_read", True)
    assert load(world, world.chat()) is None


# Triage's memory decision


def _tf(*slugs):
    return files.TopicsFile(chat_id="c", entries=[files.TopicEntry(s, s.title(), "2026-09-28", 1, "k", "g")
                                                  for s in slugs])


def _mem(*slugs):
    return ChatMemory(corpus=None, chat_id="c", tf=_tf(*slugs), topics={})


def _jev(monkeypatch, memory=("replay", 0.9), topic=("evals", 0.9), kind=("archive", 0.9)):
    monkeypatch.setattr(settings, "typesafe_api_key", "sk-test")
    seen = {}

    def decide(state, questions, timeout=6.0):
        seen.update(state=state, questions=questions)
        out = {"intent": jev.Choice(kind[0], kind[1], {}), "depth": jev.Choice("quick", 0.8, {})}
        if "memory" in questions:
            out["memory"] = jev.Choice(memory[0], memory[1], {})
        if "topic" in questions:
            out["topic"] = jev.Choice(topic[0], topic[1], {})
        return out

    monkeypatch.setattr(jev, "decide", decide)
    return seen


def test_jev_picks_the_topic_and_the_memory_level(monkeypatch):
    seen = _jev(monkeypatch)
    t = r.triage("what exactly did you say?", [], "nb", _mem("evals", "obama"))
    assert (t.kind, t.topic, t.memory) == ("archive", "evals", "replay")
    topics = seen["questions"]["topic"]["criteria"]
    assert set(topics) == {"evals", "obama", "none"} and "evals" in seen["state"]["topics"]
    assert set(seen["questions"]["memory"]["criteria"]) == {"none", "lookup", "replay", "compose"}


def test_without_chat_memory_triage_asks_exactly_what_it_always_did(monkeypatch):
    seen = _jev(monkeypatch)
    t = r.triage("hello?", [], "nb")
    # no memory and topic questions; detail always, reuse only once the chat has an answer to reshape
    assert set(seen["questions"]) == {"intent", "depth", "detail"} and (t.topic, t.memory) == ("", "none")


def test_an_unsure_memory_decision_looks_up_the_latest_topic(monkeypatch):
    _jev(monkeypatch, memory=("none", 0.3), topic=("evals", 0.2))
    t = r.triage("and that one?", [], "nb", _mem("evals"))
    assert t.memory == "lookup" and t.topic == ""  # an unsure topic means "use the latest"
    _jev(monkeypatch, memory=("none", 0.3))
    assert r.triage("and that one?", [], "nb", _mem()).memory == "none"  # nothing remembered to look up


def test_only_real_topics_are_accepted_and_other_kinds_need_no_memory(monkeypatch):
    _jev(monkeypatch, topic=("invented-slug", 0.95))
    assert r.triage("q", [], "nb", _mem("evals")).topic == ""
    _jev(monkeypatch, kind=("off_topic", 0.9))
    t = r.triage("write a script", [], "nb", _mem("evals"))
    assert t.kind == "off_topic" and t.memory == "none" and t.topic == ""


def test_the_llm_fallback_gets_the_topic_list(monkeypatch):
    monkeypatch.setattr(settings, "typesafe_api_key", "")
    seen = {}

    class FakePredict:
        def __init__(self, signature):
            seen["signature"] = signature.__name__

        def __call__(self, **kw):
            seen["inputs"] = kw
            return SimpleNamespace(kind="archive", standalone_question="sq", depth="quick", reply="",
                                   topic="evals", memory="lookup")

    monkeypatch.setattr(r.dspy, "Predict", FakePredict)
    monkeypatch.setattr(r, "triage_lm", lambda: dspy.LM("openai/x", api_key="k"))
    t = r.triage_llm("and that one?", [], "nb", _mem("evals"))
    assert seen["signature"] == "TriageWithMemory" and "evals" in seen["inputs"]["topics"]
    assert (t.topic, t.memory, t.question) == ("evals", "lookup", "sq")
    t = r.triage_llm("q", [], "nb")  # no memory: the old signature, the old behavior
    assert seen["signature"] == "TriageMessage" and (t.topic, t.memory) == ("", "none")


def test_topic_question_and_digest_are_bounded(monkeypatch):
    monkeypatch.setattr(settings, "chat_memory_topics_shown", 2)
    tf = _tf("a", "b", "c")
    assert len(topic_question(tf)["criteria"]) == 3  # two topics and "none"
    assert len(topics_digest(tf).splitlines()) == 2 and topic_question(_tf()) is None


# The research agent's wiring


class FakeReAct:
    """Stands in for dspy.ReAct: records how it was built and answers with a canned result."""

    built: list = []
    cite = None

    def __init__(self, signature, tools, max_iters):
        self.signature, self.tools = signature, [t.__name__ for t in tools]
        FakeReAct.built.append(self)

    def __call__(self, **inputs):
        self.inputs = inputs
        return SimpleNamespace(answer="Earlier I said X was best [1].", citations=[FakeReAct.cite] if FakeReAct.cite
                               else [], unsupported=False)


@pytest.fixture()
def agent(monkeypatch, tmp_path):
    FakeReAct.built, FakeReAct.cite = [], None
    monkeypatch.setattr(r.dspy, "ReAct", FakeReAct)
    monkeypatch.setattr(r, "main_lm", lambda *a: dspy.LM("openai/x", api_key="k"))

    @contextmanager
    def usage(lm):
        yield SimpleNamespace(prompt_tokens=0, completion_tokens=0)

    monkeypatch.setattr(r, "track_usage", usage)

    def run(question, mem, memory, topic, external_tools=None, kind="archive", external_aliases=None):
        monkeypatch.setattr(r, "triage", lambda *a: r.Triage(kind, question, "quick", "", topic=topic,
                                                             memory=memory))
        corpus = Corpus(uuid.uuid4(), store=MemoryStore(), cache_dir=str(tmp_path / "posts"))
        return r.research(corpus, {"sources/a.md": "On Pricing"}, question, history=[], chat_memory=mem,
                          external_tools=external_tools, external_aliases=external_aliases)

    return run


def test_replay_gives_the_agent_the_chat_tools_and_a_verifiable_chat_citation(world, monkeypatch, agent):
    c = remembered(world, monkeypatch)
    mem = load(world, c)
    block, _ = build_context(mem, "evals-and-benchmarks", "replay")
    path, line = re.search(r"(chats/[\w-]+/[\w-]+\.md):(\d+)\] \[?", block).groups()
    FakeReAct.cite = FileCitation(marker=1, path=path, line_start=int(line), line_end=int(line))
    out = agent("which did you say was best?", mem, "replay", "evals-and-benchmarks")
    built = FakeReAct.built[0]
    assert built.signature is ResearchArchiveWithMemory
    assert {"list_files", "search", "read", "list_chat_topics", "search_chats", "read_chat"} == set(built.tools)
    assert "Exact words kept" in built.inputs["chat_memory"]
    assert len(out.citations) == 1 and out.citations[0].path == path and not out.unsupported
    assert out.citations[0].quote and out.text == "Earlier I said X was best [1]."


def test_without_memory_the_agent_is_built_exactly_as_before(world, monkeypatch, agent):
    out = agent("what about pricing?", None, "none", "")
    built = FakeReAct.built[0]
    assert built.signature is ResearchArchive and built.tools == ["list_files", "search", "read"]
    assert "chat_memory" not in built.inputs and out.unsupported  # no citation, so no claim of support


def test_agent_receives_every_enabled_external_tool(world, monkeypatch, agent):
    external = []
    for index in range(10):
        def tool():
            return "external"

        tool.__name__ = f"external_{index}"
        external.append(tool)

    agent("use every external tool", None, "none", "", external)
    built = FakeReAct.built[0]
    assert built.tools == ["list_files", "search", "read", *[f"external_{i}" for i in range(10)]]


def test_external_action_gets_only_external_tools(world, monkeypatch, agent):
    def github_search(query: str):
        return query

    def github_get_file(owner: str, repo: str, path: str):
        return f"{owner}/{repo}/{path}"

    monkeypatch.setattr(r, "prefetch", lambda *a, **kw: (_ for _ in ()).throw(
        AssertionError("external-only questions must not search the archive")))
    agent("get my public GitHub repos", None, "none", "", [github_search, github_get_file], kind="external_action")
    built = FakeReAct.built[0]
    assert built.signature is ResearchExternal
    assert built.tools == ["github_search", "github_get_file"]
    assert not {"list_files", "search", "read"}.intersection(built.tools)


def test_flashcards_then_notion_starts_background_chain_without_waiting_for_agent(world, monkeypatch, tmp_path):
    created = {
        "id": str(uuid.uuid4()), "type": "flashcards", "status": "pending",
        "url": "http://localhost:5173/app/artifacts/cards-1",
    }
    monkeypatch.setattr(r, "triage", lambda *a: r.Triage(
        "external_action", "create flashcards from the posts and put them in Notion", "quick", "",
    ))
    monkeypatch.setattr(r, "start_from_chat", lambda *a, **kw: created)
    monkeypatch.setattr(r, "parse_create", lambda *a, **kw: (
        {"artifact": "flashcards", "settings": {}}, "", 0, 0,
    ))
    monkeypatch.setattr(r.dspy, "ReAct", lambda *a, **kw: (_ for _ in ()).throw(
        AssertionError("the request thread must not start the external agent")))

    def mcp_test_notion_create_pages(**_kwargs):
        return "https://notion.example/flashcards"

    def mcp_test_notion_update_page(**_kwargs):
        return "updated"

    corpus = Corpus(uuid.uuid4(), store=MemoryStore(), cache_dir=str(tmp_path / "compound-posts"))
    out = r.research(
        corpus,
        {"sources/a.md": "Post"},
        "create a set of flashcards from the connected posts and create a Notion page with them",
        external_tools=[mcp_test_notion_create_pages, mcp_test_notion_update_page],
        external_aliases={"notion"},
        external_destinations=[{
            "connection_id": None,
            "name": "Notion",
            "provider": "notion",
            "aliases": ["notion"],
            "tools": ["notion-create-pages", "notion-update-page"],
        }],
        workspace_id=world.ws.id,
        notebook_id=world.nb.id,
        notebook_title="Study",
    )

    assert out.created_artifacts == [created]
    assert out.background_action == {
        "kind": "artifact_to_external", "artifact_id": created["id"],
        "artifact_type": "flashcards",
        "artifact_url": created["url"],
        "adapter": "notion_page",
        "connection_id": None,
        "destination_name": "Notion",
        "destination_url": "https://notion.example/flashcards",
        "title": "NoteStack Flashcards",
        "question": "create a set of flashcards from the connected posts and create a Notion page with them",
    }
    assert "Notion destination is ready" in out.text and "update this message" in out.text
    assert "https://notion.example/flashcards" in out.text


def test_background_chain_updates_existing_page_without_changing_chat(world, monkeypatch):
    artifact = Artifact(
        workspace_id=world.ws.id,
        notebook_id=world.nb.id,
        type="flashcards",
        status="ready",
        content_json={"title": "Cards", "cards": [{"front": "Q1", "back": "A1"}]},
    )
    world.db.add(artifact)
    world.db.commit()
    user = world.db.scalar(select(User))
    job = Job(
        workspace_id=world.ws.id,
        kind="compound_action",
        status="running",
        attempts=1,
        max_attempts=1,
        params={
            "artifact_id": str(artifact.id),
            "notebook_id": str(world.nb.id),
            "user_id": str(user.id),
            "destination_url": "https://notion.example/page",
            "question": "Create a Notion page with the flashcards",
        },
    )
    world.db.add(job)
    world.db.commit()

    called = {}

    def mcp_test_notion_update_page(**kwargs):
        called.update(kwargs)
        return "updated"

    bundle = SimpleNamespace(tools=[mcp_test_notion_update_page], sources=[])
    monkeypatch.setattr(compound_action, "load_external_tools", lambda *a, **kw: bundle)
    result, _ = compound_action.complete(world.db, job)

    assert result["status"] == "done" and result["item_count"] == 1
    assert called["page_id"] == "https://notion.example/page"
    assert called["command"] == "replace_content"
    assert "**Front:** Q1" in called["new_str"] and "**Back:** A1" in called["new_str"]


def test_quiz_is_a_real_background_artifact_not_model_written(monkeypatch):
    assert r.compound_artifact_request(
        "craete a quiz fromt he posst in this notebook and craete a notion pageband add this there"
    ) == "quiz"


@pytest.mark.parametrize(("message", "artifact"), [
    ("create a report from my posts in this notebook", "report"),
    ("make an infographic from the connected sources", "infographic"),
    ("build a slide deck from these posts", "slide_deck"),
    ("generate a mind map from my notebook", "mind_map"),
    ("make flashcards from the posts", "flashcards"),
])
def test_compound_artifact_detection_is_not_quiz_specific(message, artifact):
    assert r.compound_artifact_request(message) == artifact


def test_destination_adapter_is_selected_from_capabilities_not_brand_name():
    destination = r.compound_destination("design studio", [{
        "connection_id": "11111111-1111-1111-1111-111111111111",
        "name": "Design Studio",
        "provider": "custom",
        "aliases": ["design studio"],
        "tools": ["create-design", "get-create-design-async-job"],
    }])
    assert destination["adapter"] == "async_design"
    assert destination["name"] == "Design Studio"


def test_quiz_in_canva_routes_by_artifact_and_destination_capabilities(world, monkeypatch, tmp_path):
    created = {
        "id": str(uuid.uuid4()), "type": "quiz", "status": "pending",
        "url": "http://localhost:5173/app/artifacts/quiz-1",
    }
    monkeypatch.setattr(r, "triage", lambda *a: r.Triage(
        "create", "create a quiz from the posts and put it in Canva", "quick", "",
    ))
    monkeypatch.setattr(r, "parse_create", lambda *a, **kw: (
        {"artifact": "quiz", "settings": {"level": "hard"}}, "", 2, 1,
    ))
    started = {}

    def start(*args, **kwargs):
        started.update({"args": args, "kwargs": kwargs})
        return created

    monkeypatch.setattr(r, "start_from_chat", start)
    monkeypatch.setattr(r.dspy, "ReAct", lambda *a, **kw: (_ for _ in ()).throw(
        AssertionError("the request thread must only enqueue the artifact and delivery")))

    def mcp_test_create_design(**_kwargs):
        raise AssertionError("Canva must be called by the background worker, not the chat request")

    def mcp_test_get_create_design_async_job(**_kwargs):
        raise AssertionError("Canva must be polled by the background worker")

    corpus = Corpus(uuid.uuid4(), store=MemoryStore(), cache_dir=str(tmp_path / "canva-routing"))
    question = (
        "generate a hard quiz from our existing posts and create a design with blue background, "
        "name it notestack test, and put the quiz there in Canva"
    )
    out = r.research(
        corpus,
        {"sources/a.md": "Post"},
        question,
        external_tools=[mcp_test_create_design, mcp_test_get_create_design_async_job],
        external_aliases={"canva"},
        external_destinations=[{
            "connection_id": "11111111-1111-1111-1111-111111111111",
            "name": "Canva",
            "provider": "canva",
            "aliases": ["canva"],
            "tools": ["create-design", "get-create-design-async-job"],
        }],
        workspace_id=world.ws.id,
        notebook_id=world.nb.id,
        notebook_title="Study",
    )

    assert started["args"][3] == "quiz"
    assert started["args"][4] == {"level": "hard"}
    assert out.created_artifacts == [created]
    assert out.background_action == {
        "kind": "artifact_to_external",
        "artifact_id": created["id"],
        "artifact_type": "quiz",
        "artifact_url": created["url"],
        "adapter": "async_design",
        "connection_id": "11111111-1111-1111-1111-111111111111",
        "destination_name": "Canva",
        "title": "notestack test",
        "question": question,
    }
    assert "update this message with the link" in out.text
    assert created["url"] in out.text


def test_destination_title_accepts_typographic_quotes():
    assert r._page_title('create a blue page named “Notestack Test" in Canva', "flashcards") == "Notestack Test"


def _canva_compound_job(world, *, artifact_status="ready"):
    artifact = Artifact(
        workspace_id=world.ws.id,
        notebook_id=world.nb.id,
        type="quiz",
        status=artifact_status,
        content_json={
            "title": "Archive quiz",
            "questions": [{
                "question": "Which idea appeared in the posts?",
                "options": ["Exact answer", "Distractor"],
                "correct": [0],
                "explanation": "The posts say this directly.",
            }],
        },
    )
    chat = world.chat()
    message = Message(
        chat_id=chat.id,
        role="assistant",
        content="Creating the quiz in the background.",
        recall_json={"background_status": {"state": "working", "message": "Creating quiz"}},
    )
    world.db.add_all([artifact, message])
    world.db.commit()
    user = world.db.scalar(select(User))
    job = Job(
        workspace_id=world.ws.id,
        kind="compound_action",
        status="running",
        attempts=1,
        max_attempts=1,
        params={
            "artifact_id": str(artifact.id),
            "artifact_type": "quiz",
            "artifact_url": f"http://localhost:5173/app/artifacts/{artifact.id}",
            "message_id": str(message.id),
            "notebook_id": str(world.nb.id),
            "user_id": str(user.id),
            "connection_id": "11111111-1111-1111-1111-111111111111",
            "adapter": "async_design",
            "destination_name": "Canva",
            "title": "notestack test",
            "question": "Create a blue design named notestack test and put the quiz in Canva",
        },
    )
    world.db.add(job)
    world.db.commit()
    return artifact, message, job


def test_canva_worker_polls_and_updates_chat_with_edit_link(world, monkeypatch):
    artifact, message, job = _canva_compound_job(world)
    calls = []
    widget = {
        "connection_id": "11111111-1111-1111-1111-111111111111",
        "connection": "Canva",
        "tool": "create-design",
        "arguments": {},
        "resource_uri": "ui://canva/create-design",
        "result": {
            "structuredContent": {
                "status": "completed",
                "design": {"edit_url": "https://www.canva.com/design/edit-1"},
            },
            "isError": False,
        },
    }

    connection = SimpleNamespace(
        id=uuid.UUID("11111111-1111-1111-1111-111111111111"),
        name="Canva",
        discovered_tools=[{
            "name": "create-design",
            "ui_resource_uri": "ui://canva/create-design",
        }],
    )
    monkeypatch.setattr(compound_action, "_connection", lambda *_args: connection)

    def call(_db, _job, _params, tool_name, arguments, *, capture_urls=False):
        calls.append((tool_name, arguments, capture_urls))
        if tool_name == "create-design":
            return json.dumps({
                "status": "pending",
                "job_id": "canva-job-1",
                "continuation_token": "continue-1",
                "polling_policy": {"wait_seconds": 0},
            }), []
        return json.dumps({
            "status": "completed",
            "design": {
                "url": "https://www.canva.com/design/view-1",
                "edit_url": "https://www.canva.com/design/edit-1",
            },
        }), []

    monkeypatch.setattr(compound_action, "_call", call)
    monkeypatch.setattr(compound_action.time, "sleep", lambda *_: None)
    result, _ = compound_action.complete(world.db, job)

    assert result["status"] == "done" and result["item_count"] == 1
    assert [call[0] for call in calls] == ["create-design", "get-create-design-async-job"]
    brief = calls[0][1]["brief"]
    assert "notestack test" in brief
    assert "blue design" in brief
    assert "Which idea appeared in the posts?" in brief
    assert "**Answer:** Exact answer" in brief
    assert calls[1][1]["job_id"] == "canva-job-1"
    assert calls[1][1]["continuation_token"] == "continue-1"
    world.db.refresh(message)
    assert "https://www.canva.com/design/edit-1" in message.content
    assert message.recall_json["background_status"]["state"] == "done"
    assert message.recall_json["background_status"]["url"] == "https://www.canva.com/design/edit-1"
    saved_widget = message.recall_json["external_widgets"][0]
    assert saved_widget["connection_id"] == widget["connection_id"]
    assert saved_widget["connection"] == widget["connection"]
    assert saved_widget["tool"] == widget["tool"]
    assert saved_widget["resource_uri"] == widget["resource_uri"]
    assert "Which idea appeared in the posts?" in saved_widget["arguments"]["brief"]
    assert saved_widget["result"]["structuredContent"]["status"] == "completed"
    assert saved_widget["result"]["structuredContent"]["design"]["edit_url"].endswith("edit-1")
    assert result["external_widgets"] == [saved_widget]
    world.db.refresh(job)
    assert job.params["delivery_state"]["job_id"] == "canva-job-1"


def test_canva_worker_updates_chat_when_delivery_fails(world, monkeypatch):
    _artifact, message, job = _canva_compound_job(world)
    monkeypatch.setattr(compound_action, "_call", lambda *a, **kw: (
        json.dumps({"status": "failed", "message": "Canva rejected the design"}), [],
    ))
    result, _ = compound_action.complete(world.db, job)

    assert result["status"] == "failed"
    world.db.refresh(message)
    assert "Canva rejected the design" in message.content
    assert "Open the NoteStack quiz" in message.content
    assert message.recall_json["background_status"]["state"] == "failed"


def test_follow_up_asking_for_created_link_reuses_conversation_without_tools(monkeypatch, tmp_path):
    monkeypatch.setattr(r, "triage", lambda *a: (_ for _ in ()).throw(
        AssertionError("a saved link does not need triage")))
    corpus = Corpus(uuid.uuid4(), store=MemoryStore(), cache_dir=str(tmp_path / "saved-link"))
    out = r.research(
        corpus,
        {"sources/a.md": "Post"},
        "give me the link to the Notion page you created",
        history=[r.Turn("assistant", "Created it: https://app.notion.com/p/page-id?pvs=204")],
        external_tools=[lambda: (_ for _ in ()).throw(AssertionError("no tool call expected"))],
    )

    assert out.text == "Here it is: [Open the created page](https://app.notion.com/p/page-id?pvs=204)"
    assert out.external_sources[0]["urls"] == ["https://app.notion.com/p/page-id?pvs=204"]


def test_destination_link_follow_up_while_delivery_runs_does_not_create_another_artifact(monkeypatch, tmp_path):
    monkeypatch.setattr(r, "triage", lambda *a: (_ for _ in ()).throw(
        AssertionError("a pending destination link does not need triage")))
    monkeypatch.setattr(r, "start_from_chat", lambda *a, **kw: (_ for _ in ()).throw(
        AssertionError("a link follow-up must not create another artifact")))
    question = "GIVE me the destination link in Canva for these flashcards"
    corpus = Corpus(uuid.uuid4(), store=MemoryStore(), cache_dir=str(tmp_path / "pending-link"))
    out = r.research(
        corpus,
        {"sources/a.md": "Post"},
        question,
        history=[r.Turn(
            "assistant",
            "Creating it. [Open the NoteStack flashcards](https://notestack.ai/app/artifacts/cards-1)",
            {"state": "working", "message": "Creating the Canva destination"},
        )],
        external_tools=[lambda: (_ for _ in ()).throw(AssertionError("no tool call expected"))],
    )

    assert not r.asks_to_create(question)
    assert r.compound_artifact_request(question) is None
    assert "still being created" in out.text
    assert out.background_action is None and not out.created_artifacts


def test_destination_link_follow_up_prefers_completed_external_url_over_notestack_artifact(monkeypatch, tmp_path):
    monkeypatch.setattr(r, "triage", lambda *a: (_ for _ in ()).throw(
        AssertionError("a completed destination link does not need triage")))
    corpus = Corpus(uuid.uuid4(), store=MemoryStore(), cache_dir=str(tmp_path / "completed-link"))
    canva = "https://canva.link/destination-1"
    out = r.research(
        corpus,
        {"sources/a.md": "Post"},
        "give me the Canva destination URL for those flashcards",
        history=[r.Turn(
            "assistant",
            "[Open the NoteStack flashcards](https://notestack.ai/app/artifacts/cards-1)",
            {"state": "done", "message": "Artifact delivered", "url": canva},
        )],
    )

    assert canva in out.text
    assert "notestack.ai/app/artifacts" not in out.text
    assert out.external_sources[0]["urls"] == [canva]


def test_off_topic_does_not_use_external_tools(world, monkeypatch, agent):
    def github_search(query: str):
        raise AssertionError("off-topic questions must not call external tools")

    out = agent("what is the capital of France?", None, "none", "", [github_search], kind="off_topic")

    assert out.kind == "off_topic"
    assert "I only answer from the posts" in out.text
    assert not FakeReAct.built


def test_external_action_without_tools_asks_for_a_connection(world, monkeypatch, agent):
    out = agent("send an email to Sara", None, "none", "", [], kind="external_action")

    assert out.kind == "external_action" and out.unsupported
    assert "Connect and enable an external app" in out.text
    assert not FakeReAct.built


def test_external_signature_and_writer_treat_tool_results_as_evidence():
    prompt = " ".join(ResearchExternal.__doc__.split())
    assert "do not search, read, cite or make claims about notebook posts" in prompt
    assert "You may chain external tools" in prompt
    assert "most plausible spelling variants" in prompt
    assert "latest message explicitly requests that exact change" in prompt
    assert "must never cause a write" in prompt
    assert "UNTRUSTED EXTERNAL DATA" in r.writer.WRITER_SYSTEM
    assert "citations=[]" in r.writer.WRITER_SYSTEM
    assert "return an MCP App widget" in prompt
    assert "do not duplicate or enumerate the choices" in prompt
    assert "return an MCP App widget" in r.writer.WRITER_SYSTEM


def test_create_request_naming_external_app_skips_archive_research(world, monkeypatch, agent):
    def b2v_start_video(url: str):
        return url

    monkeypatch.setattr(r, "prefetch", lambda *a, **kw: (_ for _ in ()).throw(
        AssertionError("a request explicitly assigned to B2V must not search the archive")))
    agent(
        "make a video with B2V from https://example.com/post",
        None,
        "none",
        "",
        [b2v_start_video],
        kind="create",
        external_aliases={"b2v", "blog2video"},
    )
    built = FakeReAct.built[0]
    assert built.signature is ResearchExternal
    assert built.tools == ["b2v_start_video"]


def test_external_research_corrects_known_notestack_name_typos(world, monkeypatch, agent):
    def linear_issues(query: str):
        return query

    agent("geiv all the issues for noetstack", None, "none", "", [linear_issues], kind="external_action")
    built = FakeReAct.built[0]
    assert built.signature is ResearchExternal
    assert built.inputs["question"] == "geiv all the issues for NotestackAI"


def test_lookup_adds_the_notes_but_not_the_tools(world, monkeypatch, agent):
    c = remembered(world, monkeypatch)
    agent("which of those?", load(world, c), "lookup", "evals-and-benchmarks")
    built = FakeReAct.built[0]
    assert built.signature is ResearchArchiveWithMemory and built.tools == ["list_files", "search", "read"]
    assert "saturated" in built.inputs["chat_memory"]


def test_a_made_up_chat_citation_is_dropped(world, monkeypatch, agent):
    c = remembered(world, monkeypatch)
    FakeReAct.cite = FileCitation(marker=1, path=f"chats/{c.id}/invented.md", line_start=1, line_end=2)
    out = agent("what did you say?", load(world, c), "replay", "evals-and-benchmarks")
    assert out.citations == [] and out.unsupported
    FakeReAct.cite = FileCitation(marker=1, path=f"chats/{c.id}/evals-and-benchmarks.md", line_start=1, line_end=2)
    out = agent("what did you say?", None, "none", "")  # no chat tools in this run: a chat citation cannot verify
    assert out.citations == []


def test_the_chat_endpoint_loads_memory_only_when_the_flag_is_on(client, db_session, monkeypatch):
    from app.routers import notebooks as nbr
    from tests.test_memory import _signup

    auth = _signup(client, "ada3@example.com")
    nb = client.post("/api/notebooks", json={"title": "N"}, headers=auth).json()
    seen = {}

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **kw):
        seen["kwargs"] = kw
        return r.ResearchResult("ok", True, [], kind="archive", question=question)

    monkeypatch.setattr(nbr, "research", fake_research)
    client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "hello there friend"}, headers=auth)
    assert "chat_memory" not in seen["kwargs"]  # the flag is off: no chat memory is passed


def test_a_chat_citation_is_saved_streamed_and_reloaded(client, db_session, monkeypatch):
    import json

    from app.models import Citation
    from app.routers import notebooks as nbr
    from tests.test_memory import _signup

    auth = _signup(client, "ada4@example.com")
    nb = client.post("/api/notebooks", json={"title": "N"}, headers=auth).json()
    path = f"chats/{uuid.uuid4()}/evals-and-benchmarks.md"
    cite = r.VerifiedCitation(1, path, 12, 13, "[assistant, 2026-09-28] Best for small models: 1. X 2. Y 3. Z")

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **kw):
        return r.ResearchResult("Earlier I said X [1].", False, [cite], kind="archive", question=question)

    monkeypatch.setattr(nbr, "research", fake_research)
    body = client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "what did you say was best?"},
                       headers=auth).text
    chat_id = json.loads(re.search(r"event: status\ndata: (.*)", body).group(1))["chat_id"]
    live = json.loads(re.search(r"event: answer\ndata: (.*)", body).group(1))["citations"]
    assert live == [{"marker": 1, "kind": "chat", "document_id": None, "title": "Earlier chat: Evals and benchmarks",
                     "url": "", "path": path, "line_start": 12, "line_end": 13, "span": cite.quote}]
    row = db_session.query(Citation).one()
    assert row.kind == "chat" and row.document_id is None and row.path == path
    reloaded = client.get(f"/api/notebooks/chats/{chat_id}/messages", headers=auth).json()
    assert reloaded[-1]["citations"] == live  # the same citation after reopening the chat


def test_a_change_of_topic_stays_in_the_same_chat_and_only_a_missing_id_starts_a_new_one(client, db_session,
                                                                                          monkeypatch):
    """The chat is split by the writer, never by the conversation: an off topic message sent with the chat id joins
    that chat. A new chat starts only when no id is sent (New chat) or the id is not in this notebook."""
    import json

    from app.models import Chat
    from app.routers import notebooks as nbr
    from tests.test_memory import _signup

    auth = _signup(client, "ada5@example.com")
    nb = client.post("/api/notebooks", json={"title": "N"}, headers=auth).json()
    kinds = iter(["archive", "off_topic", "archive"])

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **kw):
        return r.ResearchResult(f"answer to {question}", False, [], kind=next(kinds), question=question)

    monkeypatch.setattr(nbr, "research", fake_research)

    def ask(question, chat_id=None):
        body = client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": question, "chat_id": chat_id},
                           headers=auth).text
        return json.loads(re.search(r"event: status\ndata: (.*)", body).group(1))["chat_id"]

    first = ask("what is agent memory?")
    assert ask("who is the president of us", first) == first  # an off topic detour, same chat
    assert ask("explain the three layers more", first) == first  # and back again
    assert db_session.query(Chat).count() == 1
    assert ask("what is agent memory?") != first  # no id sent: the writer pressed New chat
    assert ask("hello again", str(uuid.uuid4())) not in (first,)  # an id that is not a chat here starts a new one
    assert db_session.query(Chat).count() == 3


def test_the_agent_is_told_a_bare_question_mark_is_a_follow_up():
    """Seen on a real chat: after "what is context engineering", sending "?" got "your message came through as just a
    '?'". Triage with Jev passes the message through unchanged, so the agent must resolve the follow up itself."""
    doc = " ".join(ResearchArchive.__doc__.split())
    assert 'such as "?", "why", "say more"' in doc and "Read the conversation first" in doc
    assert "never reply that the message is unclear or ask what the writer means" in doc
    assert "follow ups already resolved" not in ResearchArchive.input_fields["question"].json_schema_extra["desc"]
    assert "?" in ResearchArchiveWithMemory.__doc__  # the memory variant inherits the instruction


def test_the_context_the_agent_is_given_is_written_to_the_log(world, monkeypatch, agent, caplog):
    import logging

    c = remembered(world, monkeypatch)
    mem = load(world, c)
    monkeypatch.setattr(settings, "chat_context_log", True)
    with caplog.at_level(logging.INFO, logger="notestack.chat_context"):
        agent("which of those did you say was best?", mem, "replay", "evals-and-benchmarks")
    text = caplog.text
    assert "=== CHAT CONTEXT: what the research agent is given ===" in text
    assert "triage: kind=archive depth=quick topic=evals-and-benchmarks memory=replay" in text
    assert "agent signature: ResearchArchiveWithMemory" in text and "search_chats" in text and "read_chat" in text
    assert "topics of this chat" in text and "evals-and-benchmarks | Evals and benchmarks" in text
    assert "chat memory notes" in text and "Exact words kept" in text and "Best for small models" in text
    assert "Summary [chats/" in text and "writer notes" in text and "conversation (last turns" in text
    # the decision section names the R2 key the summary was read from
    assert "CHAT_MEMORY_READ: on" in text and "triage chose: topic=evals-and-benchmarks memory=replay" in text
    assert f"summary source: ws/{world.ws.id}/chats/{world.nb.id}/{c.id}/evals-and-benchmarks.md" in text
    assert "passed to the agent: summary + 1 exact quote(s)" in text


def test_the_context_log_follows_the_environment_unless_set(monkeypatch):
    monkeypatch.setattr(settings, "chat_context_log", None)
    monkeypatch.setattr(settings, "env", "development")
    assert r.context_log_enabled() is True
    monkeypatch.setattr(settings, "env", "production")
    assert r.context_log_enabled() is False  # the log holds writers' text, so production is off by default
    monkeypatch.setattr(settings, "chat_context_log", True)
    assert r.context_log_enabled() is True
    monkeypatch.setattr(settings, "env", "development")
    monkeypatch.setattr(settings, "chat_context_log", False)
    assert r.context_log_enabled() is False


def test_long_sections_are_cut_in_the_log_and_say_so():
    text = r._section("notes", "x" * (r.CONTEXT_LOG_SECTION_CHARS + 50))
    assert "[+50 more characters not shown]" in text and text.startswith("--- notes (4050 chars) ---")
    assert r._section("notes", "") .endswith("(empty)")


def test_nothing_is_logged_when_the_log_is_off(world, monkeypatch, agent, caplog):
    import logging

    monkeypatch.setattr(settings, "chat_context_log", False)
    with caplog.at_level(logging.INFO, logger="notestack.chat_context"):
        agent("what about pricing?", None, "none", "")
    assert "CHAT CONTEXT" not in caplog.text


def test_the_log_says_why_no_summary_was_passed(world, monkeypatch, agent, caplog):
    import logging

    monkeypatch.setattr(settings, "chat_context_log", True)
    c = remembered(world, monkeypatch)
    cases = [
        (False, load(world, c), "none", "CHAT_MEMORY_READ: OFF", "Summaries are still being written to R2"),
        (True, None, "none", "CHAT_MEMORY_READ: on", "nothing loaded"),
        (True, load(world, c), "none", "triage chose: topic=- memory=none", "no summary passed"),
    ]
    for read, mem, memory, *expected in cases:
        monkeypatch.setattr(settings, "chat_memory_read", read)
        caplog.clear()
        with caplog.at_level(logging.INFO, logger="notestack.chat_context"):
            agent("what about pricing?", mem, memory, "")
        for phrase in expected:
            assert phrase in caplog.text, (phrase, caplog.text)


def test_the_log_says_when_the_summary_switched_and_which_was_passed(world, monkeypatch, agent, caplog):
    import logging

    monkeypatch.setattr(settings, "chat_context_log", True)
    c = remembered(world, monkeypatch)  # evals, then Obama: the chat was last on Obama
    mem = load(world, c)
    assert mem.tf.current == "obama-birthday"
    cases = [
        ("evals-and-benchmarks", "lookup",
         "=== SUMMARY SWITCHED from 'Obama birthday' to 'Evals and benchmarks': the summary of 'Evals and benchmarks' "
         "was passed as context (lookup) ==="),
        ("obama-birthday", "lookup",
         "=== SUMMARY CONTINUES on 'Obama birthday': the summary of 'Obama birthday' was passed as context "
         "(lookup) ==="),
        ("", "none", "=== NO SUMMARY PASSED as context: this message needs no memory of earlier chat ==="),
        ("", "compose", "=== NO SINGLE SUMMARY: the notebook's list of earlier topics was passed as context ==="),
    ]
    for topic, memory, expected in cases:
        caplog.clear()
        with caplog.at_level(logging.INFO, logger="notestack.chat_context"):
            agent("q", mem, memory, topic)
        assert expected in caplog.text, (topic, memory, caplog.text[:600])
    monkeypatch.setattr(settings, "chat_memory_read", False)
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="notestack.chat_context"):
        agent("q", None, "none", "")
    assert "=== NO SUMMARY PASSED as context: CHAT_MEMORY_READ is off ===" in caplog.text


def test_citations_always_reach_the_answer_text():
    from app.pipeline.research import VerifiedCitation, ensure_markers

    cites = [VerifiedCitation(1, "a.md", 1, 3, "The catalog has Build, Plan and Explore agents, read-only search."),
             VerifiedCitation(2, "a.md", 9, 10, "Subagents re-enter the same loop with a cloned context."),
             VerifiedCitation(3, "a.md", 20, 21, "Zebras migrate across the plains each year.")]
    text = ("Based on your post, a project needs about five agents in its catalog.\n\n"
            "- **Build** is the default agent, and Explore does read-only search\n"
            "- A subagent is the same loop re-entered with a cloned context\n\n"
            "```\ncode line that is long enough to count as text\n```")
    out = ensure_markers(text, cites)
    for n in (1, 2, 3):
        assert f"[{n}]" in out  # every citation in the list is in the text, even one that matches nothing
    assert out.splitlines()[2].endswith("[1]") and "[2]" in out.splitlines()[3]  # each on the line it matches
    assert "[1]" not in out.split("```")[1]  # nothing is put inside a code block
    assert ensure_markers("Fine already [1][2][3].", cites) == "Fine already [1][2][3]."  # untouched when complete
    assert ensure_markers("No citations at all here, nothing to attach.", []) == "No citations at all here, nothing to attach."

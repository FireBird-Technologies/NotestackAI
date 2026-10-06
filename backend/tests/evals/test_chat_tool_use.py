"""Chat research: does the agent look beyond the post it used last time?

Seen on a real chat: after answers about "Agent Memory From Scratch", the writer asked "how does neo4j fit into this
graph based memory?". The notebook has a whole post on that ("Inside Neo4j's Agent Memory"), but the agent scoped every
search to the remembered post with `path=`, never called list_files, and cited only that one post. These tests script
that chat on a small notebook and record every tool call the agent makes.

The static tests always run: they check that the notebook reproduces the conditions, that the checker tells the real
bugged tool calls from good ones, and that the prompts carry the instruction. The live tests (opt-in) run the real
agent:

    LIVE_EVALS=1 pytest tests/evals/test_chat_tool_use.py -k live
    # the prompt from before the fix, for comparison
    LIVE_EVALS=1 EVAL_BASELINE=1 pytest tests/evals/test_chat_tool_use.py -k baseline -s

Each live case runs LIVE_EVAL_RUNS times (default 3) and needs a majority to pass, because a model's choices vary. It
uses LLM_API_KEY from the app's .env files and makes about 10 calls per run on the main model."""

import functools
import os
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

import dspy
import pytest

from app.config import settings
from app.corpus import INDEX, Corpus, ScopedTools, index_line, render_post
from app.llm import provider
from app.llm.signatures import ResearchArchive, ResearchArchiveWithMemory
from app.pipeline.research import Turn, _retry_malformed_steps, archive_guide, conversation_text, verify_citations
from app.pipeline.trace import ChatTrace
from tests.evals.live import env_value

SOURCE = "sources/substack-com/"
UNIFIED = SOURCE + "2026-07-14-how-to-implement-a-unified-memory-from-scratch.md"  # the post the chat kept using
NEO4J = SOURCE + "2026-05-19-understanding-neo4j-graph-agent-memory-system.md"  # the post that answers the question
ONTOLOGY = SOURCE + "2026-05-26-ship-a-knowledge-graph-ontology-in-5-minutes.md"
CLEAN = SOURCE + "2026-06-02-keep-knowledge-graph-clean.md"
EVALS_POST = SOURCE + "2026-09-22-evaluate-ai-agents-benchmarks-regression-tests.md"
LOOP = SOURCE + "2026-07-28-the-coding-agent-loop.md"

# The notebook (title, date, sections). The unified post comes first and has more than 40 lines about memory and graphs,
# as on the real notebook, so one unscoped search for "memory" is filled by that post alone.
POSTS = {
    UNIFIED: ("Agent Memory From Scratch", datetime(2026, 7, 14, tzinfo=UTC), [
        ("Why knowledge graphs", "I build agent memory the most complicated way, with a knowledge graph, because all "
                                 "the popular vendors (cognee, Graphiti, Neo4j's agent memory) go that way.\n\n"
                                 + "\n\n".join(f"The memory layer keeps graph state number {i} next to its source."
                                              for i in range(45))),
        ("The ontology", "One powerful ontology design is based on the 5 POLE+O nouns from law-enforcement analysis: "
                         "Person, Object, Location, Event and Organization."),
        ("When to leave MongoDB", "When do you need to switch from a single database (MongoDB) to a graph database "
                                  "(Neo4j)? Past 4 hops, past 100M to 1B vectors, when graphs are your business logic, "
                                  "or to visualize them."),
        ("Build vs buy", "Level 2: keep the business logic and serving layer on top of a memory SDK, such as Graphiti, "
                         "neo4j-labs/agent-memory, or mem0."),
    ]),
    NEO4J: ("Inside Neo4j's Agent Memory", datetime(2026, 5, 19, tzinfo=UTC), [
        ("What's inside neo4j-labs/agent-memory", "The SDK keeps one Neo4j graph with three memory tiers: short-term "
                                                  "messages, long-term entities and a reasoning trace of tool calls."),
        ("The extraction pipeline", "Neo4j's agent memory runs a three-stage extraction pipeline: spaCy, then GLiNER, "
                                    "then an LLM, and merges their entities."),
        ("Resolving duplicates", "A composite resolver matches entities by exact name, fuzzy string and semantic "
                                 "similarity. Near matches are linked with a SAME_AS relationship instead of merged."),
    ]),
    ONTOLOGY: ("Stop Chasing the Perfect Ontology", datetime(2026, 5, 26, tzinfo=UTC), [
        (None, "Ship a first knowledge graph ontology in five minutes and refine it from real data. Neo4j or any graph "
               "store works.")]),
    CLEAN: ("How to Keep Your AI Agent's Knowledge Graph Clean", datetime(2026, 6, 2, tzinfo=UTC), [
        (None, "Deduplicate entities before they reach the knowledge graph, in Neo4j or elsewhere.")]),
    EVALS_POST: ("Agent Evals 101", datetime(2026, 9, 22, tzinfo=UTC), [
        (None, "Binary metrics tied to real behavior beat vague scores. Run regression tests on every change.")]),
    LOOP: ("The Bare-Bones Coding Agent Loop", datetime(2026, 7, 28, tzinfo=UTC), [
        (None, "A coding agent is a loop: call the model, run the tools it asks for, feed the results back.")]),
}


class Store:
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


def build_notebook(tmp_path) -> tuple[Corpus, dict[str, str]]:
    """(the corpus, the notebook's allowed posts as path -> title, the remembered post first)"""
    corpus = Corpus(uuid.uuid4(), store=Store(), cache_dir=str(tmp_path))
    files = {INDEX: "\n".join(index_line(p, t, d, [h for h, _ in s if h]) for p, (t, d, s) in POSTS.items())}
    for path, (title, date, sections) in POSTS.items():
        files[path] = render_post(title=title, url="https://x/p/" + path, published_at=date, source="substack-com",
                                  sections=sections)
    corpus.write_files(files)
    corpus.sync()
    return corpus, {p: t for p, (t, _, _) in POSTS.items()}


# What the agent was given on the real chat: the summary naming the post, and the last messages, all about that post.

CHAT = [
    Turn("user", "and how do we handle ai agents memory?"),
    Turn("assistant", "Your archive covers this in **Agent Memory From Scratch**, which builds a unified memory layer: "
                      "sources in, subgraphs out, with an ontology, a write path, one collection and a serving layer."),
    Turn("user", "explain this more"),
    Turn("assistant", "Let me go deeper into **Agent Memory From Scratch**: the ontology internals, the two-step "
                      "entity cleanup and the storage decision."),
    Turn("user", "graphs are also used in agent memory right?"),
    Turn("assistant", "Yes, in your archive they are the backbone of **Agent Memory From Scratch**, which builds "
                      "memory on knowledge graphs because popular vendors (cognee, Graphiti, Neo4j's agent) do."),
]

ANCHORED_MEMORY = (
    "Topic: Agent memory (first 2026-10-05, last discussed 2026-10-05, 4 rounds). Context only, never evidence about "
    "the posts. To cite what was said earlier, use the file and line given in brackets.\n\n"
    "Summary [chats/cd974679/agent-memory.md:16]: The writer asked how to handle AI agents' memory. The assistant "
    f"answered from the post Agent Memory From Scratch ({UNIFIED}), which walks through building a unified memory "
    "layer. Later, the writer asked whether graphs are used in agent memory, and the assistant said they are the "
    "backbone of the whole design: the post builds memory via knowledge graphs because popular vendors (cognee, "
    "Graphiti, Neo4j's agent memory) go that direction. This was discussed, not verified.\n\n"
    "Latest messages in this topic, word for word:\n"
    + "\n".join(f"{'Writer' if t.role == 'user' else 'Assistant'} (2026-10-05): {t.text}" for t in CHAT))

# Later in the same chat, after two answers about Neo4j that also came only from the remembered post. The next message,
# "explainn in more detail", does not name a subject at all: the subject is only in the conversation and the notes.
LATER_CHAT = CHAT + [
    Turn("user", "how does neo4j fit into this graph based memory?"),
    Turn("assistant", "Neo4j fits into this graph-based memory design in four distinct ways, all from **Agent Memory "
                      "From Scratch**: it is the source of the ontology, the database you graduate to, an internal "
                      "exploration tool, and a buy option."),
    Turn("user", "explain more thoroughly on how neo4j could be useful and how it fits in"),
    Turn("assistant", "Let me lay out the full picture of Neo4j's usefulness, all from **Agent Memory From Scratch**: "
                      "traversal depth, Cypher for analysis, visualization, and the POLE+O ontology it borrows."),
]
LATER_MEMORY = (
    "Topic: Agent memory (first 2026-10-05, last discussed 2026-10-05, 5 rounds). Context only, never evidence about "
    "the posts. To cite what was said earlier, use the file and line given in brackets.\n\n"
    "Summary [chats/cd974679/agent-memory.md:16]: The writer asked how to handle AI agents' memory. The assistant "
    f"answered from the post Agent Memory From Scratch ({UNIFIED}), which walks through building a unified memory "
    "layer. Later the writer asked more thoroughly how Neo4j could be useful and how it fits in. The assistant said "
    "the post builds the memory as a knowledge graph on purpose, the way every popular vendor including Neo4j's agent "
    "memory does. Neo4j is useful technically (deep multi-hop traversal, Cypher for analysis, visualization) and "
    "conceptually (the POLE+O ontology and extraction shape the design borrows), fitting in as the escape hatch and "
    "exploration companion to a simple single-collection production setup. This was discussed, not verified.\n\n"
    "Latest messages in this topic, word for word:\n"
    + "\n".join(f"{'Writer' if t.role == 'user' else 'Assistant'} (2026-10-05): {t.text}" for t in LATER_CHAT[-6:]))

@dataclass
class Case:
    """One follow up on the anchored chat: the writer's message, the step budget triage gave it, the chat so far, the
    memory notes, and which check applies to the agent's tool calls (see `judge`)."""

    question: str
    budget: int
    chat: list
    memory: str
    check: str


# The first three are the real bugged messages (the third came after the first two on the same chat). The rest are other
# kinds of follow up on the same anchored chat, so a fix for one cannot break the others.
CASES = {
    "neo4j-quick": Case("how does neo4j fit into this graph based memory?", 4, CHAT, ANCHORED_MEMORY, "wide:neo4j"),
    "neo4j-deep": Case("explain more thoroughly on how neo4j could be useful and how it fits in", 10, CHAT,
                       ANCHORED_MEMORY, "wide:neo4j"),
    "bare-follow-up": Case("explainn in more detail", 10, LATER_CHAT, LATER_MEMORY, "wide:neo4j"),
    # a new subject: the answer is in a post the chat has not used
    "new-subject": Case("how do I evaluate my agents with regression tests?", 4, CHAT, ANCHORED_MEMORY, "wide:evals"),
    # the writer names the post: limiting the answer to it is what they asked for
    "explicit-post": Case("Using only the Agent Memory From Scratch post, explain how neo4j fits into this graph "
                          "based memory", 4, CHAT, ANCHORED_MEMORY, "only-remembered"),
    # a detail that the remembered post (or the ontology post) holds: the agent must still answer with citations
    "same-post-detail": Case("explain the POLE+O ontology part in more detail", 10, CHAT, ANCHORED_MEMORY,
                             "answers"),
}


# Judging the tool calls

def problems(calls: list[tuple[str, dict]], dedicated: str = NEO4J) -> list[str]:
    """What is wrong with an agent's tool calls for a question that a post other than the remembered one answers."""
    out = []
    looked_wide = any(name == "list_files" for name, _ in calls) or any(
        name == "search" and not args.get("path") for name, args in calls)
    if not looked_wide:
        out.append("never looked beyond the remembered post: no list_files, and every search was limited with path=")
    if not any(name == "read" and args.get("path") == dedicated for name, args in calls):
        out.append("never read the post devoted to the question")
    return out


class Recorder:
    """The agent's three tools, each call written down with its arguments before it runs."""

    def __init__(self, tools: ScopedTools):
        self.calls: list[tuple[str, dict]] = []
        for name in ("list_files", "search", "read"):
            setattr(self, name, self._wrap(getattr(tools, name)))

    def _wrap(self, fn):
        @functools.wraps(fn)  # keeps the name, docstring and signature the agent is shown
        def call(*args, **kwargs):
            self.calls.append((fn.__name__, kwargs))
            return fn(*args, **kwargs)

        return call


# The real tool calls from the chat, read from the model's cached replies

REAL_ANSWER_3 = [("search", {"pattern": "graph", "path": UNIFIED}),
                 ("read", {"path": UNIFIED, "start_line": 26, "end_line": 34}),
                 ("read", {"path": UNIFIED, "start_line": 56, "end_line": 82})]
REAL_ANSWER_4 = [("search", {"pattern": "neo4j", "path": UNIFIED}),
                 ("read", {"path": UNIFIED, "start_line": 180, "end_line": 215})]
REAL_ANSWER_5 = [("search", {"pattern": "neo4j|cypher|graph database", "path": UNIFIED}),
                 ("read", {"path": UNIFIED, "start_line": 175, "end_line": 215}),
                 ("read", {"path": UNIFIED, "start_line": 24, "end_line": 36})]
# An earlier chat with nothing anchoring it did what is wanted: it searched the whole archive and read the right post.
GOOD = [("search", {"pattern": "graph memor|knowledge graph|graphrag"}),
        ("read", {"path": NEO4J, "start_line": 1, "end_line": 145}),
        ("read", {"path": UNIFIED, "start_line": 1, "end_line": 160})]


def test_the_notebook_reproduces_the_conditions_of_the_bug(tmp_path):
    corpus, allowed = build_notebook(tmp_path)
    tools = ScopedTools(corpus, allowed)
    assert list(allowed)[0] == UNIFIED and len(allowed) == 6
    found = [line.split(":")[0] for line in tools.search("memory").splitlines() if line.startswith("sources")]
    assert set(found) == {UNIFIED} and len(found) == 40  # one unscoped search is filled by the remembered post alone
    assert "more matches" in tools.search("memory")
    scoped = tools.search("neo4j", path=UNIFIED)
    assert scoped.count(UNIFIED) >= 2 and NEO4J not in scoped  # scoping hides the post devoted to the question
    assert "SAME_AS" in "\n".join(corpus.read_lines(NEO4J)) and "SAME_AS" not in "\n".join(corpus.read_lines(UNIFIED))


def test_the_memory_block_names_the_post_like_the_real_one():
    assert f"answered from the post Agent Memory From Scratch ({UNIFIED})" in ANCHORED_MEMORY
    assert ANCHORED_MEMORY.count("Agent Memory From Scratch") >= 4
    assert len(ANCHORED_MEMORY) < settings.chat_memory_context_chars
    assert "Latest messages in this topic, word for word:" in ANCHORED_MEMORY
    assert conversation_text(CHAT).count("Writer:") == 3


def test_the_bare_follow_up_case_carries_the_later_chat_like_the_real_one():
    case = CASES["bare-follow-up"]
    assert case.question == "explainn in more detail" and case.budget == 10 and case.chat is LATER_CHAT
    assert "neo4j" not in case.question.lower()  # the subject is only in the conversation and the notes
    assert f"answered from the post Agent Memory From Scratch ({UNIFIED})" in case.memory
    assert len(case.memory) < settings.chat_memory_context_chars and "Neo4j" in case.memory
    assert conversation_text(case.chat).count("Writer:") == 4  # the agent sees the last 8 turns, as in the app


def test_every_case_is_anchored_on_the_remembered_post_and_has_a_known_check():
    assert len(CASES) == 6
    for name, case in CASES.items():
        assert UNIFIED in case.memory and case.check in {"wide:neo4j", "wide:evals", "only-remembered", "answers"}, name
        assert case.budget in (4, 10) and case.question.strip()
    assert "only" in CASES["explicit-post"].question.lower()  # the one case where limiting to a post is right
    assert not any(w in CASES["new-subject"].question.lower() for w in ("neo4j", "memory", "graph"))


@pytest.mark.parametrize("calls", [REAL_ANSWER_3, REAL_ANSWER_4, REAL_ANSWER_5], ids=["answer3", "answer4", "answer5"])
def test_the_real_bugged_tool_calls_are_flagged(calls):
    found = problems(calls)
    assert len(found) == 2 and "never looked beyond the remembered post" in found[0], found


def test_the_checker_accepts_a_search_over_the_whole_archive_and_a_read_of_the_right_post():
    assert problems(GOOD) == []
    assert problems([("list_files", {}), ("read", {"path": NEO4J})]) == []  # listing the posts is looking wide too


def test_the_judge_applies_the_check_each_case_asks_for():
    wide = CASES["neo4j-quick"]
    assert judge(wide, GOOD, [NEO4J, UNIFIED]) == []
    assert "does not cite the post devoted" in " ".join(judge(wide, GOOD, [UNIFIED]))
    assert len(judge(wide, REAL_ANSWER_4, [UNIFIED])) == 3  # scoped, never read it, never cited it
    evals_calls = [("search", {"pattern": "regression"}), ("read", {"path": EVALS_POST})]
    assert judge(CASES["new-subject"], evals_calls, [EVALS_POST]) == []
    assert judge(CASES["new-subject"], REAL_ANSWER_4, [UNIFIED])  # staying on the remembered post fails here
    only = CASES["explicit-post"]
    assert judge(only, REAL_ANSWER_4, [UNIFIED]) == []  # the writer asked for that post, so staying in it is right
    assert judge(only, GOOD, [NEO4J, UNIFIED]) == ["read another post: " + NEO4J.rsplit("/", 1)[-1],
                                                   "cited another post: " + NEO4J.rsplit("/", 1)[-1]]
    detail = CASES["same-post-detail"]
    assert judge(detail, [("search", {"pattern": "POLE"})], [UNIFIED]) == []
    assert judge(detail, [], [UNIFIED]) == ["used no tools"]
    assert judge(detail, REAL_ANSWER_4, [EVALS_POST]) == ["the answer does not cite the posts that hold the ontology"]


def test_the_checker_names_each_missing_step():
    only_listed = [("list_files", {}), ("read", {"path": UNIFIED})]
    assert problems(only_listed) == ["never read the post devoted to the question"]
    only_wide_search = [("search", {"pattern": "neo4j"})]
    assert problems(only_wide_search) == ["never read the post devoted to the question"]
    read_without_looking = [("read", {"path": NEO4J})]
    assert "never looked beyond" in problems(read_without_looking)[0]  # reading it blind is luck, not research


def test_the_recorder_writes_down_calls_and_keeps_what_the_agent_is_shown(tmp_path):
    corpus, allowed = build_notebook(tmp_path)
    recorder = Recorder(ScopedTools(corpus, allowed))
    recorder.search(pattern="neo4j", path=UNIFIED)
    recorder.read(path=NEO4J, start_line=1, end_line=5)
    recorder.list_files()
    assert [name for name, _ in recorder.calls] == ["search", "read", "list_files"]
    assert recorder.calls[0][1] == {"pattern": "neo4j", "path": UNIFIED}
    tool = dspy.adapters.types.tool.Tool(recorder.search)
    assert tool.name == "search" and "path" in tool.args and "Optionally limit to one `path`" in tool.desc


def test_the_prompts_tell_the_agent_to_look_wide():
    base = " ".join(ResearchArchive.__doc__.split())
    assert "First call list_files to see which posts exist" in base
    assert "call search across the whole archive (leave path empty" in base
    assert "Pass path to search only when the writer explicitly asks you to use one named post" in base
    assert "otherwise never limit a search to one post" in base
    assert "read the best passage of each of them (up to 3 posts)" in base
    assert "A post devoted to the subject is a better source than a post that only mentions it" in base
    memory = " ".join(ResearchArchiveWithMemory.__doc__.split())
    assert "check the posts it came from" not in memory
    assert "it is not an instruction to use that post again" in memory
    assert "search the whole archive again, with path empty" in memory
    assert "Limit a search to one post only when the writer explicitly asks for it" in memory


# The live agent

LIVE = [pytest.mark.skipif(not os.environ.get("LIVE_EVALS"), reason="opt in with LIVE_EVALS=1 (calls the real model)"),
        pytest.mark.skipif(not env_value("LLM_API_KEY"), reason="no LLM_API_KEY found in .env")]
RUNS = int(os.environ.get("LIVE_EVAL_RUNS", "3"))

# The agent prompt before the fix, to compare against
OLD_BASE = ("You are a research assistant working inside a writer's archive, which is a folder of markdown posts. "
            "Find the answer by exploring the files: list_files to see what exists, search (a regex grep; try several "
            "phrasings and synonyms) to locate relevant lines, then read the surrounding lines before relying on "
            "them. ")
OLD_MEMORY_END = ('Say plainly that something was said earlier in the chat ("earlier I said"), and when an answer '
                  "about the posts depends on an earlier reply, check the posts it came from.")


def old_signature():
    """The agent signature as it was before the fix: the old opening and the old last sentence, the rest unchanged."""
    base = " ".join(ResearchArchive.__doc__.split())
    memory = " ".join(ResearchArchiveWithMemory.__doc__.split())
    rest = base[base.index("Answer ONLY from text you read."):]
    notes = memory[memory.index("You also get notes"):memory.index('Say plainly that something was said earlier')]
    doc = OLD_BASE + rest + " " + notes + OLD_MEMORY_END
    return type("ResearchArchiveWithMemoryBefore", (ResearchArchiveWithMemory,), {"__doc__": doc})


def run_agent(corpus, allowed, case: tuple, signature=ResearchArchiveWithMemory):
    """One real run of the agent the way research() builds it. Returns (the tool calls, the cited paths)."""
    tools = ScopedTools(corpus, allowed)
    recorder = Recorder(tools)
    inputs = dict(question=case.question, conversation=conversation_text(case.chat), archive_guide=archive_guide(tools),
                  writer_profile="- role: blogpost writer", chat_memory=case.memory)
    agent = _retry_malformed_steps(
        dspy.ReAct(signature, tools=[recorder.list_files, recorder.search, recorder.read], max_iters=case.budget),
        ChatTrace())
    lm = dspy.LM(settings.llm_model, api_base=settings.llm_api_base, api_key=env_value("LLM_API_KEY"),
                 temperature=settings.llm_temperature, max_tokens=settings.llm_max_tokens, cache=False,
                 **provider._extra_kwargs(None))
    with dspy.context(lm=lm, adapter=dspy.JSONAdapter()):  # the adapter the app uses
        pred = agent(**inputs)
    _, cites = verify_citations(tools, pred.answer, pred.citations or [])
    return recorder.calls, [c.path for c in cites]


def describe(calls, cited) -> str:
    steps = " -> ".join(f"{n}({', '.join(f'{k}={str(v).rsplit('/', 1)[-1]}' for k, v in a.items() if k != 'end_line')})"
                        for n, a in calls)
    return f"{steps}  |  cited: {sorted({p.rsplit('/', 1)[-1] for p in cited})}"


def judge(case: Case, calls, cited) -> list[str]:
    """What is wrong with one run, by the kind of check the case asks for. An empty list is a pass."""
    kind, _, subject = case.check.partition(":")
    reads = {args.get("path") for name, args in calls if name == "read"}
    if kind == "wide":  # the answer is in a post other than the remembered one: look wide, read it, cite it
        dedicated = {"neo4j": NEO4J, "evals": EVALS_POST}[subject]
        found = problems(calls, dedicated)
        if dedicated not in cited:
            found.append("the answer does not cite the post devoted to the question")
        return found
    if kind == "only-remembered":  # the writer named the post: stay inside it
        found = [f"read another post: {p.rsplit('/', 1)[-1]}" for p in sorted(reads - {UNIFIED}) if p]
        found += [f"cited another post: {p.rsplit('/', 1)[-1]}" for p in sorted(set(cited) - {UNIFIED})]
        if UNIFIED not in cited:
            found.append("the answer does not cite the post the writer asked for")
        return found
    # "answers": any good source will do, but the agent must research and cite
    found = []
    if not calls:
        found.append("used no tools")
    if not set(cited) & {UNIFIED, ONTOLOGY}:
        found.append("the answer does not cite the posts that hold the ontology")
    return found


def run_case(tmp_path, case: str, signature=ResearchArchiveWithMemory) -> tuple[int, list[str]]:
    corpus, allowed = build_notebook(tmp_path)
    passed, report = 0, []
    for n in range(RUNS):
        calls, cited = run_agent(corpus, allowed, CASES[case], signature)
        found = judge(CASES[case], calls, cited)
        passed += not found
        report.append(f"run {n + 1}: {'ok' if not found else 'FAIL ' + '; '.join(found)}\n    {describe(calls, cited)}")
    return passed, report


@pytest.mark.parametrize("case", list(CASES))
class TestLiveToolUse:
    pytestmark = LIVE

    def test_the_agent_looks_beyond_the_remembered_post(self, tmp_path, case):
        passed, report = run_case(tmp_path, case)
        print(f"\n[{case}] current prompt: {passed}/{RUNS} runs passed the '{CASES[case].check}' check")
        print("\n".join(report))
        assert passed > RUNS / 2, f"{passed}/{RUNS} runs passed\n" + "\n".join(report)


@pytest.mark.skipif(not os.environ.get("EVAL_BASELINE"), reason="opt in with EVAL_BASELINE=1 (a comparison only)")
@pytest.mark.parametrize("case", list(CASES))
def test_baseline_with_the_prompt_from_before_the_fix(tmp_path, case):
    if not (os.environ.get("LIVE_EVALS") and env_value("LLM_API_KEY")):
        pytest.skip("needs LIVE_EVALS=1 and LLM_API_KEY")
    passed, report = run_case(tmp_path, case, old_signature())
    print(f"\n[{case}] OLD prompt: {passed}/{RUNS} runs passed the '{CASES[case].check}' check")
    print("\n".join(report))

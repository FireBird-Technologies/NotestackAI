"""Chat memory: file formats, the job that files rounds under topics, and what happens when things go wrong.

No model and no network: `run.predict` is replaced with canned outputs and R2 with an in memory store."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.chat_memory import files, organize
from app.chat_memory.files import Quote, Topic, TopicEntry, TopicsFile
from app.config import settings
from app.corpus import Corpus
from app.llm import run
from app.models import Chat, Job, Message, Notebook, User, Workspace


class MemoryStore:
    """Stands in for R2. `fail_on` makes one key's write raise, to simulate a crash mid write."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.fail_on: str | None = None

    def put_text(self, key, text, content_type=None):
        if self.fail_on and key.endswith(self.fail_on):
            raise OSError("store went away")
        self.objects[key] = text.encode()
        return key

    def get_bytes(self, key):
        return self.objects[key]

    def exists(self, key):
        return key in self.objects

    def delete(self, key):
        self.objects.pop(key, None)


@pytest.fixture()
def world(db_session, tmp_path):
    """A workspace with one notebook and a store, plus helpers to add chats and messages."""
    user = User(email="ada@example.com", auth_provider="email")
    db_session.add(user)
    db_session.flush()
    ws = Workspace(name="Ada", owner_id=user.id)
    db_session.add(ws)
    db_session.flush()
    nb = Notebook(workspace_id=ws.id, title="Evals")
    db_session.add(nb)
    db_session.commit()
    store = MemoryStore()

    class W:
        pass

    w = W()
    w.db, w.ws, w.nb, w.store, w.clock = db_session, ws, nb, store, datetime(2026, 9, 28, 10, 0, tzinfo=UTC)

    def corpus(workspace=None, notebook=None, cache="a"):
        return Corpus((workspace or ws).id, store=store, cache_dir=str(tmp_path / cache),
                      area=f"chats/{(notebook or nb).id}")

    def chat(notebook=None):
        c = Chat(workspace_id=ws.id, notebook_id=(notebook or nb).id, title="t")
        db_session.add(c)
        db_session.commit()
        return c

    def say(c, role, text, minutes=1):
        w.clock += timedelta(minutes=minutes)
        m = Message(chat_id=c.id, role=role, content=text, created_at=w.clock)
        db_session.add(m)
        db_session.commit()
        return m

    def ask(c, question, answer):
        return say(c, "user", question), say(c, "assistant", answer)

    w.corpus, w.chat, w.say, w.ask = corpus, chat, say, ask
    return w


def fake_predict(monkeypatch, handler):
    """Replace the model call. `handler(inputs)` returns the output dict. Returns the list of calls made."""
    calls = []

    def predict(signature, *, db, workspace_id, job=None, lm=None, **inputs):
        calls.append(inputs)
        return handler(inputs)

    monkeypatch.setattr(run, "predict", predict)
    return calls


def label_of(inputs, text):
    """The short label (m3) the prompt gave to the message containing `text`."""
    for line in inputs["rounds"].splitlines():
        if text in line:
            return line.split()[0]
    raise AssertionError(f"{text!r} not in prompt")


EVALS_Q = "what have I written about benchmarks?"
EVALS_A = "You argued MMLU is saturated [1]. Best for small models: 1. X 2. Y 3. Z [2]."
OBAMA_Q = "when is Obama's birthday?"
OBAMA_A = "August 4."


def evals_then_obama(inputs):
    """A model that files evals rounds under one topic and the Obama round under another."""
    labels = {}
    current = None
    for line in inputs["rounds"].splitlines():
        if line.startswith("r"):
            current = line.strip()
        elif "Obama" in line or "August" in line:
            labels[current] = "NEW:Obama birthday"
        elif current and current not in labels:
            labels[current] = "NEW:Evals and benchmarks"
    updates = [
        {"topic": "NEW:Evals and benchmarks", "summary": "The writer asked about benchmarks. The assistant said MMLU "
         "is saturated and ranked X, Y, Z.", "gist": "Research on evals", "keywords": ["eval", "benchmark", "mmlu"],
         "keep": [label_of(inputs, "Best for small models")] if "Best for small models" in inputs["rounds"] else []},
        {"topic": "NEW:Obama birthday", "summary": "The writer asked for a date.", "gist": "A one off date question",
         "keywords": ["obama", "birthday"], "keep": []},
    ]
    return {"assignments": [{"round": r, "topic": t} for r, t in labels.items()],
            "updates": [u for u in updates if u["topic"] in labels.values()]}


# File formats


def test_topic_file_round_trips_with_awkward_text():
    t = Topic(label="Evals | benchmarks", slug="evals-benchmarks", chat_id="c1", first="2026-09-28", last="2026-10-01",
              rounds=3, keywords=["eval", "mmlu"], gist="Research | notes", recent=["a" * 36, "b" * 36],
              summary="The writer asked about evals.\nSecond line.",
              verbatim=[Quote("1" * 36, "assistant", "2026-09-28", "## Not a section\n\n[x] 1. one\n> quoted\nend"),
                        Quote("2" * 36, "writer", "2026-09-28", "Use APA references.")])
    back = files.parse_topic(files.render_topic(t))
    assert back.slug == "evals-benchmarks" and back.rounds == 3 and back.keywords == ["eval", "mmlu"]
    assert back.recent == t.recent and back.summary == t.summary
    assert [q.text for q in back.verbatim] == [q.text for q in t.verbatim]  # headings and quotes inside survive


def test_summary_headings_cannot_break_the_sections():
    assert files.clean_summary("# Big\n## Sub\ntext", 500) == "Big\nSub\ntext"
    t = Topic(label="x", slug="x", chat_id="c", summary=files.clean_summary("## Verbatim\nfake", 500))
    assert files.parse_topic(files.render_topic(t)).verbatim == []


def test_topics_file_round_trip_and_the_empty_pointer():
    tf = TopicsFile(chat_id="c1", through="m" * 36, updated="2026-10-01T00:00:00+00:00", entries=[
        TopicEntry("old", "Old", "2026-09-01", 2, "a, b", "older"),
        TopicEntry("new", "New topic", "2026-10-01", 5, "x, y", "newer | with pipe")])
    text = files.render_topics(tf)
    assert text.index("- new |") < text.index("- old |")  # newest first
    back = files.parse_topics(text)
    assert back.through == "m" * 36 and [e.slug for e in back.entries] == ["new", "old"]
    assert files.parse_topics(files.render_topics(TopicsFile(chat_id="c1"))).through == ""


@pytest.mark.parametrize("junk", ["", "no front matter at all", "---\nnever closed\n- a | b", "---\n---\n- bad line"])
def test_parsers_survive_junk(junk):
    assert files.parse_topics(junk).entries == []
    assert files.parse_topic(junk) is None


def test_topics_list_is_capped_but_the_newest_stay():
    entries = [TopicEntry(f"t{i}", f"T{i}", f"2026-01-{i + 1:02d}", 1, "", "") for i in range(files.MAX_TOPICS + 5)]
    back = files.parse_topics(files.render_topics(TopicsFile(chat_id="c", entries=entries)))
    assert len(back.entries) == files.MAX_TOPICS and back.entries[0].slug == f"t{files.MAX_TOPICS + 4}"


def test_keywords_are_cleaned_and_capped():
    words = ["Eval", "eval", " MMLU ", "a,b", ""] + [f"w{i}" for i in range(40)]
    out = files.clean_keywords(words)
    assert out[:3] == ["eval", "mmlu", "a b"] and len(out) == files.MAX_KEYWORDS


# Rounds and labels


def test_rounds_pair_a_question_with_its_answer_and_wait_for_a_missing_one(world):
    c = world.chat()
    world.ask(c, "q1", "a1")
    world.say(c, "user", "q2 not answered yet")
    rounds = organize.pair_rounds(organize.ordered_messages(world.db, c.id))
    assert [(r.label, r.writer.content, r.assistant.content) for r in rounds] == [("r1", "q1", "a1")]
    world.say(c, "user", "q3")  # q2 never got an answer, but a newer question means it is not coming
    rounds = organize.pair_rounds(organize.ordered_messages(world.db, c.id))
    assert [r.writer.content for r in rounds] == ["q1", "q2 not answered yet"] and rounds[1].assistant is None


def test_prompt_labels_hide_real_ids(world):
    c = world.chat()
    q, a = world.ask(c, "hello there", "Reply with a source [1].")
    text, labels = organize.render_rounds(organize.pair_rounds([q, a]))
    assert str(q.id) not in text and str(a.id) not in text
    assert labels == {"m1": q, "m2": a} and "[1]" not in text


# The job


def test_a_chat_that_switches_topics_gets_a_file_per_topic(world, monkeypatch):
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    world.ask(c, OBAMA_Q, OBAMA_A)
    calls = fake_predict(monkeypatch, evals_then_obama)
    result = organize.organize_chat(world.db, None, c, world.corpus())
    assert result == {"rounds": 2, "topics": 2, "more": False} and len(calls) == 1
    fresh = world.corpus(cache="reader")  # another process: nothing cached, everything from the store
    fresh.sync()
    tf = organize.read_topics_file(fresh, c.id)
    assert {e.slug for e in tf.entries} == {"evals-and-benchmarks", "obama-birthday"}
    assert tf.through != "" and tf.through == str(organize.ordered_messages(world.db, c.id)[-1].id)
    evals = organize.read_topic(fresh, c.id, "evals-and-benchmarks")
    assert evals.rounds == 1 and "mmlu" in evals.keywords and len(evals.recent) == 2
    index = "\n".join(fresh.read_lines(files.INDEX))
    assert "Evals and benchmarks" in index and "Obama birthday" in index


def test_quotes_are_copied_from_the_database_not_the_model(world, monkeypatch):
    c = world.chat()
    _, answer = world.ask(c, EVALS_Q, EVALS_A)

    def handler(inputs):
        out = evals_then_obama(inputs)
        out["updates"][0]["keep"] = [label_of(inputs, "Best for small models"), "m99"]  # m99 does not exist
        return out

    fake_predict(monkeypatch, handler)
    organize.organize_chat(world.db, None, c, world.corpus())
    fresh = world.corpus(cache="reader")
    fresh.sync()
    quotes = organize.read_topic(fresh, c.id, "evals-and-benchmarks").verbatim
    assert [q.message_id for q in quotes] == [str(answer.id)]  # the unknown label was dropped
    assert quotes[0].text == "You argued MMLU is saturated. Best for small models: 1. X 2. Y 3. Z."  # exact, no [n]


def test_a_quote_cannot_come_from_another_topics_round(world, monkeypatch):
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    world.ask(c, OBAMA_Q, OBAMA_A)

    def handler(inputs):
        out = evals_then_obama(inputs)
        out["updates"][1]["keep"] = [label_of(inputs, "Best for small models")]  # an evals message kept under Obama
        return out

    fake_predict(monkeypatch, handler)
    organize.organize_chat(world.db, None, c, world.corpus())
    fresh = world.corpus(cache="reader")
    fresh.sync()
    assert organize.read_topic(fresh, c.id, "obama-birthday").verbatim == []


def test_a_second_run_continues_and_reopens_topics(world, monkeypatch):
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    world.ask(c, OBAMA_Q, OBAMA_A)
    fake_predict(monkeypatch, evals_then_obama)
    corpus = world.corpus()
    organize.organize_chat(world.db, None, c, corpus)
    world.ask(c, "which of those benchmarks did you say was best?", "I said X was best.")
    seen = fake_predict(monkeypatch, lambda i: {
        "assignments": [{"round": "r1", "topic": "evals-and-benchmarks"}],
        "updates": [{"topic": "evals-and-benchmarks", "summary": "Extended: the assistant repeated that X was best.",
                     "gist": "Research on evals", "keywords": ["best"], "keep": []}]})
    result = organize.organize_chat(world.db, None, c, corpus)
    assert result["rounds"] == 1
    assert "evals-and-benchmarks | Evals and benchmarks" in seen[0]["topics"]  # the model saw the existing topics
    fresh = world.corpus(cache="reader")
    fresh.sync()
    evals = organize.read_topic(fresh, c.id, "evals-and-benchmarks")
    assert evals.rounds == 2 and "Extended" in evals.summary and evals.keywords[0] == "best"
    assert "mmlu" in evals.keywords  # old keywords kept
    assert len(evals.verbatim) == 0 or evals.verbatim[0].text  # earlier quotes untouched
    assert organize.read_topic(fresh, c.id, "obama-birthday").rounds == 1  # the other topic did not change


def test_a_rerun_with_nothing_new_does_nothing(world, monkeypatch):
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    calls = fake_predict(monkeypatch, evals_then_obama)
    corpus = world.corpus()
    organize.organize_chat(world.db, None, c, corpus)
    assert organize.organize_chat(world.db, None, c, corpus)["rounds"] == 0
    assert len(calls) == 1


def test_a_crash_before_the_pointer_moves_reruns_to_the_same_files(world, monkeypatch):
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    world.ask(c, OBAMA_Q, OBAMA_A)
    fake_predict(monkeypatch, evals_then_obama)
    corpus = world.corpus()
    world.store.fail_on = "TOPICS.md"  # the pointer is the last write
    with pytest.raises(OSError):
        organize.organize_chat(world.db, None, c, corpus)
    topic_keys = {k for k in world.store.objects if k.endswith(".md") and not k.endswith("TOPICS.md")}
    assert topic_keys, "topic files were written before the crash"
    assert not any(k.endswith("TOPICS.md") for k in world.store.objects)  # the pointer did not move
    before = {k: world.store.objects[k] for k in topic_keys}
    world.store.fail_on = None
    assert organize.organize_chat(world.db, None, c, world.corpus(cache="b"))["rounds"] == 2
    assert {k: world.store.objects[k] for k in topic_keys} == before  # identical files


def test_a_crash_on_an_existing_topic_does_not_count_its_rounds_twice(world, monkeypatch):
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    fake_predict(monkeypatch, evals_then_obama)
    organize.organize_chat(world.db, None, c, world.corpus())  # committed: evals has 1 round
    world.ask(c, "and the second one?", "The second was Y.")
    again = {"assignments": [{"round": "r1", "topic": "evals-and-benchmarks"}],
             "updates": [{"topic": "evals-and-benchmarks", "summary": "Longer summary.", "gist": "g",
                          "keywords": ["y"], "keep": []}]}
    fake_predict(monkeypatch, lambda i: again)
    world.store.fail_on = "TOPICS.md"
    with pytest.raises(OSError):
        organize.organize_chat(world.db, None, c, world.corpus(cache="b"))
    world.store.fail_on = None
    organize.organize_chat(world.db, None, c, world.corpus(cache="c"))
    reader = world.corpus(cache="reader")
    reader.sync()
    topic = organize.read_topic(reader, c.id, "evals-and-benchmarks")
    assert topic.rounds == 2 and len(topic.recent) == 4  # two rounds, not three


def test_the_model_failing_leaves_memory_untouched(world, monkeypatch):
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)

    def boom(inputs):
        raise RuntimeError("model is down")

    fake_predict(monkeypatch, boom)
    with pytest.raises(RuntimeError):
        organize.organize_chat(world.db, None, c, world.corpus())
    assert world.store.objects == {}


def test_junk_from_the_model_is_dropped_and_no_round_is_lost(world, monkeypatch):
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    world.ask(c, OBAMA_Q, OBAMA_A)
    fake_predict(monkeypatch, lambda i: {
        "assignments": [{"round": "r1", "topic": "NEW:Evals"}, {"round": "r7", "topic": "NEW:Ghost"}],  # r2 forgotten
        "updates": [{"topic": "NEW:Never used", "summary": "x", "gist": "x", "keywords": [], "keep": []},
                    {"topic": "NEW:Evals", "summary": "## heading\n" + "word " * 1000, "gist": "g",
                     "keywords": ["a"] * 50, "keep": ["m1"]}]})
    organize.organize_chat(world.db, None, c, world.corpus())
    fresh = world.corpus(cache="reader")
    fresh.sync()
    tf = organize.read_topics_file(fresh, c.id)
    assert [e.slug for e in tf.entries] == ["evals"]  # the forgotten round went to the most recent topic
    evals = organize.read_topic(fresh, c.id, "evals")
    assert evals.rounds == 2 and len(evals.summary) <= settings.chat_memory_summary_chars + 10
    assert not evals.summary.startswith("#") and len(evals.keywords) == 1


def test_skip_leaves_small_talk_out_but_moves_the_pointer(world, monkeypatch):
    c = world.chat()
    world.ask(c, "hi", "Hello! Ask me anything.")
    fake_predict(monkeypatch, lambda i: {"assignments": [{"round": "r1", "topic": "SKIP"}], "updates": []})
    corpus = world.corpus()
    organize.organize_chat(world.db, None, c, corpus)
    tf = organize.read_topics_file(corpus, c.id)
    assert tf.entries == [] and tf.through != ""


def test_skip_is_honored_only_for_small_talk(world, monkeypatch):
    """Seen on a real chat: the model skipped "what is the main point of the last message" as if it were chatter."""
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    world.ask(c, "what is the main point of the last message", "I could not find support for that in these posts.")
    world.ask(c, "thanks!", "Glad that helped.")
    fake_predict(monkeypatch, lambda i: {
        "assignments": [{"round": "r1", "topic": "NEW:Evals"}, {"round": "r2", "topic": "SKIP"},
                        {"round": "r3", "topic": "SKIP"}],
        "updates": [{"topic": "NEW:Evals", "summary": "s", "gist": "g", "keywords": [], "keep": []}]})
    corpus = world.corpus()
    organize.organize_chat(world.db, None, c, corpus)
    topic = organize.read_topic(corpus, c.id, "evals")
    assert topic.rounds == 2  # the real follow up was filed with the evals topic, "thanks!" was skipped
    assert "thanks" not in " ".join(organize.read_topic(corpus, c.id, "evals").summary.split()).lower()


def test_many_rounds_are_filed_in_batches(world, monkeypatch):
    monkeypatch.setattr(settings, "chat_memory_max_rounds_per_job", 2)
    c = world.chat()
    for i in range(5):
        world.ask(c, f"question {i}", f"answer {i}")
    calls = fake_predict(monkeypatch, lambda inputs: {
        "assignments": [{"round": ln.strip(), "topic": "NEW:Many"} for ln in inputs["rounds"].splitlines()
                        if ln.startswith("r")], "updates": []})
    corpus = world.corpus()
    first = organize.organize_chat(world.db, None, c, corpus)
    assert first == {"rounds": 2, "topics": 1, "more": True}
    queued = world.db.query(Job).filter(Job.kind == "chat_memory", Job.status == "queued").all()
    assert len(queued) == 1 and queued[0].params == {"chat_id": str(c.id)} and queued[0].run_after is not None
    organize.organize_chat(world.db, None, c, corpus)
    organize.organize_chat(world.db, None, c, corpus)
    assert [len(x["rounds"].split("\n\n")) for x in calls] == [2, 2, 1]
    assert organize.read_topic(corpus, c.id, "many").rounds == 5


def test_two_chats_share_the_notebook_index_without_touching_each_others_files(world, monkeypatch):
    a, b = world.chat(), world.chat()
    world.ask(a, EVALS_Q, EVALS_A)
    world.ask(b, "what about pricing?", "You raised the price.")
    fake_predict(monkeypatch, lambda inputs: {
        "assignments": [{"round": "r1", "topic": "NEW:Evals" if "benchmarks" in inputs["rounds"] else "NEW:Pricing"}],
        "updates": []})
    organize.organize_chat(world.db, None, a, world.corpus())
    organize.organize_chat(world.db, None, b, world.corpus(cache="other"))
    reader = world.corpus(cache="reader")
    reader.sync()
    index = "\n".join(reader.read_lines(files.INDEX))
    assert f"{a.id}/evals.md" in index and f"{b.id}/pricing.md" in index
    assert organize.read_topics_file(reader, a.id).entries[0].slug == "evals"


def test_another_notebook_has_its_own_area(world, monkeypatch):
    other_nb = Notebook(workspace_id=world.ws.id, title="Other")
    world.db.add(other_nb)
    world.db.commit()
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    fake_predict(monkeypatch, lambda i: {"assignments": [{"round": "r1", "topic": "NEW:Evals"}], "updates": []})
    organize.organize_chat(world.db, None, c, world.corpus())
    elsewhere = world.corpus(notebook=other_nb, cache="o")
    assert elsewhere.sync() == {}
    assert all(f"/chats/{world.nb.id}/" in k for k in world.store.objects)


def test_deleting_a_chat_removes_its_files_and_index_lines(world, monkeypatch):
    a, b = world.chat(), world.chat()
    world.ask(a, EVALS_Q, EVALS_A)
    world.ask(b, "what about pricing?", "You raised the price.")
    fake_predict(monkeypatch, lambda inputs: {
        "assignments": [{"round": "r1", "topic": "NEW:Evals" if "benchmarks" in inputs["rounds"] else "NEW:Pricing"}],
        "updates": []})
    organize.organize_chat(world.db, None, a, world.corpus())
    organize.organize_chat(world.db, None, b, world.corpus())
    removed = organize.forget_chat(world.ws.id, world.nb.id, a.id, world.db, world.corpus(cache="x"))
    assert removed == 2  # its topic file and TOPICS.md
    reader = world.corpus(cache="reader")
    manifest = reader.sync()
    assert not any(k.startswith(f"{a.id}/") for k in manifest) and f"{b.id}/pricing.md" in manifest
    index = "\n".join(reader.read_lines(files.INDEX))
    assert str(a.id) not in index and str(b.id) in index
    assert organize.forget_chat(world.ws.id, world.nb.id, a.id, world.db, world.corpus(cache="x")) == 0


def test_the_job_is_queued_once_and_only_when_enabled(world, monkeypatch):
    c = world.chat()
    monkeypatch.setattr(settings, "llm_api_key", "k")
    job = organize.queue_chat_memory(world.db, world.ws.id, c.id)
    assert job is not None and job.run_after is not None
    assert organize.queue_chat_memory(world.db, world.ws.id, c.id) is None  # one waiting job per chat
    other = world.chat()
    assert organize.queue_chat_memory(world.db, world.ws.id, other.id) is not None
    job.status = "running"  # a running job may already have read the messages, so a new one is allowed
    world.db.commit()
    assert organize.queue_chat_memory(world.db, world.ws.id, c.id) is not None
    monkeypatch.setattr(settings, "chat_memory_enabled", False)
    assert organize.queue_chat_memory(world.db, world.ws.id, world.chat().id) is None


def test_the_worker_handler_runs_the_job(world, monkeypatch, session_factory, run_jobs):
    monkeypatch.setattr(settings, "llm_api_key", "k")
    monkeypatch.setattr(settings, "chat_memory_delay_seconds", 0)
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    fake_predict(monkeypatch, lambda i: {"assignments": [{"round": "r1", "topic": "NEW:Evals"}], "updates": []})
    monkeypatch.setattr(organize, "chat_corpus", lambda ws, nb, **kw: world.corpus(cache="worker"))
    organize.queue_chat_memory(world.db, world.ws.id, c.id)
    ran = run_jobs()
    assert [j.kind for j in ran] == ["chat_memory"] and ran[0].status == "done"
    assert ran[0].result["rounds"] == 1


def test_deleting_a_chat_through_the_api_succeeds_even_with_no_memory_files(client, db_session):
    from tests.test_memory import _signup

    auth = _signup(client, "ada2@example.com")
    nb = client.post("/api/notebooks", json={"title": "N"}, headers=auth).json()
    chat = Chat(workspace_id=db_session.query(Workspace).one().id, notebook_id=uuid.UUID(nb["id"]), title="t")
    db_session.add(chat)
    db_session.commit()
    assert client.delete(f"/api/notebooks/chats/{chat.id}", headers=auth).status_code == 200
    assert db_session.get(Chat, chat.id) is None


def test_a_rebuild_recreates_lost_memory_from_the_messages(world, monkeypatch):
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    world.ask(c, OBAMA_Q, OBAMA_A)
    fake_predict(monkeypatch, evals_then_obama)
    corpus = world.corpus()
    organize.organize_chat(world.db, None, c, corpus)
    before = {k: v for k, v in world.store.objects.items() if not k.endswith("manifest.json")}
    for key in list(world.store.objects):  # the whole R2 area is lost
        world.store.delete(key)
    result = organize.rebuild_chat(world.db, None, c, world.corpus(cache="fresh"))
    assert result["rounds"] == 2
    after = {k: v for k, v in world.store.objects.items() if not k.endswith("manifest.json")}
    assert after.keys() == before.keys()


def test_a_rebuild_goes_through_every_batch_without_queueing_jobs(world, monkeypatch):
    monkeypatch.setattr(settings, "chat_memory_max_rounds_per_job", 2)
    c = world.chat()
    for i in range(5):
        world.ask(c, f"question {i}", f"answer {i}")
    fake_predict(monkeypatch, lambda inputs: {
        "assignments": [{"round": ln.strip(), "topic": "NEW:Many"} for ln in inputs["rounds"].splitlines()
                        if ln.startswith("r")], "updates": []})
    assert organize.rebuild_chat(world.db, None, c, world.corpus())["rounds"] == 5
    assert world.db.query(Job).filter(Job.kind == "chat_memory").count() == 0


def test_cleanup_removes_memory_of_chats_that_no_longer_exist(world, monkeypatch):
    keep, gone = world.chat(), world.chat()
    world.ask(keep, EVALS_Q, EVALS_A)
    world.ask(gone, "what about pricing?", "You raised the price.")
    fake_predict(monkeypatch, lambda inputs: {
        "assignments": [{"round": "r1", "topic": "NEW:Evals" if "benchmarks" in inputs["rounds"] else "NEW:Pricing"}],
        "updates": []})
    organize.organize_chat(world.db, None, keep, world.corpus())
    organize.organize_chat(world.db, None, gone, world.corpus())
    world.db.delete(gone)  # deleted in the database, but its files were left behind
    world.db.commit()
    assert organize.forget_orphans(world.db, world.ws.id, world.nb.id, world.corpus(cache="x")) == 1
    reader = world.corpus(cache="reader")
    manifest = reader.sync()
    assert not any(k.startswith(f"{gone.id}/") for k in manifest) and f"{keep.id}/evals.md" in manifest
    assert organize.forget_orphans(world.db, world.ws.id, world.nb.id, world.corpus(cache="x")) == 0


def test_the_job_logs_each_summary_and_each_r2_write(world, monkeypatch, caplog):
    import logging

    monkeypatch.setattr(settings, "chat_context_log", True)
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    world.ask(c, OBAMA_Q, OBAMA_A)
    fake_predict(monkeypatch, evals_then_obama)
    corpus = world.corpus()
    with caplog.at_level(logging.INFO):
        organize.organize_chat(world.db, None, c, corpus)
        world.ask(c, "which of those was best?", "I said X.")
        fake_predict(monkeypatch, lambda i: {"assignments": [{"round": "r1", "topic": "evals-and-benchmarks"}],
                                             "updates": [{"topic": "evals-and-benchmarks", "summary": "Longer.",
                                                          "gist": "g", "keywords": ["best"], "keep": []}]})
        organize.organize_chat(world.db, None, c, corpus)
    text = caplog.text
    assert "filing 2 of 2 waiting round(s) of chat" in text and "filing 1 of 1 waiting round(s)" in text
    assert "summary CREATED for topic 'Evals and benchmarks' (evals-and-benchmarks)" in text
    assert "summary CREATED for topic 'Obama birthday'" in text
    assert "summary UPDATED for topic 'Evals and benchmarks'" in text
    key = f"ws/{world.ws.id}/chats/{world.nb.id}/{c.id}/evals-and-benchmarks.md"
    assert f"wrote to R2: {key} (" in text and f"wrote to R2: ws/{world.ws.id}/chats/{world.nb.id}/INDEX.md" in text
    assert f"wrote to R2: ws/{world.ws.id}/chats/{world.nb.id}/{c.id}/TOPICS.md" in text
    assert "through pointer moved" in text and "new summary of 'Evals and benchmarks':" in text and "Longer." in text


def test_summary_text_stays_out_of_the_log_when_text_logging_is_off(world, monkeypatch, caplog):
    import logging

    monkeypatch.setattr(settings, "chat_context_log", False)
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    fake_predict(monkeypatch, evals_then_obama)
    with caplog.at_level(logging.INFO):
        organize.organize_chat(world.db, None, c, world.corpus())
    assert "summary CREATED" in caplog.text and "wrote to R2" in caplog.text  # what happened is always logged
    assert "saturated" not in caplog.text and "new summary of" not in caplog.text  # what was said is not


def test_the_job_logs_topic_switches_and_summary_changes_as_banners(world, monkeypatch, caplog):
    import logging

    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    world.ask(c, OBAMA_Q, OBAMA_A)
    fake_predict(monkeypatch, evals_then_obama)
    corpus = world.corpus()
    with caplog.at_level(logging.INFO, logger="notestack.chat_memory"):
        organize.organize_chat(world.db, None, c, corpus)
    assert "=== SUMMARY CREATED: topic 'Evals and benchmarks' (evals-and-benchmarks) new -> " in caplog.text
    assert "=== TOPIC SWITCHED while filing chat" in caplog.text
    assert "'Evals and benchmarks' -> 'Obama birthday' (round r2)" in caplog.text
    assert organize.read_topics_file(corpus, c.id).current == "obama-birthday"  # what the chat was last on
    caplog.clear()
    world.ask(c, "back to benchmarks: which one?", "I said X.")
    fake_predict(monkeypatch, lambda i: {"assignments": [{"round": "r1", "topic": "evals-and-benchmarks"}],
                                         "updates": [{"topic": "evals-and-benchmarks", "gist": "g", "keywords": [],
                                                      "summary": "Longer summary here.", "keep": []}]})
    with caplog.at_level(logging.INFO, logger="notestack.chat_memory"):
        organize.organize_chat(world.db, None, c, corpus)
    assert "'Obama birthday' -> 'Evals and benchmarks' (round r1) ===" in caplog.text  # switched back
    assert "=== SUMMARY CHANGED: topic 'Evals and benchmarks' (evals-and-benchmarks)" in caplog.text
    assert organize.read_topics_file(corpus, c.id).current == "evals-and-benchmarks"


# Off-topic refusals and near duplicate topics


def _refusal(world, c, question):
    q = world.say(c, "user", question)
    a = world.say(c, "assistant", "I only answer from the posts in this notebook, so I cannot help with that one.")
    a.recall_json = {"kind": "off_topic"}
    world.db.commit()
    return q, a


def test_an_off_topic_refusal_is_not_filed_as_a_topic(world, monkeypatch):
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    _, refusal = _refusal(world, c, "what is an LLMOps platform?")
    calls = fake_predict(monkeypatch, lambda i: {
        "assignments": [{"round": r, "topic": "NEW:Evals and benchmarks"} for r in ("r1", "r2")],
        "updates": [{"topic": "NEW:Evals and benchmarks", "summary": "Benchmarks.", "gist": "g", "keywords": ["eval"],
                     "keep": []}]})
    corpus = world.corpus()
    organize.organize_chat(world.db, None, c, corpus)
    assert "LLMOps" not in calls[0]["rounds"]  # the model never sees the refused round
    tf = organize.read_topics_file(corpus, c.id)
    assert [e.slug for e in tf.entries] == ["evals-and-benchmarks"] and tf.entries[0].rounds == 1
    assert tf.through == str(refusal.id)  # but it is counted as handled, so it is not looked at again


@pytest.mark.parametrize("kind", ["off_topic", "about_app", "chitchat"])
def test_rounds_that_were_not_about_the_posts_never_reach_a_topic_or_r2(world, monkeypatch, kind):
    """Turned down, app help and small talk say nothing about the posts: not sent to the model, not in TOPICS.md."""
    c = world.chat()
    world.ask(c, EVALS_Q, EVALS_A)
    world.say(c, "user", "how do I add another substack?")
    a = world.say(c, "assistant", "Add more Substacks on the Sources page.")  # worded differently from a refusal
    a.recall_json = {"kind": kind}
    world.db.commit()
    calls = fake_predict(monkeypatch, lambda i: {
        "assignments": [{"round": "r1", "topic": "NEW:Evals and benchmarks"}],
        "updates": [{"topic": "NEW:Evals and benchmarks", "summary": "Benchmarks.", "gist": "g", "keywords": ["eval"],
                     "keep": []}]})
    corpus = world.corpus()
    organize.organize_chat(world.db, None, c, corpus)
    assert "substack" not in calls[0]["rounds"]
    tf = organize.read_topics_file(corpus, c.id)
    assert [e.slug for e in tf.entries] == ["evals-and-benchmarks"] and tf.through == str(a.id)
    keys = corpus.sync()
    assert not any("substack" in key or "out-of-scope" in key for key in keys)
    assert not any("substack" in corpus.read_lines(key)[i].lower() for key in keys if key.endswith(".md")
                   for i in range(len(corpus.read_lines(key))))  # nothing of it in any file written to R2


def test_a_batch_of_only_refusals_makes_no_model_call_and_moves_the_pointer(world, monkeypatch):
    c = world.chat()
    _, refusal = _refusal(world, c, "who won the game last night?")
    calls = fake_predict(monkeypatch, lambda i: pytest.fail("the model should not be called"))
    corpus = world.corpus()
    result = organize.organize_chat(world.db, None, c, corpus)
    tf = organize.read_topics_file(corpus, c.id)
    assert calls == [] and result["topics"] == 0 and tf.entries == [] and tf.through == str(refusal.id)


def test_an_older_refusal_without_a_kind_is_still_recognised(world, monkeypatch):
    c = world.chat()
    world.ask(c, "what is an LLMOps platform?", "I only answer from the posts in this notebook, so I cannot help.")
    world.ask(c, EVALS_Q, EVALS_A)  # a real answer with no kind and no refusal wording is kept
    calls = fake_predict(monkeypatch, lambda i: {
        "assignments": [{"round": "r2", "topic": "NEW:Evals and benchmarks"}],
        "updates": [{"topic": "NEW:Evals and benchmarks", "summary": "S.", "gist": "g", "keywords": ["eval"],
                     "keep": []}]})
    organize.organize_chat(world.db, None, c, world.corpus())
    assert "LLMOps" not in calls[0]["rounds"] and "benchmarks" in calls[0]["rounds"]


HARNESS_Q, HARNESS_A = "how many agents should a project have?", "About five, as a catalog."


def _first_topic(world, monkeypatch, c, corpus):
    world.ask(c, "what is needed to build a coding agent?", "A loop, tools and a harness.")
    fake_predict(monkeypatch, lambda i: {
        "assignments": [{"round": "r1", "topic": "NEW:Coding agent harness"}],
        "updates": [{"topic": "NEW:Coding agent harness", "summary": "The writer asked what a coding agent needs.",
                     "gist": "What a coding agent needs", "keywords": ["coding agent", "harness", "agent loop", "tools",
                                                                         "subagent", "context"], "keep": []}]})
    organize.organize_chat(world.db, None, c, corpus)


def test_a_new_topic_that_mostly_repeats_an_old_one_joins_it(world, monkeypatch):
    c = world.chat()
    corpus = world.corpus()
    _first_topic(world, monkeypatch, c, corpus)
    world.ask(c, HARNESS_Q, HARNESS_A)
    fake_predict(monkeypatch, lambda i: {
        "assignments": [{"round": "r1", "topic": "NEW:Agent catalog count"}],
        "updates": [{"topic": "NEW:Agent catalog count", "summary": "The writer asked how many agents. About five.",
                     "gist": "How many agents", "keywords": ["agent", "coding agents", "harness", "subagents", "tool",
                                                              "context", "catalog"], "keep": []}]})
    organize.organize_chat(world.db, None, c, corpus)
    fresh = world.corpus(cache="reader")
    fresh.sync()
    tf = organize.read_topics_file(fresh, c.id)
    assert [e.slug for e in tf.entries] == ["coding-agent-harness"]  # no second file
    t = organize.read_topic(fresh, c.id, "coding-agent-harness")
    assert t.rounds == 2 and t.gist == "What a coding agent needs"  # the old gist stays
    assert "what a coding agent needs" in t.summary and "About five" in t.summary  # old summary kept, new added
    assert "catalog" in t.keywords and tf.current == "coding-agent-harness"


def test_a_related_but_different_topic_stays_separate(world, monkeypatch):
    c = world.chat()
    corpus = world.corpus()
    _first_topic(world, monkeypatch, c, corpus)
    world.ask(c, "what is the difference between an agent and a workflow?", "Autonomy: who controls the flow.")
    fake_predict(monkeypatch, lambda i: {
        "assignments": [{"round": "r1", "topic": "NEW:Agent versus workflow"}],
        "updates": [{"topic": "NEW:Agent versus workflow", "summary": "The writer asked how agents differ from workflows.",
                     "gist": "Agents vs workflows", "keywords": ["workflow", "autonomy", "control flow", "routing",
                                                                 "litmus test", "orchestrator worker"], "keep": []}]})
    organize.organize_chat(world.db, None, c, corpus)
    tf = organize.read_topics_file(corpus, c.id)
    assert {e.slug for e in tf.entries} == {"coding-agent-harness", "agent-versus-workflow"}

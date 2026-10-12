import uuid
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from app.models import WorkspaceMemory
from app.services import memory
from tests.conftest import last_code


def _signup(client, email):
    client.post("/api/auth/email/register/start", json={"email": email, "password": "stardust-42"})
    r = client.post("/api/auth/email/register/verify", json={"email": email, "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture()
def auth(client):
    return _signup(client, "ada@example.com")


def put(client, auth, key, value):
    return client.put(f"/api/memory/{key}", json={"value": value}, headers=auth)


def workspace_id(db_session):
    return db_session.query(WorkspaceMemory).one().workspace_id


def test_create_update_and_delete(client, auth):
    assert client.get("/api/memory", headers=auth).json() == {"items": [], "limit": memory.MAX_FACTS}
    assert put(client, auth, "Audience", "indie founders").json()["source"] == "user"
    put(client, auth, "audience", "  solo founders  ")  # same key once cleaned: replaces, never duplicates
    items = client.get("/api/memory", headers=auth).json()["items"]
    assert [(i["key"], i["value"]) for i in items] == [("audience", "solo founders")]
    assert client.delete("/api/memory/audience", headers=auth).status_code == 200
    assert client.delete("/api/memory/audience", headers=auth).status_code == 404
    assert client.get("/api/memory", headers=auth).json()["items"] == []


def test_a_workspace_has_one_row_holding_every_note(client, auth, db_session):
    for i in range(3):
        put(client, auth, f"note-{i}", "v")
    rows = db_session.query(WorkspaceMemory).all()
    assert len(rows) == 1 and sorted(rows[0].facts) == ["note-0", "note-1", "note-2"]


def test_other_workspaces_cannot_see_or_touch_notes(client, auth):
    put(client, auth, "tone", "short answers")
    other = _signup(client, "bob@example.com")
    assert client.get("/api/memory", headers=other).json()["items"] == []
    assert client.delete("/api/memory/tone", headers=other).status_code == 404
    put(client, other, "tone", "long answers")
    assert client.get("/api/memory", headers=auth).json()["items"][0]["value"] == "short answers"


def test_limits_and_empty_values(client, auth):
    assert put(client, auth, "big", "x" * (memory.MAX_VALUE + 1)).status_code == 422
    assert put(client, auth, "blank", "   ").status_code == 422
    assert put(client, auth, "---", "value").status_code == 422  # the name cleans to nothing
    for i in range(memory.MAX_FACTS):
        assert put(client, auth, f"fact-{i}", "v").status_code == 200
    assert put(client, auth, "one-too-many", "v").status_code == 422
    assert put(client, auth, "fact-0", "changed").status_code == 200  # changing a note at the cap is fine


def test_the_job_adds_updates_and_deletes_its_own_notes(client, auth, db_session):
    put(client, auth, "audience", "typed by the writer")
    ws = workspace_id(db_session)
    applied = memory.apply_operations(db_session, ws, [
        {"op": "add", "key": "Tone", "value": "short answers"},
        {"op": "add", "key": "avoid", "value": "jargon"},
        {"op": "update", "key": "tone", "value": "warm and short"},
        {"op": "delete", "key": "avoid"},
    ])
    assert [(a["op"], a["key"]) for a in applied] == [("add", "tone"), ("add", "avoid"), ("update", "tone"),
                                                       ("delete", "avoid")]
    items = {i["key"]: i for i in memory.list_facts(db_session, ws)}
    assert items["tone"]["value"] == "warm and short" and items["tone"]["source"] == "auto"
    assert "avoid" not in items


def test_the_job_never_changes_notes_the_writer_typed(client, auth, db_session):
    put(client, auth, "audience", "indie founders")
    ws = workspace_id(db_session)
    applied = memory.apply_operations(db_session, ws, [
        {"op": "update", "key": "audience", "value": "designers"},
        {"op": "delete", "key": "audience"},
    ])
    assert applied == []
    assert memory.list_facts(db_session, ws)[0]["value"] == "indie founders"


def test_the_job_skips_bad_operations_repeats_and_the_cap(client, auth, db_session):
    put(client, auth, "seed", "v")
    ws = workspace_id(db_session)
    assert memory.apply_operations(db_session, ws, [
        {"op": "add", "key": "", "value": "no key"},
        {"op": "add", "key": "empty", "value": "  "},
        {"op": "add", "key": "huge", "value": "x" * (memory.MAX_VALUE + 1)},
        {"op": "delete", "key": "missing"},
        {"op": "rename", "key": "seed", "value": "x"},
    ]) == []
    assert memory.apply_operations(db_session, ws, [{"op": "add", "key": "tone", "value": "short"}])
    assert memory.apply_operations(db_session, ws, [{"op": "update", "key": "tone", "value": "short"}]) == []
    for i in range(memory.MAX_FACTS):
        memory.apply_operations(db_session, ws, [{"op": "add", "key": f"auto-{i}", "value": "v"}])
    assert len(memory.list_facts(db_session, ws)) == memory.MAX_FACTS


def test_profile_text_is_capped_and_marks_empty():
    assert memory.profile_text([]) == "(none)"
    items = [{"key": f"k{i}", "value": "v" * 400} for i in range(10)]
    assert len(memory.profile_text(items)) == memory.PROFILE_CHARS


def test_research_gives_the_profile_to_the_agent(monkeypatch, tmp_path):
    from app.corpus import Corpus
    from app.pipeline import research as r

    seen = {}

    def fake_react(signature, tools, max_iters):
        def run(**inputs):
            seen.update(inputs)
            return SimpleNamespace(answer="x", citations=[], unsupported=True)
        return run

    @contextmanager
    def no_usage(lm):
        yield SimpleNamespace(prompt_tokens=0, completion_tokens=0)

    monkeypatch.setattr(r.dspy, "ReAct", fake_react)
    monkeypatch.setattr(r, "main_lm", lambda: None)
    monkeypatch.setattr(r, "track_usage", no_usage)
    monkeypatch.setattr(r, "triage", lambda *a: r.Triage("archive", "q", "quick", ""))
    corpus = Corpus(uuid.uuid4(), cache_dir=str(tmp_path))
    monkeypatch.setattr(corpus, "sync", lambda: {})
    r.research(corpus, {"a.md": "On Pricing"}, "What did I charge?", profile="- audience: founders")
    assert seen["writer_profile"] == "- audience: founders"
    r.research(corpus, {"a.md": "On Pricing"}, "What did I charge?")
    assert seen["writer_profile"] == "(none)"

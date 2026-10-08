"""The suggested templates in the Create report dialog are written once, kept, prepared in the background and served at once."""

import pytest
from sqlalchemy import select

from app.config import settings
from app.llm import run
from app.models import Job, ReportTemplateCache
from app.services import report_suggestions
from tests.test_idea_pool import make_posts, owner  # noqa: F401  (the fixture)


@pytest.fixture()
def asked(monkeypatch):
    """Fake the model; `asked` lists what it was asked, and `answer` is what it says."""
    calls: list[list[str]] = []
    state = {"answer": [{"name": f"Template {n}", "description": "d", "prompt": "Write about {about}."} for n in range(4)]}

    def predict(signature, *, db, workspace_id, job=None, lm=None, **inputs):
        assert signature.__name__ == "SuggestReportTemplates"
        calls.append(inputs["items"])
        return {"templates": state["answer"]}

    monkeypatch.setattr(run, "predict", predict)
    return calls, state


def _suggest(client, headers, docs):
    return client.post("/api/reports/suggest", json={"document_ids": [str(d.id) for d in docs]}, headers=headers)


def test_the_same_sources_get_their_templates_again_without_the_model(client, owner, db_session, asked):  # noqa: F811
    headers, ws = owner
    calls, state = asked
    docs = make_posts(db_session, ws, 4)
    first = _suggest(client, headers, docs).json()["templates"]
    again = _suggest(client, headers, list(reversed(docs))).json()["templates"]  # the order they were ticked in does not matter
    assert len(calls) == 1 and first == again and [t["id"] for t in first] == [f"suggested-{n}" for n in range(1, 5)]
    assert len(db_session.scalars(select(ReportTemplateCache)).all()) == 1
    # A post whose ideas changed is a different input: new templates, the old set is left alone
    docs[0].metadata_json = {**docs[0].metadata_json, "ideas": [{"label": "A new idea", "note": "Changed.", "sources": [], "details": []}]}
    db_session.commit()
    _suggest(client, headers, docs)
    assert len(calls) == 2 and len(db_session.scalars(select(ReportTemplateCache)).all()) == 2
    # What the model read is the stored ideas, not the post text
    assert any("- A new idea: Changed." in item for item in calls[1]) and not any("Sentence 1 about" in item for item in calls[1])


def test_a_failed_or_empty_answer_is_never_kept(client, owner, db_session, asked):  # noqa: F811
    headers, ws = owner
    calls, state = asked
    docs = make_posts(db_session, ws, 3)
    state["answer"] = []
    assert _suggest(client, headers, docs).json() == {"templates": []}
    state["answer"] = [{"name": "", "description": "", "prompt": ""}, {"name": "Only", "description": "d", "prompt": "p"},
                       {"name": "only", "description": "dup", "prompt": "p"}]  # a blank and a repeat are dropped
    assert [t["name"] for t in _suggest(client, headers, docs).json()["templates"]] == ["Only"]
    assert len(calls) == 2  # the empty answer was not kept, so the next request asked again


def test_templates_are_prepared_in_the_background_so_the_dialog_is_instant(client, owner, db_session, run_jobs, asked, monkeypatch):  # noqa: F811
    headers, ws = owner
    calls, _ = asked
    monkeypatch.setattr(settings, "llm_api_key", "test-key")
    docs = make_posts(db_session, ws, 12, ideas_each=4)
    client.post("/api/notebooks", json={"title": "Big", "document_ids": [str(d.id) for d in docs]}, headers=headers)
    client.post("/api/notebooks", json={"title": "Same again", "document_ids": [str(d.id) for d in docs[:3]]}, headers=headers)
    queued = db_session.scalars(select(Job).where(Job.kind == "report_templates")).all()
    assert len(queued) == 1  # one at a time, however many notebooks changed
    assert run_jobs()[0].kind == "report_templates" and len(calls) == 2  # one set written for each notebook
    ran = len(calls)
    monkeypatch.setattr(run, "predict", lambda *a, **k: pytest.fail("the dialog's request was prepared already"))
    r = _suggest(client, headers, docs)  # what the dialog sends: the notebook's posts
    assert r.status_code == 200 and len(r.json()["templates"]) == 4 and ran == 2


def test_warming_skips_posts_whose_ideas_are_not_stored_yet_and_sets_already_kept(db_session, owner, asked):  # noqa: F811
    _, ws = owner
    calls, _ = asked
    from app.models import Notebook, NotebookDocument

    bare = make_posts(db_session, ws, 4, with_ideas=0)
    nb = Notebook(workspace_id=ws.id, title="Bare")
    db_session.add(nb)
    db_session.flush()
    db_session.add_all([NotebookDocument(notebook_id=nb.id, document_id=d.id) for d in bare])
    db_session.commit()
    assert report_suggestions.warm_workspace(db_session, ws.id) == 0 and calls == []  # waits for the ideas
    for d in bare:
        d.metadata_json = {"ideas_hash": d.content_hash, "ideas": [{"label": "Idea", "note": "Note.", "sources": [], "details": []}]}
    db_session.commit()
    assert report_suggestions.warm_workspace(db_session, ws.id) == 1 and len(calls) == 1
    assert report_suggestions.warm_workspace(db_session, ws.id) == 0 and len(calls) == 1  # already kept


def test_only_one_warm_up_is_queued_and_none_without_a_model_key(db_session, owner, monkeypatch):  # noqa: F811
    _, ws = owner
    monkeypatch.setattr(settings, "llm_api_key", "")
    report_suggestions.queue_warmup(db_session, ws.id)
    assert db_session.scalars(select(Job).where(Job.kind == "report_templates")).all() == []
    monkeypatch.setattr(settings, "llm_api_key", "k")
    report_suggestions.queue_warmup(db_session, ws.id)
    report_suggestions.queue_warmup(db_session, ws.id)
    assert len(db_session.scalars(select(Job).where(Job.kind == "report_templates")).all()) == 1


def test_unticking_a_post_that_is_not_one_of_the_few_read_gives_the_kept_templates_at_once(client, owner, db_session, asked):  # noqa: F811
    headers, ws = owner
    calls, _ = asked
    docs = make_posts(db_session, ws, 30)
    everything = _suggest(client, headers, docs).json()["templates"]
    assert len(calls) == 1
    read = report_suggestions.stable_order(docs)[: report_suggestions.SUGGEST_ITEMS]
    others = [d for d in docs if d not in read]
    for gone in (others[0], others[7], others[-1]):  # the newest, one in the middle, the oldest
        picked = [d for d in docs if d is not gone]
        assert _suggest(client, headers, picked).json()["templates"] == everything
    assert len(calls) == 1  # no new model call: every one of these was a kept set
    # Unticking one of the few that are read is a different input, and is asked for (and kept) once
    _suggest(client, headers, [d for d in docs if d is not read[0]])
    assert len(calls) == 2

"""One-click flows: the "All posts" notebook, whole-archive generation, and jobs that run after a sync."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.config import settings
from app.models import Job, Notebook, Workspace
from tests.test_buildout import auth, connect, docs, feed, llm  # noqa: F401  (fixtures)


def test_archive_notebook_is_created_once_and_listed_first(client, auth, run_jobs, feed):  # noqa: F811
    connect(client, auth, run_jobs)
    client.post("/api/notebooks", json={"title": "Newer"}, headers=auth)
    first = client.post("/api/notebooks/archive", headers=auth).json()
    again = client.post("/api/notebooks/archive", headers=auth).json()
    assert first["id"] == again["id"] and first["title"] == "All posts"

    listed = client.get("/api/notebooks", headers=auth).json()
    assert listed[0]["id"] == first["id"] and listed[0]["is_archive"]
    indexed = [d for d in docs(client, auth) if d["path"]]
    assert listed[0]["document_count"] == len(indexed) > 0

    nb = client.get(f"/api/notebooks/{first['id']}", headers=auth).json()
    assert nb["is_archive"] and len(nb["documents"]) == len(indexed)


def test_a_workspace_cannot_have_two_archive_notebooks(client, auth, db_session):  # noqa: F811
    client.post("/api/notebooks/archive", headers=auth)
    ws = db_session.scalar(select(Workspace))
    db_session.add(Notebook(workspace_id=ws.id, title="All posts", is_archive=True))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()
    db_session.add(Notebook(workspace_id=ws.id, title="Mine"))  # ordinary notebooks are not limited
    db_session.commit()


def test_generate_from_whole_archive_uses_the_archive_notebook(client, auth, run_jobs, feed):  # noqa: F811
    connect(client, auth, run_jobs)
    art = client.post("/api/artifacts/generate", json={"type": "summary", "archive": True}, headers=auth).json()
    archive = client.post("/api/notebooks/archive", headers=auth).json()
    assert art["notebook_id"] == archive["id"]


def test_sync_queues_resurfacing_and_writing_voice_once(client, auth, feed, db_session, session_factory,  # noqa: F811
                                                       monkeypatch):
    from app.services.jobs import claim_next
    from app.worker import run_job

    monkeypatch.setattr(settings, "llm_api_key", "test-key")
    client.post("/api/sources", json={"url": "ada.example.com"}, headers=auth)
    with session_factory() as db:
        job_id = claim_next(db, "test")
    run_job(job_id, session_factory=session_factory)  # the ingest job only; follow-ups stay queued
    db_session.expire_all()
    kinds = [j.kind for j in db_session.scalars(select(Job).where(Job.status == "queued"))]
    assert kinds.count("resurface_scan") == 1
    assert kinds.count("voice_profile") == 1
    assert kinds.count("topics") == 1

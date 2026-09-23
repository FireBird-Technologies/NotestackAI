import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db import Base
from app.models import Job, Workspace
from app.services import jobs as q
from app.worker import HANDED_OFF, Done, recover_stale, run_job


@pytest.fixture()
def factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)


@pytest.fixture()
def ws(factory):
    with factory() as db:
        w = Workspace(name="w", owner_id=uuid.uuid4())
        db.add(w)
        db.commit()
        return w.id


def enqueue(factory, ws, kind="ingest", **kw):
    with factory() as db:
        return q.create_job(db, ws, kind, {"n": 1}, **kw).id


def get(factory, job_id) -> Job:
    with factory() as db:
        return db.get(Job, job_id)


def test_claims_oldest_first_and_only_once(factory, ws):
    a, b = enqueue(factory, ws), enqueue(factory, ws)
    with factory() as db:
        assert q.claim_next(db, "w1") == a
        assert q.claim_next(db, "w1") == b
        assert q.claim_next(db, "w1") is None
    job = get(factory, a)
    assert job.status == "running" and job.attempts == 1 and job.locked_by == "w1"


def test_success_marks_done(factory, ws):
    jid = enqueue(factory, ws)
    with factory() as db:
        q.claim_next(db, "w1")
    run_job(jid, factory, {"ingest": lambda db, job: Done({"indexed": 3}, "All posts in orbit")})
    job = get(factory, jid)
    assert (job.status, job.progress, job.result, job.message) == ("done", 1.0, {"indexed": 3}, "All posts in orbit")


def test_failure_retries_with_backoff_then_fails(factory, ws):
    jid = enqueue(factory, ws, max_attempts=2)

    def boom(db, job):
        raise RuntimeError("feed timed out")

    with factory() as db:
        q.claim_next(db, "w1")
    run_job(jid, factory, {"ingest": boom})
    job = get(factory, jid)
    assert job.status == "queued" and "feed timed out" in job.error and job.message == "Retrying in 30s"
    with factory() as db:
        assert q.claim_next(db, "w1") is None  # backoff not elapsed yet
        db.get(Job, jid).run_after = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
        assert q.claim_next(db, "w1") == jid
    run_job(jid, factory, {"ingest": boom})
    job = get(factory, jid)
    assert job.status == "failed" and job.attempts == 2 and job.finished_at is not None


def test_handed_off_job_stays_running(factory, ws):
    jid = enqueue(factory, ws, kind="render")
    with factory() as db:
        q.claim_next(db, "w1")
    run_job(jid, factory, {"render": lambda db, job: HANDED_OFF})
    assert get(factory, jid).status == "running"


def test_unknown_kind_fails(factory, ws):
    jid = enqueue(factory, ws, kind="mystery")
    with factory() as db:
        q.claim_next(db, "w1")
    run_job(jid, factory, {})
    assert get(factory, jid).status == "failed"


def test_stale_running_job_is_requeued(factory, ws, monkeypatch):
    jid = enqueue(factory, ws)
    with factory() as db:
        q.claim_next(db, "dead-worker")
        db.get(Job, jid).heartbeat_at = datetime.now(UTC) - timedelta(hours=1)
        db.commit()
    assert recover_stale(factory) == 1
    job = get(factory, jid)
    assert job.status == "queued" and job.error == "Worker stopped responding" and job.locked_by is None


def test_progress_updates_count_as_heartbeat(factory, ws):
    jid = enqueue(factory, ws)
    with factory() as db:
        q.claim_next(db, "w1")
        job = db.get(Job, jid)
        job.heartbeat_at = datetime.now(UTC) - timedelta(hours=1)
        db.commit()
        q.update_job(db, job, progress=0.5, message="halfway")
    assert recover_stale(factory) == 0


def test_watch_job_streams_changes_until_done(factory, ws):
    jid = enqueue(factory, ws)

    async def collect():
        seen = []
        async for data in q.watch_job(factory, jid, interval=0.01):
            seen.append(json.loads(data))
            with factory() as db:
                job = db.get(Job, jid)
                if len(seen) == 1:
                    q.update_job(db, job, status="running", progress=0.5, message="halfway")
                elif len(seen) == 2:
                    q.update_job(db, job, status="done", progress=1.0)
        return seen

    seen = asyncio.run(collect())
    assert [s["status"] for s in seen] == ["queued", "running", "done"]
    assert seen[1]["message"] == "halfway"

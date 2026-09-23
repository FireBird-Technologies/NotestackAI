"""Real Postgres checks for the parts SQLite cannot exercise: SKIP LOCKED under concurrency and
advisory locks. Runs when TEST_POSTGRES_URL is set (CI provides one)."""

import os
import threading
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

import app.models  # noqa: F401
from app.db import Base
from app.models import Job, Workspace
from app.services import jobs as q

PG_URL = os.environ.get("TEST_POSTGRES_URL")
pytestmark = pytest.mark.skipif(not PG_URL, reason="TEST_POSTGRES_URL not set")


@pytest.fixture()
def factory():
    engine = create_engine(PG_URL, pool_size=20)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, expire_on_commit=False)
    Base.metadata.drop_all(engine)
    engine.dispose()


def test_parallel_workers_never_claim_the_same_job(factory):
    with factory() as db:
        ws = Workspace(name="w", owner_id=uuid.uuid4())
        db.add(ws)
        db.commit()
        ids = {q.create_job(db, ws.id, "ingest").id for _ in range(60)}

    claimed: list[uuid.UUID] = []
    lock = threading.Lock()

    def worker(name):
        while True:
            with factory() as db:
                jid = q.claim_next(db, name)
            if not jid:
                return
            with lock:
                claimed.append(jid)

    threads = [threading.Thread(target=worker, args=(f"w{i}",)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(claimed) == len(set(claimed)) == len(ids)
    with factory() as db:
        assert db.query(Job).filter(Job.attempts != 1).count() == 0


def test_single_flight_excludes_second_holder(factory, monkeypatch):
    import app.worker as worker

    engine = factory.kw["bind"]
    monkeypatch.setattr(worker, "engine", engine)
    with worker.single_flight("email-batch") as first:
        with worker.single_flight("email-batch") as second:
            assert first is True and second is False
    with worker.single_flight("email-batch") as again:
        assert again is True
    with engine.connect() as c:
        assert c.execute(text("select count(*) from pg_locks where locktype = 'advisory'")).scalar() == 0

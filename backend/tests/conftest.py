import os
import tempfile

os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ["STORAGE_BACKEND"] = "local"
os.environ["LOCAL_STORAGE_DIR"] = tempfile.mkdtemp(prefix="notestack-storage-")
os.environ["CORPUS_CACHE_DIR"] = tempfile.mkdtemp(prefix="notestack-corpus-")
os.environ["RUN_WORKER_IN_API"] = "false"
os.environ["LLM_API_KEY"] = ""
os.environ["ELEVENLABS_API_KEY"] = ""
os.environ.setdefault("EMAIL_PROVIDER", "console")
os.environ.setdefault("JWT_SECRET", "test-secret-that-is-at-least-32-bytes-long")
os.environ.setdefault("BILLING_ENABLED", "false")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

import app.models  # noqa: E402,F401
from app.db import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.services.email import ConsoleEmailProvider  # noqa: E402


@pytest.fixture()
def session_factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)


@pytest.fixture()
def db_session(session_factory):
    session = session_factory()
    yield session
    session.close()


@pytest.fixture()
def run_jobs(session_factory, db_session):
    """Drain the queue the way the worker does, in process. Returns the jobs that ran."""
    from app.models import Job
    from app.services.jobs import claim_next
    from app.worker import run_job

    def drain(limit: int = 50) -> list:
        ran = []
        for _ in range(limit):
            with session_factory() as db:
                job_id = claim_next(db, "test")
            if not job_id:
                break
            run_job(job_id, session_factory=session_factory)
            ran.append(job_id)
        db_session.expire_all()
        return [db_session.get(Job, j) for j in ran]

    return drain


@pytest.fixture()
def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    ConsoleEmailProvider.sent.clear()
    yield TestClient(app)  # no context manager: skips lifespan
    app.dependency_overrides.clear()


def last_code() -> str:
    import re

    return re.search(r"\b(\d{6})\b", ConsoleEmailProvider.sent[-1].text).group(1)

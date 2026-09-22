import os

os.environ.setdefault("DATABASE_URL", "sqlite://")
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
def db_session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    session = Session()
    yield session
    session.close()


@pytest.fixture()
def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    ConsoleEmailProvider.sent.clear()
    yield TestClient(app)  # no context manager: skips lifespan (no Redis needed)
    app.dependency_overrides.clear()


def last_code() -> str:
    import re

    return re.search(r"\b(\d{6})\b", ConsoleEmailProvider.sent[-1].text).group(1)

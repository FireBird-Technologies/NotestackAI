"""The mobile app's interface language reaches AI output (app/llm/languages.py)."""

import uuid

import pytest
from fastapi import APIRouter
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db import Base
from app.llm import languages
from app.models import Job, Workspace
from app.pipeline.research import with_reply_language
from app.services import jobs as q
from app.worker import Done, run_job


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


def make(factory, ws, kind, params):
    with factory() as db:
        return q.create_job(db, ws, kind, params)


@pytest.mark.parametrize("value,code", [("es", "es"), ("es-MX", "es"), ("zh-Hans", "zh"), ("AR", "ar"),
                                        ("en", None), ("xx", None), ("", None), (None, None)])
def test_parse(value, code):
    assert languages.parse(value) == code


def test_no_app_language_leaves_params_alone(factory, ws):
    job = make(factory, ws, "quiz", {"topic": "t"})
    assert job.params == {"topic": "t"}


def test_app_language_becomes_the_default_output_language(factory, ws):
    with languages.use_app_language("fr"):
        job = make(factory, ws, "quiz", {"topic": "t", "language": None})
    assert job.params == {"topic": "t", "language": "French", "app_language": "fr"}


def test_explicit_language_wins(factory, ws):
    with languages.use_app_language("fr"):
        job = make(factory, ws, "slide_deck", {"language": "German"})
    assert job.params["language"] == "German"


def test_kinds_without_a_language_only_carry_the_code(factory, ws):
    with languages.use_app_language("ja"):
        job = make(factory, ws, "ingest", {"source_id": "s"})
    assert job.params == {"source_id": "s", "app_language": "ja"}


def test_worker_restores_the_language_for_the_job(factory, ws):
    with languages.use_app_language("ko"):
        jid = make(factory, ws, "compound_action", {}).id
    seen = {}

    def handler(db, job: Job):
        seen["code"] = languages.app_language()
        return Done()

    run_job(jid, factory, {"compound_action": handler})
    assert seen["code"] == "ko"
    assert languages.app_language() is None


def test_chat_writer_notes_name_the_reply_language():
    assert with_reply_language("tone: plain") == "tone: plain"
    with languages.use_app_language("ur"):
        notes = with_reply_language("tone: plain")
    assert notes.startswith("tone: plain\nReply language: write the answer in Urdu")
    with languages.use_app_language("ur"):
        assert with_reply_language(None).startswith("Reply language:")


def test_header_sets_the_language_for_the_request(client):
    from app.main import app

    router = APIRouter()

    @router.get("/__test/app-language")
    def probe():  # a sync route runs in the threadpool, as most routes here do
        return {"code": languages.app_language()}

    app.include_router(router)
    assert client.get("/__test/app-language", headers={"X-App-Language": "pt-BR"}).json() == {"code": "pt"}
    assert client.get("/__test/app-language").json() == {"code": None}

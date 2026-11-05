"""A chat answer doesn't depend on the phone staying connected: it is researched and saved all the same."""

import asyncio
import time
import uuid

import pytest
from sqlalchemy import select

from app.auth import Ctx
from app.config import settings
from app.models import Message, User, Workspace
from app.pipeline import research as r
from app.routers import notebooks as nbr
from tests.conftest import last_code


@pytest.fixture()
def auth(client):
    client.post("/api/auth/email/register/start", json={"email": "ada@example.com", "password": "stardust-42"})
    r = client.post("/api/auth/email/register/verify", json={"email": "ada@example.com", "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_detached_stream_finishes_after_the_reader_leaves():
    async def scenario():
        finished = []

        async def source():
            yield "first"
            await asyncio.sleep(0.01)
            yield "second"
            finished.append(True)

        reader = nbr._detached(source())
        assert await anext(reader) == "first"
        await reader.aclose()  # the phone is gone
        await asyncio.gather(*nbr._detached_streams)
        return finished

    assert asyncio.run(scenario()) == [True]


def test_detached_stream_keeps_order_and_ends_with_the_source():
    async def scenario():
        async def source():
            for chunk in ("a", "b", "c"):
                yield chunk

        return [chunk async for chunk in nbr._detached(source())]

    assert asyncio.run(scenario()) == ["a", "b", "c"]


def test_silence_sends_a_comment_clients_ignore():
    async def scenario():
        async def source():
            await asyncio.sleep(0.05)
            yield "late"

        return [chunk async for chunk in nbr._detached(source(), keepalive=0.01)]

    chunks = asyncio.run(scenario())
    assert chunks[-1] == "late" and ": keepalive\n\n" in chunks


def test_answer_is_saved_when_the_client_stops_reading(client, auth, db_session, monkeypatch):
    def slow_research(*args, **kwargs):
        time.sleep(0.1)
        return r.ResearchResult("the saved answer", False, [], kind="archive")

    monkeypatch.setattr(nbr, "research", slow_research)
    monkeypatch.setattr(settings, "chat_memory_read", False)
    nb = client.post("/api/notebooks", json={"title": "N"}, headers=auth).json()
    user = db_session.scalars(select(User)).one()
    workspace = db_session.scalars(select(Workspace)).one()
    ctx = Ctx(user=user, workspace=workspace, db=db_session)

    async def scenario():
        response = await nbr.chat(uuid.UUID(nb["id"]), nbr.ChatIn(question="Will this survive?"), ctx)
        reader = response.body_iterator
        first = await anext(reader)
        await reader.aclose()  # before research has finished
        await asyncio.gather(*nbr._detached_streams)
        return first

    assert "chat_id" in asyncio.run(scenario())
    saved = db_session.scalars(select(Message).order_by(Message.created_at)).all()
    assert [(m.role, m.content) for m in saved] == [("user", "Will this survive?"), ("assistant", "the saved answer")]


def test_a_research_failure_says_what_happened(client, auth, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("the provider fell over")

    monkeypatch.setattr(nbr, "research", broken)
    monkeypatch.setattr(settings, "chat_memory_read", False)
    nb = client.post("/api/notebooks", json={"title": "N"}, headers=auth).json()
    body = client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": "Hello there"}, headers=auth).text
    assert "Something went wrong while researching" in body and "Lost signal" not in body

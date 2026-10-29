"""Free's chat allowance: 10 questions in total, counted by usage events so deleting a chat gives none back.
Paid plans (and billing switched off) are unlimited."""

import json
import re

import pytest

from app.config import settings
from app.models import UsageEvent, Workspace
from app.pipeline import research as r
from app.services.billing import apply_subscription
from tests.test_memory import _signup


@pytest.fixture()
def setup(client, monkeypatch):
    from app.routers import notebooks as nbr

    def fake_research(corpus, allowed, question, on_step=None, history=None, notebook_title="", profile="", **kw):
        return r.ResearchResult(f"answer to {question}", False, [], kind="archive", question=question)

    monkeypatch.setattr(nbr, "research", fake_research)
    monkeypatch.setattr(settings, "chat_answer_cache_days", 0)
    auth = _signup(client, "ada@example.com")
    nb = client.post("/api/notebooks", json={"title": "N"}, headers=auth).json()
    return auth, nb


def _ask(client, auth, nb, question):
    return client.post(f"/api/notebooks/{nb['id']}/chat", json={"question": question}, headers=auth)


def _answer(resp) -> dict:
    return json.loads(re.search(r"event: answer\ndata: (.*)", resp.text).group(1))


def test_free_gets_ten_questions_then_a_402(client, db_session, monkeypatch, setup):
    auth, nb = setup
    monkeypatch.setattr(settings, "billing_enabled", True)
    for i in range(1, 11):
        resp = _ask(client, auth, nb, f"question {i}")
        assert resp.status_code == 200
        assert _answer(resp)["quota"] == {"used": i, "limit": 10, "left": 10 - i}
    assert db_session.query(UsageEvent).filter_by(kind="chat").count() == 10

    resp = _ask(client, auth, nb, "one more")
    detail = resp.json()["detail"]
    assert resp.status_code == 402 and detail["code"] == "plan_limit" and detail["kind"] == "chat_messages"
    assert detail["upgrade_to"] == "starter" and "10 free chat messages" in detail["message"]
    assert detail["limit"] == 10

    meter = next(m for m in client.get("/api/billing/status", headers=auth).json()["more_meters"]
                 if m["key"] == "chat_messages")
    assert meter["used"] == 10 and meter["limit"] == 10 and meter["pct"] == 1

    # Deleting every chat never hands questions back.
    for c in client.get(f"/api/notebooks/{nb['id']}/chats", headers=auth).json():
        client.delete(f"/api/notebooks/chats/{c['id']}", headers=auth)
    assert _ask(client, auth, nb, "after deleting").status_code == 402


def test_a_paid_plan_is_unlimited(client, db_session, monkeypatch, setup):
    auth, nb = setup
    monkeypatch.setattr(settings, "billing_enabled", True)
    ws = db_session.query(Workspace).one()
    apply_subscription(db_session, ws.id, plan="writer", status="active")
    db_session.commit()
    for i in range(12):
        resp = _ask(client, auth, nb, f"question {i}")
        assert resp.status_code == 200 and _answer(resp)["quota"] is None


def test_without_billing_chat_is_unlimited(client, setup):
    auth, nb = setup
    for i in range(11):
        assert _ask(client, auth, nb, f"question {i}").status_code == 200

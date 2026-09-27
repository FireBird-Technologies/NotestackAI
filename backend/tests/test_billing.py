"""Upgrade flow: status meters, nudges, checkout guards and the 402 payload behind the out of fuel popup."""

import pytest

from app.config import settings
from app.models import Artifact, Notebook, Workspace
from app.services.billing import apply_subscription
from tests.conftest import last_code


@pytest.fixture()
def auth(client):
    client.post("/api/auth/email/register/start", json={"email": "ada@example.com", "password": "stardust-42"})
    r = client.post("/api/auth/email/register/verify", json={"email": "ada@example.com", "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture()
def billing_on(monkeypatch):
    monkeypatch.setattr(settings, "billing_enabled", True)


def test_status_without_billing_has_no_upgrade_nudges(client, auth):
    body = client.get("/api/billing/status", headers=auth).json()
    assert body["plan"]["id"] == "studio" and body["can_upgrade"] is False
    assert {m["key"] for m in body["meters"]} == {"audio_minutes", "video_minutes", "launch_kits", "sources"}
    assert all(n["tone"] == "action" for n in body["nudges"])
    assert body["nudges"][0]["id"] == "act-source"


def test_free_plan_nudges_and_out_of_fuel_402(client, auth, billing_on, db_session):
    ws = db_session.query(Workspace).one()
    for _ in range(2):
        db_session.add(Artifact(workspace_id=ws.id, type="launch_kit", status="ready"))
    db_session.commit()

    body = client.get("/api/billing/status", headers=auth).json()
    assert body["plan"]["id"] == "free" and body["can_upgrade"] and body["next_plan"] == "writer"
    kits = next(m for m in body["meters"] if m["key"] == "launch_kits")
    assert kits["used"] == 2 and kits["pct"] == 1
    ids = [n["id"] for n in body["nudges"]]
    assert ids[0].startswith("empty-launch_kits") and "perk-voice" in ids
    assert "—" not in str(body)

    nb = Notebook(workspace_id=ws.id, title="Pricing")
    db_session.add(nb)
    db_session.commit()
    r = client.post("/api/artifacts/generate", headers=auth,
                    json={"type": "audio_overview", "notebook_id": str(nb.id), "minutes": 6})
    detail = r.json()["detail"]
    assert r.status_code == 402 and detail["kind"] == "audio_minutes" and detail["upgrade_to"] == "writer"


def test_checkout_guards(client, auth, billing_on, db_session):
    r = client.post("/api/billing/checkout", headers=auth, json={"plan": "writer"})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "stripe_not_configured"  # no STRIPE_SECRET_KEY
    assert client.post("/api/billing/checkout", headers=auth, json={"plan": "free"}).status_code == 422
    ws = db_session.query(Workspace).one()
    apply_subscription(db_session, ws.id, plan="studio", status="active", customer_id="cus_1")
    r = client.post("/api/billing/checkout", headers=auth, json={"plan": "writer", "cycle": "annual"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_on_plan"
    body = client.get("/api/billing/status", headers=auth).json()
    assert body["plan"]["id"] == "studio" and body["has_billing_account"] and not body["can_upgrade"]


def test_checkout_disabled_without_billing(client, auth):
    r = client.post("/api/billing/checkout", headers=auth, json={"plan": "writer"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "billing_disabled"


def test_plan_limit_error_names_the_upgrade():
    from app.services.plans import PLANS, plan_limit_error, upgrade_for

    assert upgrade_for(PLANS["free"], "voice_cloning") == "writer"
    assert upgrade_for(PLANS["writer"], "launch_kits") == "studio"
    assert upgrade_for(PLANS["studio"], "audio_minutes") is None
    detail = plan_limit_error(PLANS["free"], "audio_minutes", "x").detail
    assert detail["code"] == "plan_limit" and detail["upgrade_to"] == "writer" and detail["kind"] == "audio_minutes"

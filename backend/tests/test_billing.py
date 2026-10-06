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
    assert {m["key"] for m in body["meters"]} == {"audio_minutes", "videos", "launch_kits", "sources"}
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


@pytest.fixture()
def plans_table(monkeypatch):
    """Point the plan catalog at its own database, seeded like migration 0006. (Not the client's: that one
    shares a single connection, and the catalog's own session would roll back the request's work.)"""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    import app.db
    from app.db import Base
    from app.models import PlanRecord
    from app.services.plans import DEFAULT_PLANS, PLANS

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(app.db, "SessionLocal", session_factory)
    with session_factory() as db:
        for i, p in enumerate(DEFAULT_PLANS.values()):
            db.add(PlanRecord(id=p.id, sort_order=i, name=p.name, tagline=p.tagline,
                              price_monthly_usd=p.price_monthly_usd, sources=p.sources, indexed_posts=p.indexed_posts,
                              audio_minutes=p.audio_minutes, videos=p.videos, launch_kits=p.launch_kits,
                              voice_cloning=p.voice_cloning, brand_kit=p.brand_kit, features=list(p.features)))
        db.commit()
    PLANS.reload()
    yield session_factory
    PLANS.reload()


def test_plans_come_from_the_table(plans_table):
    from app.models import PlanRecord
    from app.services.plans import PLANS, next_plan

    with plans_table() as db:
        db.get(PlanRecord, "studio").videos = 50
        db.get(PlanRecord, "writer").features = ["Edited copy"]
        db.commit()
    PLANS.reload()
    assert PLANS["studio"].videos == 50 and PLANS["writer"].features == ("Edited copy",)
    assert list(PLANS) == ["free", "writer", "studio"] and next_plan(PLANS["free"]).id == "writer"


def test_edited_limit_reaches_video_quota(plans_table, client, auth, db_session):
    from app.models import PlanRecord, Workspace
    from app.services.plans import PLANS
    from app.services.video_quota import sync_video_quota

    with plans_table() as db:
        db.get(PlanRecord, "studio").videos = 42  # billing disabled: everyone is on Studio
        db.commit()
    PLANS.reload()
    ws = db_session.query(Workspace).one()
    assert sync_video_quota(db_session, ws).video_limit == 42


def test_empty_or_broken_table_falls_back_to_defaults(plans_table):
    from app.models import PlanRecord
    from app.services.plans import DEFAULT_PLANS, PLANS

    with plans_table() as db:
        db.query(PlanRecord).filter(PlanRecord.id == "free").delete()  # no free plan: unusable
        db.commit()
    PLANS.reload()
    assert PLANS["free"] == DEFAULT_PLANS["free"] and PLANS["studio"].videos == DEFAULT_PLANS["studio"].videos

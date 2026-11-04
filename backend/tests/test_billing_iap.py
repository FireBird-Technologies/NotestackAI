"""In-app subscriptions through RevenueCat: the app's sync, the webhook, and one plan per workspace."""

from datetime import UTC, datetime, timedelta

import pytest

from app.config import settings
from app.models import Subscription, Workspace
from app.services import revenuecat
from app.services.billing import apply_subscription
from tests.conftest import last_code

AUTH = "Bearer rc-secret"


@pytest.fixture()
def auth(client):
    client.post("/api/auth/email/register/start", json={"email": "ada@example.com", "password": "stardust-42"})
    r = client.post("/api/auth/email/register/verify", json={"email": "ada@example.com", "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture()
def iap_on(monkeypatch):
    monkeypatch.setattr(settings, "billing_enabled", True)
    monkeypatch.setattr(settings, "revenuecat_secret_key", "sk_test")
    monkeypatch.setattr(settings, "revenuecat_webhook_auth", "rc-secret")


@pytest.fixture()
def store(monkeypatch):
    """What RevenueCat says about the customer: set `store.customer` in a test."""

    class Store:
        customer: dict = {}
        calls: list[str] = []

    def fetch(app_user_id):
        Store.calls.append(app_user_id)
        return Store.customer

    Store.calls = []
    monkeypatch.setattr(revenuecat, "fetch_customer", fetch)
    return Store


def _iso(delta: timedelta) -> str:
    return (datetime.now(UTC) + delta).isoformat().replace("+00:00", "Z")


def customer(plan: str, *, expires: timedelta = timedelta(days=30), store: str = "app_store", issue: bool = False):
    product = f"notestack_{plan}_monthly"
    return {
        "entitlements": {plan: {"product_identifier": product, "expires_date": _iso(expires)}},
        "subscriptions": {product: {"store": store, "expires_date": _iso(expires), "store_transaction_id": "tx-1",
                                    "billing_issues_detected_at": _iso(-timedelta(hours=1)) if issue else None}},
    }


def event(db_session, kind: str, event_id: str = "e1") -> dict:
    ws = db_session.query(Workspace).one()
    return {"event": {"id": event_id, "type": kind, "app_user_id": str(ws.id), "store": "APP_STORE"}}


def test_purchase_sync_sets_the_plan_and_upgrade_moves_it(client, auth, iap_on, store, db_session):
    store.customer = customer("writer")
    body = client.post("/api/billing/iap/sync", headers=auth).json()
    assert body["plan"]["id"] == "writer" and body["billed_by"] == "app_store"

    store.customer = {**customer("studio"), "entitlements": {**customer("writer")["entitlements"],
                                                              **customer("studio")["entitlements"]}}
    body = client.post("/api/billing/iap/sync", headers=auth).json()
    assert body["plan"]["id"] == "studio"


def test_expiry_drops_to_free_and_grace_keeps_the_plan(client, auth, iap_on, store, db_session):
    store.customer = customer("writer", issue=True)
    body = client.post("/api/billing/iap/sync", headers=auth).json()
    assert body["plan"]["id"] == "writer"
    assert db_session.query(Subscription).one().status == "past_due"

    store.customer = customer("writer", expires=-timedelta(minutes=5))
    r = client.post("/api/billing/revenuecat/webhook", headers={"Authorization": AUTH}, json=event(db_session, "EXPIRATION"))
    assert r.json()["result"] == "synced"
    assert client.get("/api/billing/status", headers=auth).json()["plan"]["id"] == "free"


def test_webhook_auth_duplicates_and_renewal_reset(client, auth, iap_on, store, db_session):
    store.customer = customer("writer")
    assert client.post("/api/billing/revenuecat/webhook", headers={"Authorization": "Bearer nope"},
                       json=event(db_session, "RENEWAL")).status_code == 401

    sub_before = client.post("/api/billing/iap/sync", headers=auth)
    assert sub_before.status_code == 200
    row = db_session.query(Subscription).one()
    row.videos_used = 3
    db_session.commit()

    client.post("/api/billing/revenuecat/webhook", headers={"Authorization": AUTH}, json=event(db_session, "RENEWAL"))
    db_session.refresh(row)
    assert row.videos_used == 0

    row.videos_used = 2  # made since; a retried delivery of the same renewal must not wipe them
    db_session.commit()
    client.post("/api/billing/revenuecat/webhook", headers={"Authorization": AUTH}, json=event(db_session, "RENEWAL"))
    db_session.refresh(row)
    assert row.videos_used == 2


def test_unknown_customer_and_test_event(client, iap_on, store):
    headers = {"Authorization": AUTH}
    assert client.post("/api/billing/revenuecat/webhook", headers=headers,
                       json={"event": {"id": "t", "type": "TEST"}}).json()["result"] == "test"
    assert client.post("/api/billing/revenuecat/webhook", headers=headers,
                       json={"event": {"id": "x", "type": "RENEWAL", "app_user_id": "$RCAnonymousID:abc"}}
                       ).json()["result"] == "unknown"


def test_one_plan_per_workspace(client, auth, iap_on, store, db_session):
    ws = db_session.query(Workspace).one()
    # Paid on the web: a store purchase does not replace it.
    apply_subscription(db_session, ws.id, plan="studio", status="active", provider="stripe", customer_id="cus_1")
    store.customer = customer("writer")
    body = client.post("/api/billing/iap/sync", headers=auth).json()
    assert body["plan"]["id"] == "studio" and body["billed_by"] == "stripe"

    # Paid in the app: the web's checkout and portal say where to manage it.
    apply_subscription(db_session, ws.id, plan="free", status="canceled", provider="stripe")
    client.post("/api/billing/iap/sync", headers=auth)
    for path, json in (("/api/billing/checkout", {"plan": "studio"}), ("/api/billing/portal", None)):
        r = client.post(path, headers=auth, json=json)
        assert r.status_code == 409 and r.json()["detail"]["code"] == "billed_by_store"
        assert "App Store" in r.json()["detail"]["message"]


def test_stripe_webhook_does_not_undo_a_store_plan(client, auth, iap_on, store, db_session):
    from app.services import stripe_billing

    store.customer = customer("writer")
    client.post("/api/billing/iap/sync", headers=auth)
    ws = db_session.query(Workspace).one()
    stripe_billing.sync_subscription(db_session, ws.id, {"id": "sub_1", "status": "canceled", "customer": "cus_9",
                                                         "items": {"data": []}})
    row = db_session.query(Subscription).one()
    assert row.provider == "app_store" and row.plan == "writer"


def test_delete_account_ends_the_plan(client, auth, iap_on, store, db_session, monkeypatch):
    from app.services import stripe_billing

    monkeypatch.setattr(settings, "stripe_secret_key", "sk_stripe")
    cancelled: list[str] = []
    monkeypatch.setattr(stripe_billing, "cancel_now", lambda sub_id: cancelled.append(sub_id) or True)
    ws = db_session.query(Workspace).one()
    apply_subscription(db_session, ws.id, plan="studio", status="active", provider="stripe", customer_id="cus_1",
                       subscription_id="sub_1")

    assert client.post("/api/auth/delete-account", headers=auth).json() == {"ok": True}
    row = db_session.query(Subscription).one()
    db_session.refresh(row)
    assert cancelled == ["sub_1"] and (row.plan, row.status) == ("free", "canceled")


def test_deleted_account_cancels_play_and_ignores_later_renewals(client, auth, iap_on, store, db_session, monkeypatch):
    plays: list[str] = []
    monkeypatch.setattr(revenuecat, "cancel_play", lambda app_user_id: plays.append(app_user_id) or True)
    store.customer = customer("writer", store="play_store")
    client.post("/api/billing/iap/sync", headers=auth)
    ws = db_session.query(Workspace).one()

    client.post("/api/auth/delete-account", headers=auth)
    assert plays == [str(ws.id)]
    # The store still says Writer (an App Store plan we can't cancel, or a renewal racing the cancel): no revival.
    r = client.post("/api/billing/revenuecat/webhook", headers={"Authorization": AUTH}, json=event(db_session, "RENEWAL"))
    assert r.json()["result"] == "synced"
    row = db_session.query(Subscription).one()
    db_session.refresh(row)
    assert (row.plan, row.status) == ("free", "canceled")


def test_test_store_counts_only_when_allowed(client, auth, iap_on, store, monkeypatch):
    monkeypatch.setattr(settings, "revenuecat_allow_test_store", False)  # whatever the local .env says
    store.customer = customer("writer", store="test_store")
    assert client.post("/api/billing/iap/sync", headers=auth).json()["plan"]["id"] == "free"

    monkeypatch.setattr(settings, "revenuecat_allow_test_store", True)
    store.customer["entitlements"] = {"Writer": store.customer["entitlements"]["writer"]}  # the dashboard's casing
    body = client.post("/api/billing/iap/sync", headers=auth).json()
    assert body["plan"]["id"] == "writer" and body["billed_by"] == "test_store"

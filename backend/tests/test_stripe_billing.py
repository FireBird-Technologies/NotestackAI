"""Stripe webhooks and checkout with a fake Stripe: signatures, retries, out of order events, 3DS, grace."""

import hashlib
import hmac
import json
import time
import uuid

import pytest
from sqlalchemy import select

from app.config import settings
from app.models import Subscription, Workspace
from app.services import stripe_billing
from app.services.email import ConsoleEmailProvider
from app.services.plans import effective_plan
from tests.conftest import last_code

SECRET = "whsec_test_secret"


class FakeStripe:
    """Just enough of StripeClient.v1 for the billing flows."""

    def __init__(self):
        self.subs: dict[str, dict] = {}
        self.calls: list[tuple] = []
        self.pending = False  # next plan change needs 3DS
        outer = self

        class Subs:
            def retrieve(self, sid, params=None):
                return outer.subs[sid]

            def update(self, sid, params):
                outer.calls.append(("update", sid, params))
                sub = outer.subs[sid]
                invoice = {"status": "open" if outer.pending else "paid",
                           "hosted_invoice_url": "https://invoice.stripe.test/i_1"}
                if outer.pending:
                    return {**sub, "pending_update": {"subscription_items": params["items"]}, "latest_invoice": invoice}
                sub["items"]["data"][0]["price"] = {"id": params["items"][0]["price"],
                                                    "lookup_key": "notestack_studio_monthly"}
                return {**sub, "pending_update": None, "latest_invoice": invoice}

        class Prices:
            def list(self, params):
                return type("L", (), {"data": [type("P", (), {"id": f"price_{params['lookup_keys'][0]}"})()]})()

        class Customers:
            def create(self, params, options=None):
                outer.calls.append(("customer", params))
                return type("C", (), {"id": "cus_1"})()

        class Sessions:
            def create(self, params):
                outer.calls.append(("checkout", params))
                return type("S", (), {"url": "https://checkout.stripe.test/s_1"})()

            def retrieve(self, sid, params=None):
                return outer.session

        class V1:
            subscriptions = Subs()
            prices = Prices()
            customers = Customers()
            checkout = type("Checkout", (), {"sessions": Sessions()})()

        self.v1 = V1()
        self.session: dict = {}

    def add_sub(self, sid, workspace_id, plan="writer", status="active", period_end=None):
        self.subs[sid] = {
            "id": sid, "customer": "cus_1", "status": status,
            "metadata": {"workspace_id": str(workspace_id), "plan": plan},
            "items": {"data": [{
                "id": "si_1",
                "price": {"id": f"price_{plan}", "lookup_key": f"notestack_{plan}_monthly"},
                "current_period_end": period_end or int(time.time()) + 30 * 86400,
            }]},
        }


@pytest.fixture()
def stripe_on(monkeypatch):
    fake = FakeStripe()
    monkeypatch.setattr(settings, "billing_enabled", True)
    monkeypatch.setattr(settings, "stripe_secret_key", "sk_test_x")
    monkeypatch.setattr(settings, "stripe_webhook_secret", SECRET)
    monkeypatch.setattr(stripe_billing, "client", lambda: fake)
    return fake


@pytest.fixture()
def owner(client, db_session):
    client.post("/api/auth/email/register/start", json={"email": "grace@example.com", "password": "stardust-42",
                                                        "name": "Grace Hopper"})
    r = client.post("/api/auth/email/register/verify", json={"email": "grace@example.com", "code": last_code()})
    ws = db_session.scalar(select(Workspace))
    return {"Authorization": f"Bearer {r.json()['access_token']}"}, ws


def send(client, event: dict, secret: str = SECRET):
    payload = json.dumps(event)
    t = int(time.time())
    sig = hmac.new(secret.encode(), f"{t}.{payload}".encode(), hashlib.sha256).hexdigest()
    return client.post("/api/billing/webhook", content=payload,
                       headers={"stripe-signature": f"t={t},v1={sig}", "content-type": "application/json"})


def event(kind: str, obj: dict) -> dict:
    return {"id": f"evt_{uuid.uuid4().hex}", "object": "event", "type": kind, "data": {"object": obj}}


def plan_of(db, ws) -> str:
    db.expire_all()
    return effective_plan(db, ws).id


def test_webhook_rejects_bad_signature(client, stripe_on, owner):
    r = send(client, event("customer.subscription.updated", {"id": "sub_x"}), secret="whsec_wrong")
    assert r.status_code == 400


def test_checkout_completed_then_retry_and_out_of_order(client, stripe_on, owner, db_session):
    _, ws = owner
    stripe_on.add_sub("sub_1", ws.id, plan="writer")
    done = event("checkout.session.completed", {"mode": "subscription", "subscription": "sub_1",
                                                "client_reference_id": str(ws.id)})
    assert send(client, done).json()["result"] == "synced"
    assert plan_of(db_session, ws) == "writer"
    # Stripe retries the same delivery: still fine, nothing doubles.
    assert send(client, done).status_code == 200
    assert db_session.scalar(select(Subscription).where(Subscription.workspace_id == ws.id)).plan == "writer"
    # An older "incomplete" payload arrives late: we re-read Stripe, which says active.
    stale = {**stripe_on.subs["sub_1"], "status": "incomplete"}
    send(client, event("customer.subscription.updated", stale))
    assert plan_of(db_session, ws) == "writer"


def test_past_due_keeps_plan_and_emails_once_then_cancel_drops_to_free(client, stripe_on, owner, db_session):
    _, ws = owner
    stripe_on.add_sub("sub_2", ws.id, plan="studio")
    send(client, event("customer.subscription.created", stripe_on.subs["sub_2"]))
    stripe_on.subs["sub_2"]["status"] = "past_due"
    ConsoleEmailProvider.sent.clear()
    failed = event("invoice.payment_failed", {
        "subscription": "sub_2", "customer": "cus_1", "customer_email": "grace@example.com",
        "billing_reason": "subscription_cycle", "hosted_invoice_url": "https://invoice.stripe.test/i_2"})
    send(client, failed)
    send(client, failed)  # retried delivery
    assert plan_of(db_session, ws) == "studio"  # grace while Stripe retries
    assert len([m for m in ConsoleEmailProvider.sent if "payment failed" in m.subject.lower()]) == 1
    stripe_on.subs["sub_2"]["status"] = "canceled"
    send(client, event("customer.subscription.deleted", stripe_on.subs["sub_2"]))
    assert plan_of(db_session, ws) == "free"


def test_renewal_needing_3ds_emails_confirm_link(client, stripe_on, owner, db_session):
    _, ws = owner
    stripe_on.add_sub("sub_3", ws.id)
    ConsoleEmailProvider.sent.clear()
    send(client, event("invoice.payment_action_required", {
        "subscription": "sub_3", "customer": "cus_1", "customer_email": "grace@example.com",
        "billing_reason": "subscription_cycle", "hosted_invoice_url": "https://invoice.stripe.test/i_3"}))
    mail = [m for m in ConsoleEmailProvider.sent if "confirm" in m.subject.lower()]
    assert len(mail) == 1 and "https://invoice.stripe.test/i_3" in mail[0].text
    assert plan_of(db_session, ws) == "writer"


def test_checkout_creates_one_customer_and_confirm_applies_plan(client, stripe_on, owner, db_session):
    headers, ws = owner
    r = client.post("/api/billing/checkout", json={"plan": "writer", "cycle": "annual"}, headers=headers)
    assert r.json()["url"] == "https://checkout.stripe.test/s_1"
    kinds = [c[0] for c in stripe_on.calls]
    assert kinds == ["customer", "checkout"]
    session = stripe_on.calls[1][1]
    assert session["customer"] == "cus_1" and session["client_reference_id"] == str(ws.id)
    assert "{CHECKOUT_SESSION_ID}" in session["success_url"]
    assert session["line_items"][0]["price"] == "price_notestack_writer_annual"
    # Back on the success page before any webhook: confirm applies the plan.
    stripe_on.add_sub("sub_4", ws.id, plan="writer")
    stripe_on.session = {"client_reference_id": str(ws.id), "status": "complete",
                         "subscription": stripe_on.subs["sub_4"]}
    r = client.post("/api/billing/confirm", json={"session_id": "cs_1"}, headers=headers)
    assert r.json()["plan"]["id"] == "writer"
    # A second checkout while subscribed changes the plan in place instead of a second subscription.
    r = client.post("/api/billing/checkout", json={"plan": "studio", "cycle": "monthly"}, headers=headers)
    assert r.json()["url"].endswith("/app?checkout=success")
    assert [c[0] for c in stripe_on.calls].count("customer") == 1
    assert plan_of(db_session, ws) == "studio"


def test_upgrade_needing_3ds_sends_user_to_invoice(client, stripe_on, owner, db_session):
    headers, ws = owner
    stripe_on.add_sub("sub_5", ws.id, plan="writer")
    send(client, event("customer.subscription.created", stripe_on.subs["sub_5"]))
    stripe_on.pending = True
    r = client.post("/api/billing/checkout", json={"plan": "studio", "cycle": "monthly"}, headers=headers)
    assert r.json()["url"] == "https://invoice.stripe.test/i_1"
    assert plan_of(db_session, ws) == "writer"  # switches only once the payment succeeds


def videos_used(db, ws) -> int:
    db.expire_all()
    return db.scalar(select(Subscription).where(Subscription.workspace_id == ws.id)).videos_used


def set_videos_used(db, ws, n: int) -> None:
    db.scalar(select(Subscription).where(Subscription.workspace_id == ws.id)).videos_used = n
    db.commit()


@pytest.mark.parametrize("reason,resets", [("subscription_cycle", True), ("subscription_create", True),
                                           ("subscription_update", False)])
def test_invoice_paid_resets_videos(client, stripe_on, owner, db_session, reason, resets):
    _, ws = owner
    stripe_on.add_sub("sub_v", ws.id, plan="writer")
    set_videos_used(db_session, ws, 7)
    paid = event("invoice.paid", {"subscription": "sub_v", "customer": "cus_1", "billing_reason": reason})
    send(client, paid)
    assert videos_used(db_session, ws) == (0 if resets else 7)
    # A retried delivery of the same event must not wipe videos made since.
    set_videos_used(db_session, ws, 3)
    send(client, paid)
    assert videos_used(db_session, ws) == 3


def test_subscription_sync_sets_video_limit(client, stripe_on, owner, db_session):
    _, ws = owner
    stripe_on.add_sub("sub_l", ws.id, plan="studio")
    send(client, event("customer.subscription.created", stripe_on.subs["sub_l"]))
    db_session.expire_all()
    sub = db_session.scalar(select(Subscription).where(Subscription.workspace_id == ws.id))
    assert (sub.video_plan, sub.video_limit) == ("studio", 20)

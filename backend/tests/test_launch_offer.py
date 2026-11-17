"""The launch offer (LAUNCH_DISCOUNT_CODE): read from a Stripe promotion code, shown while it is active (however many
times it was redeemed), applied at checkout, and gone when disabled in Stripe, expired or unset."""

import time

import pytest
import stripe

from app.config import settings
from app.services import stripe_billing
from tests.test_stripe_billing import FakeStripe, owner, stripe_on  # noqa: F401 (fixtures)


@pytest.fixture()
def offer(monkeypatch, stripe_on):  # noqa: F811
    """A 50% promotion code LAUNCH50; tests change `promo` and `coupon` in place."""
    state = {
        "promo": {"id": "promo_1", "code": "LAUNCH50", "active": True, "max_redemptions": None, "times_redeemed": 0,
                  "expires_at": None, "promotion": {"type": "coupon", "coupon": "co_1"}},
        "coupon": {"id": "co_1", "percent_off": 50.0, "valid": True},
        "refuse": False,
    }

    class Promos:
        def list(self, params):
            found = [state["promo"]] if params["code"] == state["promo"]["code"] and state["promo"]["active"] else []
            return type("L", (), {"data": found})()

    class Coupons:
        def retrieve(self, cid):
            return state["coupon"]

    stripe_on.v1.promotion_codes = Promos()
    stripe_on.v1.coupons = Coupons()
    sessions = stripe_on.v1.checkout.sessions
    create = sessions.create

    def create_or_refuse(params):
        if state["refuse"] and params.get("discounts"):
            raise stripe.InvalidRequestError("This promotion code cannot be redeemed.", "discounts")
        return create(params)

    monkeypatch.setattr(sessions, "create", create_or_refuse)
    monkeypatch.setattr(settings, "launch_discount_code", "LAUNCH50")
    stripe_billing.clear_offer_cache()
    yield state
    stripe_billing.clear_offer_cache()


def test_offer_shown_on_plans_and_status(client, offer, owner):  # noqa: F811
    headers, _ = owner
    assert client.get("/api/billing/plans").json()["offer"] == {"percent_off": 50}
    assert client.get("/api/billing/status", headers=headers).json()["offer"] == {"percent_off": 50}


def test_redemptions_are_not_counted(client, offer):
    offer["promo"]["times_redeemed"] = 25
    assert client.get("/api/billing/plans").json()["offer"] == {"percent_off": 50}


def test_no_offer_without_code_or_when_disabled_or_expired(client, offer, monkeypatch):
    offer["promo"]["active"] = False  # disabled in Stripe
    stripe_billing.clear_offer_cache()
    assert client.get("/api/billing/plans").json()["offer"] is None

    offer["promo"]["active"] = True
    offer["promo"]["expires_at"] = int(time.time()) - 60
    stripe_billing.clear_offer_cache()
    assert client.get("/api/billing/plans").json()["offer"] is None

    offer["promo"]["expires_at"] = None
    offer["coupon"]["valid"] = False
    stripe_billing.clear_offer_cache()
    assert client.get("/api/billing/plans").json()["offer"] is None

    offer["coupon"]["valid"] = True
    monkeypatch.setattr(settings, "launch_discount_code", "")
    stripe_billing.clear_offer_cache()
    assert client.get("/api/billing/plans").json()["offer"] is None


def test_offer_is_cached(client, offer):
    assert client.get("/api/billing/plans").json()["offer"] is not None
    offer["promo"]["active"] = False
    assert client.get("/api/billing/plans").json()["offer"] is not None  # cached
    stripe_billing.clear_offer_cache()  # what the cache expiring does
    assert client.get("/api/billing/plans").json()["offer"] is None


def test_checkout_applies_the_code_instead_of_the_code_box(client, offer, owner, stripe_on):  # noqa: F811
    headers, _ = owner
    r = client.post("/api/billing/checkout", json={"plan": "writer", "cycle": "monthly"}, headers=headers)
    assert r.status_code == 200
    session = [c for c in stripe_on.calls if c[0] == "checkout"][-1][1]
    assert session["discounts"] == [{"promotion_code": "promo_1"}]
    assert "allow_promotion_codes" not in session


def test_checkout_without_offer_keeps_the_code_box(client, offer, owner, stripe_on, monkeypatch):  # noqa: F811
    headers, _ = owner
    monkeypatch.setattr(settings, "launch_discount_code", "")
    stripe_billing.clear_offer_cache()
    client.post("/api/billing/checkout", json={"plan": "writer", "cycle": "monthly"}, headers=headers)
    session = [c for c in stripe_on.calls if c[0] == "checkout"][-1][1]
    assert session["allow_promotion_codes"] is True and "discounts" not in session


def test_offer_disabled_between_load_and_click(client, offer, owner):  # noqa: F811
    headers, _ = owner
    assert client.get("/api/billing/plans").json()["offer"] is not None
    offer["refuse"] = True  # Stripe refuses: the code was disabled meanwhile
    offer["promo"]["active"] = False
    r = client.post("/api/billing/checkout", json={"plan": "studio", "cycle": "annual"}, headers=headers)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "offer_ended"
    assert client.get("/api/billing/plans").json()["offer"] is None

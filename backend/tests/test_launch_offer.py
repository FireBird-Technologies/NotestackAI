"""The launch offer (LAUNCH_DISCOUNT_CODE): read from a Stripe promotion code, shown while it has redemptions left,
applied at checkout, and gone when used up or unset."""

import time

import pytest
import stripe

from app.config import settings
from app.services import stripe_billing
from tests.test_stripe_billing import FakeStripe, owner, stripe_on  # noqa: F401 (fixtures)


@pytest.fixture()
def offer(monkeypatch, stripe_on):  # noqa: F811
    """A 50% promotion code LAUNCH50 limited to 10 redemptions; tests change `promo` and `coupon` in place."""
    state = {
        "promo": {"id": "promo_1", "code": "LAUNCH50", "active": True, "max_redemptions": 10, "times_redeemed": 0,
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


def test_no_offer_without_code_or_when_used_up_or_expired(client, offer, monkeypatch):
    offer["promo"]["times_redeemed"] = 10  # every slot taken
    stripe_billing.clear_offer_cache()
    assert client.get("/api/billing/plans").json()["offer"] is None

    offer["promo"]["times_redeemed"] = 3
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


def test_offer_is_cached_until_a_checkout_completes(client, offer):
    assert client.get("/api/billing/plans").json()["offer"] is not None
    offer["promo"]["times_redeemed"] = 10
    assert client.get("/api/billing/plans").json()["offer"] is not None  # cached
    stripe_billing.clear_offer_cache()  # what a finished checkout does
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


def test_last_slot_taken_between_load_and_click(client, offer, owner):  # noqa: F811
    headers, _ = owner
    assert client.get("/api/billing/plans").json()["offer"] is not None
    offer["refuse"] = True  # Stripe refuses: someone else used the last redemption
    offer["promo"]["times_redeemed"] = 10
    r = client.post("/api/billing/checkout", json={"plan": "studio", "cycle": "annual"}, headers=headers)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "offer_ended"
    assert client.get("/api/billing/plans").json()["offer"] is None

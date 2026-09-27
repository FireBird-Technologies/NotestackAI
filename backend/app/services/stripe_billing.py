"""Stripe: hosted Checkout, the customer portal, plan changes and webhooks.

Hard parts handled here:
- 3D Secure / SCA. Checkout runs 3DS on the first payment. Renewals that need it arrive as
  invoice.payment_action_required: the plan stays active and the owner gets the hosted invoice link to
  confirm. Upgrades use payment_behavior=pending_if_incomplete, so the new plan applies only after the
  payment succeeds; if the bank wants 3DS the user is sent to the invoice page to confirm.
- Failed payments. past_due keeps the plan (Stripe retries per the dashboard's dunning settings) and the
  owner is emailed a link to fix the card; unpaid, canceled or incomplete_expired drop to Free.
- Webhooks. Signatures are verified against the raw body. Every handler re-reads the subscription from
  Stripe instead of trusting the event payload, so retries and out of order deliveries converge on the
  true state. Side effects (emails, alerts) run once per event id (billing_events table).
- Duplicates. One Stripe customer per workspace, created before checkout and reused; a workspace that
  already has a live subscription changes plan in place instead of opening a second subscription.
- Redirect before webhook. The success URL carries the Checkout Session id and the app confirms it
  directly (confirm_checkout), so the plan shows up even if the webhook is late.
- Prices. Found by lookup key notestack_<plan>_<cycle>, created from services/plans.py when missing
  (so test and live mode both work without dashboard setup), or pinned with STRIPE_PRICE_* env vars.
"""

import logging
import uuid
from datetime import UTC, datetime

import stripe
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.models import BillingEvent, Subscription, User, Workspace
from app.services.plans import PLANS, Plan, annual_prices

log = logging.getLogger(__name__)

LIVE = {"active", "trialing", "past_due"}  # statuses that keep the paid plan (past_due = grace while retrying)
_prices: dict[str, str] = {}


def client() -> stripe.StripeClient:
    if not settings.stripe_secret_key:
        raise HTTPException(503, {"code": "stripe_not_configured", "message": "Payments are not configured yet."})
    return stripe.StripeClient(settings.stripe_secret_key, max_network_retries=2)


def _get(obj, key, default=None):
    """Read a field from a StripeObject or a plain dict."""
    try:
        value = obj[key]
    except (KeyError, TypeError, AttributeError):
        return default
    return default if value is None else value


def _ts(value) -> datetime | None:
    return datetime.fromtimestamp(int(value), UTC) if value else None


# Prices


def lookup_key(plan_id: str, cycle: str) -> str:
    return f"notestack_{plan_id}_{cycle}"


def price_id(sc: stripe.StripeClient, plan: Plan, cycle: str) -> str:
    pinned = getattr(settings, f"stripe_price_{plan.id}_{cycle}", "")
    if pinned:
        return pinned
    key = lookup_key(plan.id, cycle)
    if key in _prices:
        return _prices[key]
    found = sc.v1.prices.list({"lookup_keys": [key], "active": True, "limit": 1}).data
    if found:
        _prices[key] = found[0].id
        return found[0].id
    product_id = f"notestack_{plan.id}"
    try:
        sc.v1.products.retrieve(product_id)
    except stripe.InvalidRequestError:
        sc.v1.products.create({"id": product_id, "name": f"Notestack {plan.name}", "metadata": {"plan": plan.id}})
    amount = plan.price_monthly_usd if cycle == "monthly" else annual_prices(plan)[1]
    price = sc.v1.prices.create({
        "product": product_id,
        "currency": "usd",
        "unit_amount": round(amount * 100),
        "recurring": {"interval": "month" if cycle == "monthly" else "year"},
        "lookup_key": key,
        "transfer_lookup_key": True,
        "metadata": {"plan": plan.id, "cycle": cycle},
    })
    _prices[key] = price.id
    return price.id


def plan_for_price(price) -> str | None:
    """Plan id for a Stripe Price: pinned env ids, then lookup key, then metadata."""
    pid = _get(price, "id")
    for plan_id in ("writer", "studio"):
        for cycle in ("monthly", "annual"):
            if pid and getattr(settings, f"stripe_price_{plan_id}_{cycle}", "") == pid:
                return plan_id
    key = _get(price, "lookup_key") or ""
    if key.startswith("notestack_"):
        plan_id = key.split("_")[1]
        if plan_id in PLANS:
            return plan_id
    plan_id = _get(_get(price, "metadata", {}), "plan")
    return plan_id if plan_id in PLANS else None


# Customers and subscriptions


def _subscription_row(db: Session, workspace_id: uuid.UUID) -> Subscription:
    sub = db.scalar(select(Subscription).where(Subscription.workspace_id == workspace_id))
    if not sub:
        sub = Subscription(workspace_id=workspace_id, plan="free", status="active")
        db.add(sub)
        db.flush()
    return sub


def ensure_customer(sc: stripe.StripeClient, db: Session, user: User, workspace: Workspace) -> str:
    sub = _subscription_row(db, workspace.id)
    if sub.provider_customer_id:
        return sub.provider_customer_id
    customer = sc.v1.customers.create(
        {"email": user.email, "name": user.name or None, "metadata": {"workspace_id": str(workspace.id)}},
        {"idempotency_key": f"customer-{workspace.id}"},
    )
    sub.provider, sub.provider_customer_id = "stripe", customer.id
    db.commit()
    return customer.id


def sync_subscription(db: Session, workspace_id: uuid.UUID, stripe_sub) -> Subscription:
    """Store the subscription's true state. Safe to call any number of times, in any order."""
    items = _get(_get(stripe_sub, "items", {}), "data", [])
    first = items[0] if items else {}
    status = _get(stripe_sub, "status", "canceled")
    plan_id = plan_for_price(_get(first, "price", {})) or _get(_get(stripe_sub, "metadata", {}), "plan")
    period_end = _get(stripe_sub, "current_period_end") or _get(first, "current_period_end")
    sub = _subscription_row(db, workspace_id)
    sub.provider = "stripe"
    sub.provider_customer_id = _get(stripe_sub, "customer") or sub.provider_customer_id
    sub.provider_subscription_id = _get(stripe_sub, "id")
    sub.status = status
    sub.plan = plan_id if (plan_id in PLANS and status in LIVE) else "free"
    sub.current_period_end = _ts(period_end)
    db.commit()
    return sub


def _workspace_for(db: Session, stripe_sub=None, customer_id: str | None = None) -> uuid.UUID | None:
    ws = _get(_get(stripe_sub, "metadata", {}), "workspace_id") if stripe_sub is not None else None
    if ws:
        return uuid.UUID(ws)
    sub_id = _get(stripe_sub, "id") if stripe_sub is not None else None
    customer_id = customer_id or (_get(stripe_sub, "customer") if stripe_sub is not None else None)
    row = None
    if sub_id:
        row = db.scalar(select(Subscription).where(Subscription.provider_subscription_id == sub_id))
    if not row and customer_id:
        row = db.scalar(select(Subscription).where(Subscription.provider_customer_id == customer_id))
    return row.workspace_id if row else None


# Checkout, plan changes, portal


def start_checkout(db: Session, user: User, workspace: Workspace, plan: Plan, cycle: str,
                   success_url: str, cancel_url: str) -> str:
    sc = client()
    price = price_id(sc, plan, cycle)
    row = _subscription_row(db, workspace.id)
    if row.provider_subscription_id and row.status in LIVE:
        return change_plan(sc, db, workspace, row, price, success_url)
    customer = ensure_customer(sc, db, user, workspace)
    meta = {"workspace_id": str(workspace.id), "plan": plan.id, "cycle": cycle}
    session = sc.v1.checkout.sessions.create({
        "mode": "subscription",
        "customer": customer,
        "client_reference_id": str(workspace.id),
        "line_items": [{"price": price, "quantity": 1}],
        "metadata": meta,
        "subscription_data": {"metadata": meta},
        "allow_promotion_codes": True,
        "billing_address_collection": "auto",
        "customer_update": {"address": "auto", "name": "auto"},
        # 3D Secure: Checkout asks the bank whenever it wants it (SCA, Radar rules), nothing to force here.
        "success_url": success_url + "&session_id={CHECKOUT_SESSION_ID}",
        "cancel_url": cancel_url,
    })
    return session.url


def change_plan(sc: stripe.StripeClient, db: Session, workspace: Workspace, row: Subscription, price: str,
                success_url: str) -> str:
    """Move a live subscription to a new price, prorated. The change only sticks once paid; if the bank
    wants 3D Secure, send the user to the invoice page to confirm it."""
    current = sc.v1.subscriptions.retrieve(row.provider_subscription_id)
    item = _get(current, "items")["data"][0]
    updated = sc.v1.subscriptions.update(row.provider_subscription_id, {
        "items": [{"id": item["id"], "price": price}],
        "proration_behavior": "always_invoice",
        "payment_behavior": "pending_if_incomplete",
        "expand": ["latest_invoice"],
    })
    invoice = _get(updated, "latest_invoice")
    if _get(updated, "pending_update") and _get(invoice, "status") == "open":
        # Not paid yet: the bank wants 3D Secure, or the card was declined. Stripe's hosted invoice page
        # handles both (confirm, or pay with another card); the plan switches when that payment succeeds.
        hosted = _get(invoice, "hosted_invoice_url")
        if hosted:
            return hosted
        raise HTTPException(402, {"code": "payment_needs_action",
                                  "message": "The upgrade payment needs your attention. Check your email."})
    sync_subscription(db, workspace.id, updated)
    return success_url


def portal_url(db: Session, workspace: Workspace, return_url: str) -> str:
    row = db.scalar(select(Subscription).where(Subscription.workspace_id == workspace.id))
    if not row or not row.provider_customer_id:
        raise HTTPException(404, {"code": "no_billing_account", "message": "There is no billing account yet."})
    try:
        session = client().v1.billing_portal.sessions.create({"customer": row.provider_customer_id, "return_url": return_url})
    except stripe.InvalidRequestError as exc:
        log.error("stripe portal failed: %s", exc)
        raise HTTPException(503, {"code": "portal_unavailable",
                                  "message": "Billing management is unavailable right now. Please try again soon."}) from exc
    return session.url


def confirm_checkout(db: Session, workspace: Workspace, session_id: str) -> Subscription | None:
    """Apply a finished Checkout right away, without waiting for the webhook."""
    sc = client()
    session = sc.v1.checkout.sessions.retrieve(session_id, {"expand": ["subscription"]})
    if _get(session, "client_reference_id") != str(workspace.id):
        raise HTTPException(404, "Checkout session not found")
    stripe_sub = _get(session, "subscription")
    if not stripe_sub or _get(session, "status") != "complete":
        return None
    if isinstance(stripe_sub, str):
        stripe_sub = sc.v1.subscriptions.retrieve(stripe_sub)
    return sync_subscription(db, workspace.id, stripe_sub)


# Webhooks

HANDLED = {
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.paused",
    "customer.subscription.resumed",
    "invoice.paid",
    "invoice.payment_failed",
    "invoice.payment_action_required",
    "charge.dispute.created",
}


def parse_event(payload: bytes, signature: str | None):
    if not settings.stripe_webhook_secret:
        raise HTTPException(503, "STRIPE_WEBHOOK_SECRET is not set")
    try:
        return stripe.Webhook.construct_event(payload, signature or "", settings.stripe_webhook_secret)
    except (ValueError, stripe.SignatureVerificationError) as exc:
        raise HTTPException(400, "Invalid Stripe signature") from exc


def _first_time(db: Session, event) -> bool:
    """Record the event id; False when this delivery was already handled (Stripe retries)."""
    db.add(BillingEvent(id=event["id"], type=event["type"], created_at=datetime.now(UTC)))
    try:
        db.commit()
        return True
    except IntegrityError:
        db.rollback()
        return False


def _owner_email(db: Session, workspace_id: uuid.UUID | None) -> str | None:
    if not workspace_id:
        return None
    ws = db.get(Workspace, workspace_id)
    owner = db.get(User, ws.owner_id) if ws else None
    return owner.email if owner else None


def handle_event(db: Session, event) -> str:
    from app.services.email import email_service

    kind = event["type"]
    if kind not in HANDLED:
        return "ignored"
    first = _first_time(db, event)
    obj = event["data"]["object"]
    sc = client()

    if kind.startswith("checkout.session."):
        if _get(obj, "mode") != "subscription" or not _get(obj, "subscription"):
            return "skipped"
        ws = _get(obj, "client_reference_id") or _get(_get(obj, "metadata", {}), "workspace_id")
        if not ws:
            return "no workspace"
        sync_subscription(db, uuid.UUID(ws), sc.v1.subscriptions.retrieve(_get(obj, "subscription")))
        return "synced"

    if kind.startswith("customer.subscription."):
        ws = _workspace_for(db, obj)
        if not ws:
            log.warning("stripe %s for unknown subscription %s", kind, _get(obj, "id"))
            return "unknown"
        # Re-read: the payload can be older than the current state when deliveries arrive out of order.
        try:
            fresh = sc.v1.subscriptions.retrieve(_get(obj, "id"))
        except stripe.InvalidRequestError:
            fresh = obj
        sync_subscription(db, ws, fresh)
        return "synced"

    if kind.startswith("invoice."):
        sub_id = _get(obj, "subscription") or _get(_get(_get(obj, "parent", {}), "subscription_details", {}), "subscription")
        ws = _workspace_for(db, {"id": sub_id} if sub_id else None, customer_id=_get(obj, "customer"))
        if ws and sub_id:
            sync_subscription(db, ws, sc.v1.subscriptions.retrieve(sub_id))
        if first and kind in {"invoice.payment_action_required", "invoice.payment_failed"}:
            # The first invoice of a Checkout is handled on the Checkout page itself.
            if _get(obj, "billing_reason") != "subscription_create":
                to = _get(obj, "customer_email") or _owner_email(db, ws)
                url = _get(obj, "hosted_invoice_url") or f"{settings.frontend_url.rstrip('/')}/app/settings"
                if to:
                    email_service.send_payment_action(to, "confirm" if kind.endswith("action_required") else "failed", url)
        return "synced" if ws else "unknown"

    if kind == "charge.dispute.created" and first:
        email_service.send_alert(
            "Stripe dispute opened",
            f"Dispute {_get(obj, 'id')} for {(_get(obj, 'amount', 0) or 0) / 100:.2f} "
            f"{str(_get(obj, 'currency', '')).upper()}, reason: {_get(obj, 'reason')}. "
            "Respond in the Stripe dashboard before the deadline.",
        )
        return "alerted"
    return "ok"

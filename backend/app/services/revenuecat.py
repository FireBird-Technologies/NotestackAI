"""In-app subscriptions (App Store, Google Play) through RevenueCat.

The apps log in to RevenueCat with the workspace id, so a RevenueCat customer is a workspace. Its entitlements
`writer` and `studio` are the plans. We never trust a webhook's payload for the plan: every event (and the app's own
sync after a purchase) re-reads the customer from RevenueCat's REST API and writes what is true now into the one
Subscription row, through billing.apply_subscription.
"""

import hmac
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.models import BillingEvent, Subscription, User, Workspace

log = logging.getLogger(__name__)

API_URL = "https://api.revenuecat.com/v1/subscribers/{}"
PLAN_ORDER = ("studio", "writer")  # the entitlement ids; the first active one is the plan
# Where the person manages a store subscription (the billing problem email links here).
MANAGE_URLS = {
    "app_store": "https://apps.apple.com/account/subscriptions",
    "play_store": "https://play.google.com/store/account/subscriptions",
}
TEST_STORE = "test_store"  # RevenueCat's own Test Store: local testing, only with REVENUECAT_ALLOW_TEST_STORE


def _ours(store: str | None) -> bool:
    """A store whose purchases give a plan: Apple and Google, plus the Test Store when testing locally."""
    return store in MANAGE_URLS or (store == TEST_STORE and settings.revenuecat_allow_test_store)


NEW_PERIOD = {"INITIAL_PURCHASE", "RENEWAL"}  # a fresh video allowance, as Stripe's paid invoices give


@dataclass
class StoreState:
    plan: str  # "writer", "studio", or "free" when nothing is active
    status: str  # "active", "past_due" (billing problem, still in the store's grace period) or "canceled"
    store: str | None  # "app_store" / "play_store"
    transaction_id: str | None
    expires: datetime | None


def _when(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def fetch_customer(app_user_id: str) -> dict:
    """The customer as RevenueCat knows it now (GET /v1/subscribers/{id})."""
    res = httpx.get(API_URL.format(app_user_id), headers={"Authorization": f"Bearer {settings.revenuecat_secret_key}"},
                    timeout=10)
    res.raise_for_status()
    return res.json().get("subscriber") or {}


def state_from(customer: dict, now: datetime | None = None) -> StoreState:
    """The plan a customer's entitlements give: Studio over Writer, only while unexpired (or in a grace period)."""
    now = now or datetime.now(UTC)
    # Matched without case: the dashboard's identifier may be "Writer" or "writer"
    entitlements = {k.lower(): v for k, v in (customer.get("entitlements") or {}).items()}
    subscriptions = customer.get("subscriptions") or {}
    for plan in PLAN_ORDER:
        ent = entitlements.get(plan)
        if not ent:
            continue
        sub = subscriptions.get(ent.get("product_identifier") or "") or {}
        expires = _when(ent.get("expires_date"))
        grace = _when(ent.get("grace_period_expires_date") or sub.get("grace_period_expires_date"))
        if expires and expires <= now and not (grace and grace > now):
            continue
        store = sub.get("store")
        if not _ours(store):
            # e.g. a Test Store purchase without REVENUECAT_ALLOW_TEST_STORE: say so, it looks like a lost purchase
            log.warning("revenuecat entitlement %s from store %s ignored", plan, store)
            continue  # promotional or Stripe-through-RevenueCat grants are not ours to bill
        troubled = bool(sub.get("billing_issues_detected_at")) or bool(expires and expires <= now)
        return StoreState(plan=plan, status="past_due" if troubled else "active", store=store,
                          transaction_id=sub.get("store_transaction_id") or ent.get("product_identifier"),
                          expires=grace if expires and expires <= now else expires)
    return StoreState(plan="free", status="canceled", store=None, transaction_id=None, expires=None)


def sync_workspace(db: Session, workspace_id: uuid.UUID) -> str:
    """Write the workspace's store plan. Returns what happened, for logs and the webhook's response."""
    from app.services.billing import apply_subscription, held_by_other

    workspace = db.get(Workspace, workspace_id)
    owner = db.get(User, workspace.owner_id) if workspace else None
    if not owner or owner.deleted_at:
        return "deleted account"  # its plan ended with the account (billing.end_subscriptions); renewals don't revive it
    customer = fetch_customer(str(workspace_id))
    state = state_from(customer)
    # What RevenueCat said, in one line: a purchase that doesn't become a plan is explained here.
    log.info("revenuecat %s: entitlements=%s subscriptions=%s -> %s/%s", workspace_id,
             {k: (v.get("product_identifier"), v.get("expires_date")) for k, v in (customer.get("entitlements") or {}).items()},
             {k: v.get("store") for k, v in (customer.get("subscriptions") or {}).items()}, state.plan, state.status)
    sub = db.query(Subscription).filter_by(workspace_id=workspace_id).one_or_none()
    # Nothing active: this is the store that sold the current plan (if any), whose plan has now ended.
    provider = state.store or (sub.provider if sub and _ours(sub.provider) else "")
    if held_by_other(sub, provider):
        if state.plan != "free":
            log.warning("store plan %s for workspace %s ignored: already billed by %s", state.plan, workspace_id,
                        sub.provider)
        return "billed elsewhere"
    if state.plan == "free" and (not sub or not _ours(sub.provider)):
        return "nothing to do"  # never had a store plan: leave a free (or Stripe) row alone
    apply_subscription(db, workspace_id, plan=state.plan, status=state.status,
                       provider=provider, customer_id=str(workspace_id),
                       subscription_id=state.transaction_id, current_period_end=state.expires)
    return state.plan


def cancel_play(app_user_id: str) -> bool:
    """Cancel the customer's Google Play subscriptions (RevenueCat can, for Play only; Apple lets nobody but the
    subscriber cancel). They stop renewing; True when every one was cancelled."""
    ok = True
    for product, sub in (fetch_customer(app_user_id).get("subscriptions") or {}).items():
        if sub.get("store") != "play_store" or sub.get("unsubscribe_detected_at"):
            continue
        try:
            httpx.post(f"{API_URL.format(app_user_id)}/subscriptions/{product}/cancel",
                       headers={"Authorization": f"Bearer {settings.revenuecat_secret_key}"}, timeout=10).raise_for_status()
        except httpx.HTTPError as exc:
            log.warning("play cancel of %s for %s failed: %s", product, app_user_id, exc)
            ok = False
    return ok


def check_auth(header: str | None) -> None:
    secret = settings.revenuecat_webhook_auth
    if not secret or not header or not hmac.compare_digest(header.removeprefix("Bearer ").strip(), secret):
        raise HTTPException(401, "Invalid RevenueCat authorization")


def _workspace_id(db: Session, app_user_id: str | None) -> uuid.UUID | None:
    """The workspace a RevenueCat customer id names. Anonymous ids ($RCAnonymousID:...) name none."""
    try:
        ws = uuid.UUID(str(app_user_id))
    except ValueError:
        return None
    return ws if db.get(Workspace, ws) else None


def _first_time(db: Session, event_id: str, kind: str) -> bool:
    db.add(BillingEvent(id=f"rc_{event_id}"[:100], type=f"rc.{kind}"[:80], created_at=datetime.now(UTC)))
    try:
        db.commit()
        return True
    except IntegrityError:
        db.rollback()
        return False


def handle_event(db: Session, body: dict) -> str:
    """One webhook delivery. Every customer it names is re-read and synced; side effects run once per event."""
    from app.services import video_quota
    from app.services.email import email_service

    event = body.get("event") or {}
    kind = event.get("type") or ""
    if kind == "TEST":
        return "test"
    first = _first_time(db, str(event.get("id") or uuid.uuid4()), kind)
    # A transfer moves purchases between customers: both sides change.
    ids = [event.get("app_user_id"), *(event.get("transferred_from") or []), *(event.get("transferred_to") or [])]
    workspaces = [ws for ws in dict.fromkeys(_workspace_id(db, i) for i in ids) if ws]
    if not workspaces:
        log.warning("revenuecat %s for unknown customer %s", kind, event.get("app_user_id"))
        return "unknown"
    for ws in workspaces:
        result = sync_workspace(db, ws)
        if not first or result in {"billed elsewhere", "nothing to do", "deleted account"}:
            continue
        if kind in NEW_PERIOD:
            video_quota.reset_videos(db, ws)
        if kind == "BILLING_ISSUE":
            workspace = db.get(Workspace, ws)
            owner = db.get(User, workspace.owner_id) if workspace else None
            store = event.get("store", "").lower()
            if owner:
                email_service.send_payment_action(owner.email, "failed", MANAGE_URLS.get(store, MANAGE_URLS["app_store"]))
    return "synced"

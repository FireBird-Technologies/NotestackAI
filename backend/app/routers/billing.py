from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import Ctx, get_ctx
from app.config import settings
from app.db import get_db
from app.services.billing import STORE_NAMES, billing_status, create_checkout_url, create_portal_url, store_billed
from app.services.plans import PLANS, effective_plan, plan_dict, plan_order

router = APIRouter(prefix="/api/billing", tags=["billing"])


class CheckoutIn(BaseModel):
    plan: Literal["starter", "writer", "studio"]
    cycle: Literal["monthly", "annual"] = "monthly"


@router.get("/plans")
def list_plans():
    return {"billing_enabled": settings.billing_enabled, "plans": [plan_dict(p) for p in PLANS.values()]}


@router.get("/me")
def my_plan(ctx: Ctx = Depends(get_ctx)):
    plan = effective_plan(ctx.db, ctx.workspace)
    return {"billing_enabled": settings.billing_enabled, "plan": plan_dict(plan)}


@router.get("/status")
def status(ctx: Ctx = Depends(get_ctx)):
    """Plan, meters and nudges for the upgrade popup, the sidebar fuel gauge and the nudge dock."""
    return billing_status(ctx.db, ctx.workspace)


def _not_billed_by_store(ctx: Ctx) -> None:
    """A plan bought in the iOS or Android app is changed and cancelled there; the web can't touch it."""
    if store := store_billed(ctx.db, ctx.workspace):
        raise HTTPException(409, {"code": "billed_by_store", "store": store,
                                  "message": f"Your plan is billed through {STORE_NAMES[store]}. "
                                             "Change or cancel it in the Notestack app on your phone."})


@router.post("/checkout")
def checkout(body: CheckoutIn, ctx: Ctx = Depends(get_ctx)):
    if not settings.billing_enabled:
        raise HTTPException(409, {"code": "billing_disabled", "message": "Checkout is not available yet."})
    _not_billed_by_store(ctx)
    current = effective_plan(ctx.db, ctx.workspace)
    order = plan_order()
    if body.plan not in PLANS or order.index(body.plan) <= order.index(current.id):
        raise HTTPException(409, {"code": "already_on_plan", "message": f"You are already on {current.name}."})
    return {"url": create_checkout_url(ctx.db, ctx.user, ctx.workspace, PLANS[body.plan], body.cycle)}


@router.post("/portal")
def portal(ctx: Ctx = Depends(get_ctx)):
    if not settings.billing_enabled:
        raise HTTPException(409, {"code": "billing_disabled", "message": "Billing is not available yet."})
    _not_billed_by_store(ctx)
    return {"url": create_portal_url(ctx.db, ctx.workspace)}


class ConfirmIn(BaseModel):
    session_id: str


@router.post("/confirm")
def confirm(body: ConfirmIn, ctx: Ctx = Depends(get_ctx)):
    """Called when the app lands back from Checkout, so the new plan applies even if the webhook is late."""
    if not settings.billing_enabled:
        raise HTTPException(409, {"code": "billing_disabled", "message": "Billing is not available yet."})
    from app.services import stripe_billing

    stripe_billing.confirm_checkout(ctx.db, ctx.workspace, body.session_id)
    return billing_status(ctx.db, ctx.workspace)


@router.post("/webhook")
async def webhook(request: Request, db: Session = Depends(get_db)):
    """Stripe events. The signature is checked against the raw body, so nothing in front of the API may
    rewrite it. Point the Stripe endpoint at {API_URL}/api/billing/webhook."""
    if not settings.billing_enabled:
        return {"ignored": True}
    from app.services import stripe_billing

    event = stripe_billing.parse_event(await request.body(), request.headers.get("stripe-signature"))
    return {"received": True, "result": stripe_billing.handle_event(db, event)}


# In-app purchases (services/revenuecat.py)


@router.post("/iap/sync")
def iap_sync(ctx: Ctx = Depends(get_ctx)):
    """Called by the app right after a purchase or a restore, so the plan applies before RevenueCat's webhook."""
    if not settings.billing_enabled or not settings.revenuecat_secret_key:
        raise HTTPException(409, {"code": "billing_disabled", "message": "In-app purchases are not available yet."})
    from app.services import revenuecat

    revenuecat.sync_workspace(ctx.db, ctx.workspace.id)
    return billing_status(ctx.db, ctx.workspace)


@router.post("/revenuecat/webhook")
async def revenuecat_webhook(request: Request, db: Session = Depends(get_db)):
    """RevenueCat events for both stores. Point its webhook at {API_URL}/api/billing/revenuecat/webhook with the
    Authorization header set to REVENUECAT_WEBHOOK_AUTH."""
    from app.services import revenuecat

    revenuecat.check_auth(request.headers.get("authorization"))
    if not settings.billing_enabled or not settings.revenuecat_secret_key:
        return {"ignored": True}
    return {"received": True, "result": revenuecat.handle_event(db, await request.json())}

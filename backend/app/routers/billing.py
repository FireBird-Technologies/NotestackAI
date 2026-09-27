from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.auth import Ctx, get_ctx
from app.config import settings
from app.services.billing import billing_status, create_checkout_url, create_portal_url
from app.services.plans import PLAN_ORDER, PLANS, effective_plan, plan_dict

router = APIRouter(prefix="/api/billing", tags=["billing"])


class CheckoutIn(BaseModel):
    plan: Literal["writer", "studio"]
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


@router.post("/checkout")
def checkout(body: CheckoutIn, ctx: Ctx = Depends(get_ctx)):
    if not settings.billing_enabled:
        raise HTTPException(409, {"code": "billing_disabled", "message": "Checkout is not available yet."})
    current = effective_plan(ctx.db, ctx.workspace)
    if PLAN_ORDER.index(body.plan) <= PLAN_ORDER.index(current.id):
        raise HTTPException(409, {"code": "already_on_plan", "message": f"You are already on {current.name}."})
    return {"url": create_checkout_url(ctx.db, ctx.user, ctx.workspace, PLANS[body.plan], body.cycle)}


@router.post("/portal")
def portal(ctx: Ctx = Depends(get_ctx)):
    if not settings.billing_enabled:
        raise HTTPException(409, {"code": "billing_disabled", "message": "Billing is not available yet."})
    return {"url": create_portal_url(ctx.db, ctx.workspace)}


@router.post("/webhook")
async def webhook(request: Request):
    """TODO(stripe): verify the Stripe-Signature header against STRIPE_WEBHOOK_SECRET, then map events to
    services.billing.apply_subscription (workspace id from client_reference_id, plan from metadata)."""
    if not settings.billing_enabled:
        return {"ignored": True}
    raise HTTPException(501, "Webhook not wired yet")

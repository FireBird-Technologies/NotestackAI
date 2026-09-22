from fastapi import APIRouter, Depends, HTTPException

from app.auth import Ctx, get_ctx
from app.config import settings
from app.services.plans import PLANS, effective_plan, plan_dict

router = APIRouter(prefix="/api/billing", tags=["billing"])


@router.get("/plans")
def list_plans():
    return {"billing_enabled": settings.billing_enabled, "plans": [plan_dict(p) for p in PLANS.values()]}


@router.get("/me")
def my_plan(ctx: Ctx = Depends(get_ctx)):
    plan = effective_plan(ctx.db, ctx.workspace)
    return {"billing_enabled": settings.billing_enabled, "plan": plan_dict(plan)}


@router.post("/checkout")
def checkout(ctx: Ctx = Depends(get_ctx)):
    if not settings.billing_enabled:
        raise HTTPException(409, {"code": "billing_disabled", "message": "Notestack is free during early access."})
    raise HTTPException(501, "Checkout provider not wired yet")


@router.post("/webhook")
def webhook():
    if not settings.billing_enabled:
        return {"ignored": True}
    raise HTTPException(501, "Webhook not wired yet")

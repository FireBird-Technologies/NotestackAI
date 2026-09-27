"""Upgrade flow: plan status with meters, nudges, and the seams where the payment provider plugs in.

Stripe goes in create_checkout_url, create_portal_url and the webhook route; everything around it
(meters, nudges, subscription bookkeeping, 402 payloads) is provider agnostic.
"""

from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Artifact, CalendarItem, Notebook, Source, Subscription, User, VoiceProfile, Workspace
from app.services.plans import PLANS, Plan, effective_plan, next_plan, plan_dict
from app.services.usage import month_usage

CYCLES = {"monthly", "annual"}
LOW_FUEL = 0.8  # meters at or above this share of the allowance start nudging

METERS = {
    "audio_minutes": ("Audio overviews", "min"),
    "video_minutes": ("Video renders", "min"),
    "launch_kits": ("Launch Kits", ""),
}


def _meters(plan: Plan, used: dict, sources: int) -> list[dict]:
    rows = []
    for key, (label, unit) in METERS.items():
        limit = getattr(plan, key)
        rows.append({"key": key, "label": label, "unit": unit, "used": used[key], "limit": limit,
                     "pct": 0 if limit < 0 else round(min(1.0, used[key] / max(limit, 1)), 3)})
    rows.append({"key": "sources", "label": "Sources", "unit": "", "used": sources, "limit": plan.sources,
                 "pct": round(min(1.0, sources / max(plan.sources, 1)), 3)})
    return rows


def _count(db: Session, model, workspace_id, *where) -> int:
    return db.scalar(select(func.count()).select_from(model).where(model.workspace_id == workspace_id, *where)) or 0


def _nudge(nid: str, tone: str, title: str, body: str, cta: str, to: str | None = None, priority: int = 50) -> dict:
    """tone: limit (out of or low on fuel), upgrade (locked perk), action (do more with what you have).
    to is an app route, or None when the CTA opens the upgrade popup."""
    return {"id": nid, "tone": tone, "title": title, "body": body, "cta": cta, "to": to, "priority": priority}


def build_nudges(db: Session, workspace: Workspace, plan: Plan, meters: list[dict], can_upgrade: bool) -> list[dict]:
    ws = workspace.id
    out: list[dict] = []
    month = datetime.now(UTC).strftime("%Y-%m")

    if can_upgrade:
        for m in meters:
            if m["limit"] < 0 or m["key"] == "sources":
                continue
            label = m["label"].lower()
            amount = f"{m['limit']:g} min of {label}" if m["unit"] else f"{m['limit']:g} {label}"
            if m["pct"] >= 1:
                out.append(_nudge(f"empty-{m['key']}-{month}", "limit", f"Out of {label} this month",
                                  f"You have used all {amount}. Upgrade to keep launching.", "Refuel now",
                                  priority=100))
            elif m["pct"] >= LOW_FUEL:
                left = f"{m['limit'] - m['used']:g}" + (" min" if m["unit"] else "")
                out.append(_nudge(f"low-{m['key']}-{month}", "limit", f"Running low on {label}",
                                  f"Only {left} left this month. Upgrade before you stall mid launch.",
                                  "See plans", priority=90))
        if not plan.voice_cloning:
            out.append(_nudge("perk-voice", "upgrade", "Narrate in your own voice",
                              "Writer unlocks voice cloning, so every audio overview sounds like you.",
                              "Unlock voice", priority=40))
        if not plan.brand_kit:
            out.append(_nudge("perk-brand", "upgrade", "Put your brand on every render",
                              "Your colors and logo on videos, quote cards and carousels.", "Unlock brand kit",
                              priority=30))

    sources = _count(db, Source, ws)
    if sources == 0:
        out.append(_nudge("act-source", "action", "Connect your archive",
                          "Paste your Substack or blog URL and Notestack reads every post.", "Connect a source",
                          "/app/sources", priority=95))
        return sorted(out, key=lambda n: -n["priority"])

    if _count(db, Notebook, ws) == 0:
        out.append(_nudge("act-notebook", "action", "Open your first notebook",
                          "Ask your archive anything and get answers with citations to your own posts.",
                          "Create a notebook", "/app/notebooks", priority=80))
    kits = next(m for m in meters if m["key"] == "launch_kits")
    if kits["used"] == 0:
        left = "Unlimited" if kits["limit"] < 0 else f"{kits['limit']}"
        out.append(_nudge(f"act-kit-{month}", "action", "Launch your latest post",
                          f"{left} Launch Kits this month, none used yet. One click turns a post into threads, "
                          "LinkedIn posts, quote cards and a short video.", "Build a Launch Kit",
                          "/app/launch-kit", priority=70))
    elif kits["limit"] > 0 and kits["used"] < kits["limit"]:
        left = kits["limit"] - kits["used"]
        out.append(_nudge(f"act-kit-left-{month}-{kits['used']}", "action",
                          f"{left} Launch Kit{'s' if left != 1 else ''} left this month",
                          "They reset on the 1st. Pick an older post and give it a second orbit.",
                          "Use one now", "/app/launch-kit", priority=45))
    if _count(db, Artifact, ws, Artifact.type == "audio_overview") == 0:
        out.append(_nudge("act-audio", "action", "Hear your archive",
                          "Make a two host audio overview of any notebook in about a minute.", "Make audio",
                          "/app/studio", priority=55))
    if not db.scalar(select(VoiceProfile.id).where(VoiceProfile.workspace_id == ws)):
        out.append(_nudge("act-voice", "action", "Teach Notestack your voice",
                          "A voice profile keeps every draft sounding like you wrote it.", "Build voice profile",
                          "/app/voice", priority=50))
    if _count(db, CalendarItem, ws) == 0:
        out.append(_nudge("act-launchpad", "action", "Fill your launch window",
                          "Schedule this week's posts on the Launchpad and let them go out on their own.",
                          "Open Launchpad", "/app/launchpad", priority=35))
    out.append(_nudge(f"act-resurface-{month}", "action", "Old posts, new orbit",
                      "Resurfacing finds evergreen posts worth sharing again this month.", "Find evergreen posts",
                      "/app/resurface", priority=20))
    return sorted(out, key=lambda n: -n["priority"])


def billing_status(db: Session, workspace: Workspace) -> dict:
    plan = effective_plan(db, workspace)
    used = month_usage(db, workspace.id)
    sources = _count(db, Source, workspace.id)
    meters = _meters(plan, used, sources)
    upgrade = next_plan(plan)
    can_upgrade = settings.billing_enabled and upgrade is not None
    sub = db.query(Subscription).filter_by(workspace_id=workspace.id).one_or_none()
    return {
        "billing_enabled": settings.billing_enabled,
        "plan": plan_dict(plan),
        "plans": [plan_dict(p) for p in PLANS.values()],
        "next_plan": upgrade.id if upgrade else None,
        "can_upgrade": can_upgrade,
        "has_billing_account": bool(sub and sub.provider_customer_id),
        "period_end": sub.current_period_end.isoformat() if sub and sub.current_period_end else None,
        "meters": meters,
        "since": used["since"],
        "nudges": build_nudges(db, workspace, plan, meters, can_upgrade),
    }


def apply_subscription(db: Session, workspace_id, *, plan: str, status: str, provider: str = "stripe",
                       customer_id: str | None = None, subscription_id: str | None = None,
                       current_period_end: datetime | None = None) -> Subscription:
    """Upsert the workspace subscription. Call this from the webhook for checkout.session.completed,
    customer.subscription.updated and customer.subscription.deleted (status 'canceled' drops to Free)."""
    if plan not in PLANS:
        raise ValueError(f"Unknown plan {plan}")
    sub = db.query(Subscription).filter_by(workspace_id=workspace_id).one_or_none()
    if not sub:
        sub = Subscription(workspace_id=workspace_id)
        db.add(sub)
    sub.plan, sub.status, sub.provider = plan, status, provider
    sub.provider_customer_id = customer_id or sub.provider_customer_id
    sub.provider_subscription_id = subscription_id or sub.provider_subscription_id
    sub.current_period_end = current_period_end
    db.commit()
    return sub


def return_urls() -> tuple[str, str]:
    """(success_url, cancel_url) for the hosted checkout page."""
    base = settings.frontend_url.rstrip("/")
    return f"{base}/app?checkout=success", f"{base}/app?checkout=cancel"


def create_checkout_url(db: Session, user: User, workspace: Workspace, plan: Plan, cycle: str) -> str:
    """Hosted Stripe Checkout for plan on the monthly or annual cycle, or an in place plan change (which may
    return Stripe's invoice page when the bank wants 3D Secure). See services/stripe_billing.py."""
    from app.services import stripe_billing

    success, cancel = return_urls()
    return stripe_billing.start_checkout(db, user, workspace, plan, cycle, success, cancel)


def create_portal_url(db: Session, workspace: Workspace) -> str:
    """Stripe customer portal: change card, switch or cancel the plan, download invoices."""
    from app.services import stripe_billing

    return stripe_billing.portal_url(db, workspace, f"{settings.frontend_url.rstrip('/')}/app/settings")

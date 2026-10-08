from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.auth import Ctx, get_ctx
from app.config import settings as app_settings
from app.services.plans import effective_plan, plan_dict
from app.services.usage import usage_report

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsIn(BaseModel):
    name: str | None = Field(None, max_length=200)
    workspace_name: str | None = Field(None, min_length=1, max_length=200)
    training_opt_in: bool | None = None
    allow_public_links: bool | None = None
    email_unsubscribed: bool | None = None


def _serialize(ctx: Ctx) -> dict:
    return {
        "user": {"name": ctx.user.name, "email": ctx.user.email, "auth_provider": ctx.user.auth_provider.value,
                 "email_unsubscribed": ctx.user.email_unsubscribed},
        "workspace": {"id": str(ctx.workspace.id), "name": ctx.workspace.name,
                      "training_opt_in": ctx.workspace.training_opt_in,
                      "allow_public_links": ctx.workspace.allow_public_links},
        "plan": plan_dict(effective_plan(ctx.db, ctx.workspace)),
        "billing_enabled": app_settings.billing_enabled,
        "usage": usage_report(ctx.db, ctx.workspace),
        "integrations": {"llm": bool(app_settings.llm_api_key), "elevenlabs": bool(app_settings.elevenlabs_api_key),
                         "x": bool(app_settings.x_client_id), "linkedin": bool(app_settings.linkedin_client_id),
                         "storage": "local" if app_settings.use_local_storage else "r2",
                         "renderer": app_settings.renderer_url},
    }


@router.get("/limits")
def artifact_limits(_ctx: Ctx = Depends(get_ctx)):
    """How many posts a report or infographic reads, and a dialog ticks to start with (ARTIFACT_MAX_POSTS), so the pickers match the
    server. A quiz or flashcard set can read as many posts as the plan indexes (selectable_posts)."""
    from app.pipeline.material import max_posts

    return {"posts": max_posts(), "selectable_posts": effective_plan(_ctx.db, _ctx.workspace).indexed_posts}


@router.get("")
def get_settings(ctx: Ctx = Depends(get_ctx)):
    return _serialize(ctx)


@router.patch("")
def update_settings(body: SettingsIn, ctx: Ctx = Depends(get_ctx)):
    if body.name is not None:
        ctx.user.name = body.name.strip() or None
    if body.workspace_name is not None:
        ctx.workspace.name = body.workspace_name.strip()
    if body.training_opt_in is not None:
        ctx.workspace.training_opt_in = body.training_opt_in
    if body.allow_public_links is not None:
        ctx.workspace.allow_public_links = body.allow_public_links
    if body.email_unsubscribed is not None:
        ctx.user.email_unsubscribed = body.email_unsubscribed
    ctx.db.commit()
    return _serialize(ctx)


@router.get("/usage")
def usage(ctx: Ctx = Depends(get_ctx)):
    return usage_report(ctx.db, ctx.workspace)

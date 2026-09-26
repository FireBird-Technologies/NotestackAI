import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.config import settings as app_settings
from app.models import Upload
from app.services.plans import effective_plan, plan_dict
from app.services.storage import storage
from app.services.usage import usage_report

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsIn(BaseModel):
    name: str | None = Field(None, max_length=200)
    workspace_name: str | None = Field(None, min_length=1, max_length=200)
    brand_name: str | None = Field(None, max_length=120)
    brand_accent: str | None = None
    logo_upload_id: str | None = None  # "" removes the logo
    training_opt_in: bool | None = None
    email_unsubscribed: bool | None = None


def _serialize(ctx: Ctx) -> dict:
    brand = ctx.workspace.brand_json or {}
    return {
        "user": {"name": ctx.user.name, "email": ctx.user.email, "auth_provider": ctx.user.auth_provider.value,
                 "email_unsubscribed": ctx.user.email_unsubscribed},
        "workspace": {"id": str(ctx.workspace.id), "name": ctx.workspace.name,
                      "training_opt_in": ctx.workspace.training_opt_in},
        "brand": {"name": brand.get("name"), "accent": brand.get("accent") or "#217cff",
                  "logo_url": storage.presign_get(brand["logo_key"]) if brand.get("logo_key") else None},
        "plan": plan_dict(effective_plan(ctx.db, ctx.workspace)),
        "billing_enabled": app_settings.billing_enabled,
        "usage": usage_report(ctx.db, ctx.workspace),
        "integrations": {"llm": bool(app_settings.llm_api_key), "elevenlabs": bool(app_settings.elevenlabs_api_key),
                         "x": bool(app_settings.x_client_id), "linkedin": bool(app_settings.linkedin_client_id),
                         "storage": "local" if app_settings.use_local_storage else "r2",
                         "renderer": app_settings.renderer_url},
    }


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
    if body.email_unsubscribed is not None:
        ctx.user.email_unsubscribed = body.email_unsubscribed
    brand = dict(ctx.workspace.brand_json or {})
    if body.brand_name is not None:
        brand["name"] = body.brand_name.strip() or None
    if body.brand_accent is not None:
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", body.brand_accent):
            raise HTTPException(422, "Use a hex color like #217cff")
        brand["accent"] = body.brand_accent.lower()
    if body.logo_upload_id is not None:
        if body.logo_upload_id == "":
            brand.pop("logo_key", None)
        else:
            upload = ctx.db.scalar(select(Upload).where(Upload.id == body.logo_upload_id,
                                                        Upload.workspace_id == ctx.workspace.id))
            if not upload or upload.status != "complete" or not upload.content_type.startswith("image/"):
                raise HTTPException(400, "Upload an image first")
            brand["logo_key"] = upload.key
    ctx.workspace.brand_json = brand
    ctx.db.commit()
    return _serialize(ctx)


@router.get("/usage")
def usage(ctx: Ctx = Depends(get_ctx)):
    return usage_report(ctx.db, ctx.workspace)

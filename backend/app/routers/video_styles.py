"""Custom video styles: writing guidance for the script, used on videos as custom:<id>.

Styles are made on our one blog2video account, so b2v_styles records which workspace made each; only that
workspace sees, uses, edits or deletes it. Built-in styles are read-only here, and "Your Style" (which learns from
every workspace's edits) is never offered. The account-wide style selection, pin and built-in overrides are never
touched (blog2video.DENIED).
"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import Ctx, get_ctx
from app.models import B2VStyle
from app.routers.videos import b2v_ready, upstream
from app.services import b2v_access
from app.services import blog2video as b2v

router = APIRouter(prefix="/api/video-styles", tags=["videos"])


class DraftIn(BaseModel):
    prompt: str = Field(min_length=20, max_length=1000)


class StyleIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    guidance: str = Field(min_length=1, max_length=2000)
    creation_method: Literal["manual", "ai"] = "manual"
    source_prompt: str | None = Field(None, max_length=1000)


class StylePatchIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    guidance: str = Field(min_length=1, max_length=2000)
    version: int = Field(ge=0)


@router.get("")
def list_styles(ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    with upstream():
        return b2v_access.visible_styles(ctx)


@router.post("/ai-draft")
def ai_draft(body: DraftIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    """A name and guidance written from a description; nothing is saved."""
    with upstream():
        return b2v.request("POST", "/api/video-styles/ai-draft", json=body.model_dump(), timeout=90)


def _out(s: dict) -> dict:
    return {"id": s.get("id"), "custom_id": s.get("custom_id"), "name": s.get("name"), "guidance": s.get("guidance"),
            "description": s.get("description"), "version": s.get("version"), "kind": "custom"}


@router.post("", status_code=201)
def create_style(body: StyleIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    with upstream():
        made = b2v.request("POST", "/api/video-styles/custom", json=body.model_dump())
    ctx.db.add(B2VStyle(b2v_style_id=int(made["custom_id"]), workspace_id=ctx.workspace.id, name=body.name))
    ctx.db.commit()
    return _out(made)


@router.patch("/{style_id}")
def update_style(style_id: int, body: StylePatchIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    row = b2v_access.owned_style(ctx, style_id)
    with upstream():
        made = b2v.request("PATCH", f"/api/video-styles/custom/{style_id}", json=body.model_dump())
    row.name = body.name
    ctx.db.commit()
    return _out(made)


@router.delete("/{style_id}")
def delete_style(style_id: int, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    row = b2v_access.owned_style(ctx, style_id)
    try:
        with upstream():
            b2v.request("DELETE", f"/api/video-styles/custom/{style_id}")
    except HTTPException as e:
        if e.status_code != 404:
            raise
    ctx.db.delete(row)
    ctx.db.commit()
    return {"ok": True}

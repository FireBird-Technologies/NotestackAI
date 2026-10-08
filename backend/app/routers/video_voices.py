"""Voices for videos: the workspace's saved voices, the free built-in library, and its Notestack voices (made on the Voice
page; they speak audio overviews, not videos).

"Your voices" (user_saved_voices, as many as wanted) is the one list for audio overviews and videos, and lives only
here: blog2video's saved-voice list is one list for the whole account.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.models import UserSavedVoice
from app.routers.videos import b2v_ready, upstream
from app.services import blog2video as b2v
from app.services.notestack_voices import notestack_voices, save_notestack_voice

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/video-voices", tags=["videos"])

STARTER_VOICES = 4  # a new workspace starts with this many free built-in voices saved


def _labels(v: dict) -> dict:
    return v.get("labels") or {}


def _voice_out(v: UserSavedVoice, ours: set[str] = frozenset()) -> dict:
    return {"voice_id": v.voice_id, "name": v.name, "preview_url": v.preview_url, "gender": v.gender,
            "accent": v.accent,
            "source": "notestack" if v.voice_id in ours else "blog2video"}


def _library_out(v: dict, saved: set[str]) -> dict:
    labels = _labels(v)
    return {"voice_id": v["voice_id"], "name": (v.get("name") or "Voice").split(" - ")[0].strip(),
            "description": v.get("description") or labels.get("description") or "", "preview_url": v.get("preview_url"),
            "gender": labels.get("gender"), "accent": labels.get("accent"), "age": labels.get("age"),
            "saved": v["voice_id"] in saved}


def _save_builtin(ctx: Ctx, v: dict) -> UserSavedVoice:
    labels = _labels(v)
    row = UserSavedVoice(workspace_id=ctx.workspace.id, voice_id=v["voice_id"],
                         name=(v.get("name") or "Voice").split(" - ")[0].strip()[:255],
                         preview_url=v.get("preview_url"),
                         gender=labels.get("gender"), accent=labels.get("accent"))
    ctx.db.merge(row)
    return row


def _saved(ctx: Ctx, ours: set[str] = frozenset()) -> list[UserSavedVoice]:
    """The saved voices that can still be used: free built-in voices and the workspace's Notestack voices. Voices that
    were designed or cloned for videos, and paid built-in ones, are gone."""
    rows = ctx.db.scalars(select(UserSavedVoice).where(UserSavedVoice.workspace_id == ctx.workspace.id)
                          .order_by(UserSavedVoice.created_at))
    return [v for v in rows if v.voice_id in ours or not (v.is_custom or v.premium)]


@router.get("")
def voices(ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    """Your voices (audio overviews and videos), the free built-in library (to save from) and your Notestack voices."""
    with upstream():
        library = [v for v in b2v.prebuilt_voices() if v.get("plan") != "paid"]
    mine = notestack_voices(ctx.db, ctx.workspace.id)
    ours = {v["voice_id"] for v in mine}
    saved = _saved(ctx, ours)
    if not saved:
        for v in [v for v in library if v.get("voice_id")][:STARTER_VOICES]:
            _save_builtin(ctx, v)
        ctx.db.commit()
        saved = _saved(ctx, ours)
    ids = {v.voice_id for v in saved}
    return {"saved": [_voice_out(v, ours) for v in saved],
            "notestack": [{**v, "saved": v["voice_id"] in ids} for v in mine],
            "library": [_library_out(v, ids) for v in library if v.get("voice_id")]}


class SaveIn(BaseModel):
    voice_id: str = Field(min_length=1, max_length=100)


@router.post("/saved", status_code=201)
def save_voice(body: SaveIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    if ctx.db.get(UserSavedVoice, {"workspace_id": ctx.workspace.id, "voice_id": body.voice_id}):
        return _voice_out(ctx.db.get(UserSavedVoice, {"workspace_id": ctx.workspace.id, "voice_id": body.voice_id}))
    mine = next((v for v in notestack_voices(ctx.db, ctx.workspace.id) if v["voice_id"] == body.voice_id), None)
    if mine:
        # A Notestack voice: saved on any plan, for audio overviews. No preview link (the Voice page plays it).
        row = save_notestack_voice(ctx.db, ctx.workspace.id, mine["voice_id"], mine["name"])
        ctx.db.commit()
        return _voice_out(row, {row.voice_id})
    with upstream():
        v = next((v for v in b2v.prebuilt_voices() if v.get("voice_id") == body.voice_id), None)
    if not v or v.get("plan") == "paid":
        raise HTTPException(404, "Voice not found")
    row = _save_builtin(ctx, v)
    ctx.db.commit()
    return _voice_out(row)


@router.delete("/saved/{voice_id}")
def unsave_voice(voice_id: str, ctx: Ctx = Depends(get_ctx)):
    row = ctx.db.get(UserSavedVoice, {"workspace_id": ctx.workspace.id, "voice_id": voice_id})
    if not row:
        raise HTTPException(404, "Voice not found")
    ctx.db.delete(row)
    ctx.db.commit()
    return {"ok": True}

"""Voices for videos: the workspace's saved voices, the built-in library, custom voices (design, clone), and its
Notestack voices (made on the Voice page; blog2video speaks with the same ElevenLabs account).

"My voices" (user_saved_voices, at most MAX_SAVED_VOICES) lives only here: blog2video's saved-voice list is one list
for the whole account.
Custom voices are made on our blog2video account, so b2v_custom_voices records which workspace made each one;
only that workspace can use, play or delete it. Designing, keeping, cloning and samples are premium (★) and come out
of the workspace's own daily and total counters (video_limits).
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.models import B2VCustomVoice, UserSavedVoice
from app.routers.videos import b2v_ready, upstream
from app.services import b2v_access, video_limits
from app.services import blog2video as b2v
from app.services.notestack_voices import notestack_voices

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/video-voices", tags=["videos"])

CLONE_MAX_BYTES = 50 * 1024 * 1024
STARTER_VOICES = 4  # a new workspace starts with this many free built-in voices saved
MAX_SAVED_VOICES = 5  # "My voices": what step 3 of a new video offers


def _labels(v: dict) -> dict:
    return v.get("labels") or {}


def _voice_out(v: UserSavedVoice, ours: set[str] = frozenset()) -> dict:
    return {"voice_id": v.voice_id, "name": v.name, "preview_url": v.preview_url, "gender": v.gender,
            "accent": v.accent, "premium": v.premium, "is_custom": v.is_custom,
            "source": "notestack" if v.voice_id in ours else "blog2video"}


def _room(ctx: Ctx) -> bool:
    return len(_saved(ctx)) < MAX_SAVED_VOICES


def _full() -> HTTPException:
    return HTTPException(409, f"You can keep {MAX_SAVED_VOICES} voices. Remove one first.")


def _library_out(v: dict, saved: set[str]) -> dict:
    labels = _labels(v)
    return {"voice_id": v["voice_id"], "name": (v.get("name") or "Voice").split(" - ")[0].strip(),
            "description": v.get("description") or labels.get("description") or "", "preview_url": v.get("preview_url"),
            "gender": labels.get("gender"), "accent": labels.get("accent"), "age": labels.get("age"),
            "premium": v.get("plan") == "paid", "saved": v["voice_id"] in saved}


def _save_builtin(ctx: Ctx, v: dict) -> UserSavedVoice:
    labels = _labels(v)
    row = UserSavedVoice(workspace_id=ctx.workspace.id, voice_id=v["voice_id"],
                         name=(v.get("name") or "Voice").split(" - ")[0].strip()[:255],
                         preview_url=v.get("preview_url"),
                         gender=labels.get("gender"), accent=labels.get("accent"), premium=v.get("plan") == "paid")
    ctx.db.merge(row)
    return row


def _saved(ctx: Ctx) -> list[UserSavedVoice]:
    return list(ctx.db.scalars(select(UserSavedVoice).where(UserSavedVoice.workspace_id == ctx.workspace.id)
                               .order_by(UserSavedVoice.created_at)))


@router.get("")
def voices(ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    """My voices (for the wizard), the built-in library (to save from) and my custom voices."""
    with upstream():
        library = b2v.prebuilt_voices()
    saved = _saved(ctx)
    if not saved:
        for v in [v for v in library if v.get("plan") != "paid" and v.get("voice_id")][:STARTER_VOICES]:
            _save_builtin(ctx, v)
        ctx.db.commit()
        saved = _saved(ctx)
    ids = {v.voice_id for v in saved}
    custom = ctx.db.scalars(select(B2VCustomVoice).where(B2VCustomVoice.workspace_id == ctx.workspace.id)
                            .order_by(B2VCustomVoice.created_at.desc()))
    mine = notestack_voices(ctx.db, ctx.workspace.id)
    ours = {v["voice_id"] for v in mine}
    return {"saved": [_voice_out(v, ours) for v in saved], "max_saved": MAX_SAVED_VOICES,
            "notestack": [{**v, "saved": v["voice_id"] in ids} for v in mine],
            "library": [_library_out(v, ids) for v in library if v.get("voice_id")],
            "custom": [{"id": c.b2v_custom_voice_id, "voice_id": c.voice_id, "name": c.name, "source": c.source,
                        "preview_url": c.preview_url, "saved": c.voice_id in ids} for c in custom]}


class SaveIn(BaseModel):
    voice_id: str = Field(min_length=1, max_length=100)


@router.post("/saved", status_code=201)
def save_voice(body: SaveIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    if ctx.db.get(UserSavedVoice, {"workspace_id": ctx.workspace.id, "voice_id": body.voice_id}):
        return _voice_out(ctx.db.get(UserSavedVoice, {"workspace_id": ctx.workspace.id, "voice_id": body.voice_id}))
    if not _room(ctx):
        raise _full()
    custom = ctx.db.scalar(select(B2VCustomVoice).where(B2VCustomVoice.voice_id == body.voice_id,
                                                        B2VCustomVoice.workspace_id == ctx.workspace.id))
    mine = next((v for v in notestack_voices(ctx.db, ctx.workspace.id) if v["voice_id"] == body.voice_id), None)
    if mine:
        # A Notestack voice: premium, like a custom voice. No preview link (the Voice page plays it).
        video_limits.require_premium(ctx.db, ctx.workspace, "Custom voices")
        row = ctx.db.merge(UserSavedVoice(workspace_id=ctx.workspace.id, voice_id=mine["voice_id"],
                                          name=mine["name"][:255], premium=True, is_custom=True))
        ctx.db.commit()
        return _voice_out(row, {row.voice_id})
    if custom:
        row = ctx.db.merge(UserSavedVoice(workspace_id=ctx.workspace.id, voice_id=custom.voice_id, name=custom.name,
                                          preview_url=custom.preview_url, premium=True, is_custom=True))
    else:
        with upstream():
            v = next((v for v in b2v.prebuilt_voices() if v.get("voice_id") == body.voice_id), None)
        if not v:
            raise HTTPException(404, "Voice not found")
        if v.get("plan") == "paid":
            video_limits.require_premium(ctx.db, ctx.workspace, "This voice")
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


# Design a voice ★: a description or options -> a few previews; keep one to make it a custom voice


class DesignPromptIn(BaseModel):
    prompt: str = Field(min_length=20, max_length=1000)


class DesignPresetIn(BaseModel):
    gender: str = Field("", max_length=30)
    age: str = Field("", max_length=30)
    persona: str = Field("", max_length=100)
    speed: str = Field("", max_length=30)
    accent: str = Field("", max_length=60)


def _design(ctx: Ctx, path: str, body: dict) -> dict:
    plan = video_limits.require_premium(ctx.db, ctx.workspace, "Designing a voice")
    video_limits.take(ctx.db, ctx.workspace, "voice_designs_daily", plan=plan)
    try:
        with upstream():
            data = b2v.request("POST", path, json=body, timeout=90) or {}
    except HTTPException:
        video_limits.give_back(ctx.db, ctx.workspace.id, "voice_designs_daily")
        raise
    return {"previews": [{k: p.get(k) for k in ("generated_voice_id", "audio_base_64", "media_type", "duration_secs")}
                         for p in data.get("previews") or []]}


@router.post("/design/prompt")
def design_from_prompt(body: DesignPromptIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    return _design(ctx, "/api/voices/design-from-prompt", body.model_dump())


@router.post("/design/preset")
def design_from_preset(body: DesignPresetIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    return _design(ctx, "/api/voices/design-from-preset", body.model_dump())


class KeepIn(BaseModel):
    generated_voice_id: str = Field(min_length=1, max_length=200)
    source: Literal["prompt", "preset"]
    name: str = Field(min_length=1, max_length=100)
    prompt_text: str | None = Field(None, max_length=1000)
    preview_url: str | None = Field(None, max_length=1000)


def _record_custom(ctx: Ctx, made: dict, source: str) -> dict:
    row = B2VCustomVoice(b2v_custom_voice_id=int(made["id"]), workspace_id=ctx.workspace.id,
                         voice_id=made["voice_id"], name=(made.get("name") or "My voice")[:255], source=source,
                         preview_url=made.get("preview_url"))
    ctx.db.add(row)
    saved = _room(ctx)  # kept in My voices only while there is room; otherwise added from the list later
    if saved:
        ctx.db.merge(UserSavedVoice(workspace_id=ctx.workspace.id, voice_id=row.voice_id, name=row.name,
                                    preview_url=row.preview_url, premium=True, is_custom=True))
    ctx.db.commit()
    return {"id": row.b2v_custom_voice_id, "voice_id": row.voice_id, "name": row.name, "source": source,
            "preview_url": row.preview_url, "saved": saved}


def _make_custom(ctx: Ctx, source: str, send) -> dict:
    plan = video_limits.require_premium(ctx.db, ctx.workspace, "Custom voices")
    video_limits.take(ctx.db, ctx.workspace, "custom_voices", plan=plan)
    try:
        with upstream():
            made = send()
    except HTTPException:
        video_limits.give_back(ctx.db, ctx.workspace.id, "custom_voices")
        raise
    return _record_custom(ctx, made, source)


@router.post("/custom", status_code=201)
def keep_designed_voice(body: KeepIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    """Keep one designed preview as a permanent custom voice."""
    payload = {"voice_id": body.generated_voice_id, "source": "prompt" if body.source == "prompt" else "form",
               "name": body.name, "prompt_text": body.prompt_text, "preview_url": body.preview_url}
    return _make_custom(ctx, body.source,
                        lambda: b2v.request("POST", "/api/voices/custom", json=payload, timeout=60))


@router.post("/clone", status_code=201)
async def clone_voice(name: str = Form(..., min_length=1, max_length=100), remove_background_noise: bool = Form(True),
                      file: UploadFile = File(...), ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    """Clone a voice from one audio or video file (up to 50 MB)."""
    data = await file.read(CLONE_MAX_BYTES + 1)
    if not data:
        raise HTTPException(400, "The file is empty.")
    if len(data) > CLONE_MAX_BYTES:
        raise HTTPException(400, "The file must be under 50 MB.")
    form = {"name": name, "remove_background_noise": "true" if remove_background_noise else "false"}
    files = {"file": (file.filename or "voice.mp3", data, file.content_type or "application/octet-stream")}
    return _make_custom(ctx, "clone",
                        lambda: b2v.request("POST", "/api/voices/clone", data=form, files=files, timeout=180))


@router.get("/custom/{custom_id}/preview")
def custom_preview(custom_id: int, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    row = b2v_access.owned_custom_voice(ctx, custom_id)
    if row.preview_url:
        return {"preview_url": row.preview_url, "ready": True}
    with upstream():
        result = b2v.request("GET", f"/api/voices/custom/{custom_id}/preview") or {}
    if result.get("preview_url"):
        row.preview_url = result["preview_url"]
        saved = ctx.db.get(UserSavedVoice, {"workspace_id": ctx.workspace.id, "voice_id": row.voice_id})
        if saved:
            saved.preview_url = row.preview_url
        ctx.db.commit()
    return {"preview_url": result.get("preview_url"), "ready": bool(result.get("ready"))}


@router.delete("/custom/{custom_id}")
def delete_custom(custom_id: int, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    row = b2v_access.owned_custom_voice(ctx, custom_id)
    try:
        with upstream():
            b2v.request("DELETE", f"/api/voices/custom/{custom_id}")
    except HTTPException as e:
        if e.status_code != 404:
            raise
    saved = ctx.db.get(UserSavedVoice, {"workspace_id": ctx.workspace.id, "voice_id": row.voice_id})
    if saved:
        ctx.db.delete(saved)
    ctx.db.delete(row)
    ctx.db.commit()
    video_limits.give_back(ctx.db, ctx.workspace.id, "custom_voices")
    return {"ok": True}


# Voice sample ★: a few seconds of the chosen voice with the chosen tuning


class SampleIn(BaseModel):
    voice_gender: Literal["female", "male"] = "female"
    voice_accent: str = Field("american", max_length=30)
    custom_voice_id: str | None = Field(None, max_length=100)
    voice_emotion: str | None = Field(None, max_length=200)
    video_style: str | None = Field(None, max_length=40)


@router.post("/sample")
def voice_sample(body: SampleIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    plan = video_limits.require_premium(ctx.db, ctx.workspace, "Voice samples")
    payload = body.model_dump(exclude_none=True)
    with upstream():  # checking the voice may need blog2video's catalog
        b2v_access.check_refs(ctx, {k: v for k, v in payload.items() if k != "voice_emotion"}, plan)
    video_limits.take(ctx.db, ctx.workspace, "voice_samples_daily", plan=plan)
    try:
        with upstream():
            audio, ctype = b2v.request("POST", "/api/voice/preview", json=payload, timeout=60, raw=True)
    except HTTPException:
        video_limits.give_back(ctx.db, ctx.workspace.id, "voice_samples_daily")
        raise
    return Response(audio, media_type=ctype or "audio/mpeg", headers={"Cache-Control": "no-store"})

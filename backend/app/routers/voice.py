import re
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.auth import Ctx, get_ctx
from app.config import settings
from app.models import Document, Job, Upload, VoiceConsent, VoiceProfile
from app.services import tts
from app.services.jobs import create_job, record_usage, serialize_job
from app.services.plans import effective_plan
from app.services.storage import storage

router = APIRouter(prefix="/api/voice", tags=["voice"])

CONSENT_TEXT = (
    "I confirm this recording is my own voice. I allow Notestack to create a synthetic copy of it with "
    "ElevenLabs, only for audio and video made in my workspace. I can revoke this at any time, which deletes "
    "the synthetic voice."
)
PREVIEW_LINE = "Here is how I sound reading your archive. Every line I say comes from something you wrote."


class BuildIn(BaseModel):
    document_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)


class DeliveryIn(BaseModel):
    stability: float = Field(0.45, ge=0, le=1)
    similarity_boost: float = Field(0.8, ge=0, le=1)
    style: float = Field(0.2, ge=0, le=1)
    speed: float = Field(1.0, ge=0.7, le=1.2)


class ProfileIn(BaseModel):
    profile: dict | None = None
    host_voices: dict[str, str] | None = None
    delivery: dict[str, DeliveryIn] | None = None  # per host: {"host_a": {...}, "host_b": {...}}


class ConsentIn(BaseModel):
    upload_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)
    upload_id: uuid.UUID | None = None  # single sample (older clients)
    agreed: bool
    consent_text: str
    remove_background_noise: bool = True


class PreviewIn(BaseModel):
    voice_id: str = Field(min_length=5, max_length=60)
    text: str | None = Field(None, max_length=400)
    host: str | None = None  # use that host's saved delivery settings
    delivery: DeliveryIn | None = None


class LibraryAddIn(BaseModel):
    public_owner_id: str = Field(min_length=5, max_length=100)
    voice_id: str = Field(min_length=5, max_length=60)
    name: str = Field(min_length=1, max_length=100)
    use_as: str | None = None  # "host_a" | "host_b"


def _profile(ctx: Ctx) -> VoiceProfile | None:
    return ctx.db.scalar(select(VoiceProfile).where(VoiceProfile.workspace_id == ctx.workspace.id))


def _ensure_profile(ctx: Ctx) -> VoiceProfile:
    vp = _profile(ctx)
    if not vp:
        vp = VoiceProfile(workspace_id=ctx.workspace.id)
        ctx.db.add(vp)
    return vp


def _consent(ctx: Ctx) -> VoiceConsent | None:
    return ctx.db.scalar(
        select(VoiceConsent).where(VoiceConsent.workspace_id == ctx.workspace.id, VoiceConsent.revoked_at.is_(None))
        .order_by(VoiceConsent.created_at.desc())
    )


def _clone_job(ctx: Ctx, consent: VoiceConsent) -> Job | None:
    return ctx.db.scalar(
        select(Job).where(Job.workspace_id == ctx.workspace.id, Job.kind == "voice_clone")
        .order_by(Job.created_at.desc()).limit(1)
    )


def _serialize(ctx: Ctx) -> dict:
    vp = _profile(ctx)
    consent = _consent(ctx)
    plan = effective_plan(ctx.db, ctx.workspace)
    voices = (vp.host_voices if vp else None) or {}
    delivery = voices.get("settings") or {}
    job = _clone_job(ctx, consent) if consent else None
    preview_key = (job.result or {}).get("preview_key") if job and job.status == "done" else None
    return {
        "profile": vp.profile_json if vp else None,
        "sample_doc_ids": vp.sample_doc_ids if vp else [],
        "updated_at": vp.updated_at.isoformat() if vp and vp.updated_at else None,
        "host_voices": {"host_a": voices.get("host_a") or settings.elevenlabs_voice_a,
                        "host_b": voices.get("host_b") or settings.elevenlabs_voice_b},
        "delivery": {h: tts.VoiceSettings.from_dict(delivery.get(h)).body() for h in ("host_a", "host_b")},
        "clone": {
            "allowed": plan.voice_cloning,
            "consent_text": CONSENT_TEXT,
            "status": ("ready" if consent and consent.elevenlabs_voice_id
                       else "failed" if consent and job and job.status == "failed"
                       else "processing" if consent else "none"),
            "voice_id": consent.elevenlabs_voice_id if consent else None,
            "created_at": consent.created_at.isoformat() if consent else None,
            "error": job.error if job and job.status == "failed" else None,
            "preview_url": storage.presign_get(preview_key) if preview_key else None,
        },
        "tts_configured": bool(settings.elevenlabs_api_key),
        "model": tts.model_id(),
        "models": tts.MODELS,
    }


@router.get("")
def get_voice(ctx: Ctx = Depends(get_ctx)):
    return _serialize(ctx)


@router.put("")
def update_voice(body: ProfileIn, ctx: Ctx = Depends(get_ctx)):
    vp = _ensure_profile(ctx)
    if body.profile is not None:
        vp.profile_json = body.profile
    voices = dict(vp.host_voices or {})
    if body.host_voices is not None:
        voices.update({k: v for k, v in body.host_voices.items() if k in ("host_a", "host_b") and v})
    if body.delivery is not None:
        saved = dict(voices.get("settings") or {})
        saved.update({h: d.model_dump() for h, d in body.delivery.items() if h in ("host_a", "host_b")})
        voices["settings"] = saved
    vp.host_voices = voices
    ctx.db.commit()
    return _serialize(ctx)


@router.post("/build")
def build(body: BuildIn, ctx: Ctx = Depends(get_ctx)):
    job = create_job(ctx.db, ctx.workspace.id, "voice_profile",
                     {"document_ids": [str(i) for i in body.document_ids]}, max_attempts=2)
    return serialize_job(job)


@router.get("/voices")
async def voices(ctx: Ctx = Depends(get_ctx)):
    items = await run_in_threadpool(tts.list_voices)
    consent = _consent(ctx)
    if consent and consent.elevenlabs_voice_id:
        items = [{**v, "name": f"{v['name']} (my voice)", "category": "my voice"}
                 if v["voice_id"] == consent.elevenlabs_voice_id else v for v in items]
        if not any(v["voice_id"] == consent.elevenlabs_voice_id for v in items):
            items = [{"voice_id": consent.elevenlabs_voice_id, "name": "My voice", "category": "my voice"}, *items]
    return items


@router.get("/library")
async def library(ctx: Ctx = Depends(get_ctx), search: str = "", gender: str = "", age: str = "",
                  accent: str = "", language: str = "", use_case: str = "", page: int = 0):
    if not settings.elevenlabs_api_key:
        raise HTTPException(503, "Set ELEVENLABS_API_KEY in .env to browse the voice library.")
    try:
        return await run_in_threadpool(lambda: tts.search_library(
            search=search, gender=gender, age=age, accent=accent, language=language, use_case=use_case,
            page=max(page, 0)))
    except tts.TTSError as exc:
        raise HTTPException(502, str(exc)) from exc


@router.post("/library/add")
async def add_from_library(body: LibraryAddIn, ctx: Ctx = Depends(get_ctx)):
    try:
        voice_id = await run_in_threadpool(tts.add_library_voice, body.public_owner_id, body.voice_id, body.name)
    except tts.TTSError as exc:
        raise HTTPException(502, str(exc)) from exc
    if body.use_as in ("host_a", "host_b"):
        vp = _ensure_profile(ctx)
        vp.host_voices = {**(vp.host_voices or {}), body.use_as: voice_id}
        ctx.db.commit()
    return {"voice_id": voice_id, **_serialize(ctx)}


@router.post("/preview")
async def preview(body: PreviewIn, ctx: Ctx = Depends(get_ctx)):
    """Speak a short line in any voice with the given (or a host's saved) delivery. Cached, metered."""
    if not settings.elevenlabs_api_key:
        raise HTTPException(503, "Set ELEVENLABS_API_KEY in .env to preview voices.")
    if body.delivery:
        vs = tts.VoiceSettings.from_dict(body.delivery.model_dump())
    else:
        saved = (((_profile(ctx) or VoiceProfile()).host_voices or {}).get("settings") or {}).get(body.host or "")
        vs = tts.VoiceSettings.from_dict(saved)
    text = (body.text or PREVIEW_LINE).strip()[:400]
    try:
        clip = await run_in_threadpool(tts.synthesize, ctx.workspace.id, text, body.voice_id, vs)
    except tts.TTSError as exc:
        raise HTTPException(502, str(exc)) from exc
    key = f"ws/{ctx.workspace.id}/voice-previews/{uuid.uuid4().hex}.mp3"
    storage.put_bytes(key, clip, "audio/mpeg")
    record_usage(ctx.db, workspace_id=ctx.workspace.id, kind="tts", provider="elevenlabs",
                 quantity=round(tts.mp3_seconds(clip), 1), unit="seconds")
    return {"url": storage.presign_get(key), "seconds": round(tts.mp3_seconds(clip), 1)}


@router.get("/reading-script")
def reading_script(ctx: Ctx = Depends(get_ctx)):
    """About two minutes of the writer's own prose to read aloud for the clone (their words, their rhythm)."""
    doc = ctx.db.scalar(
        select(Document).where(Document.workspace_id == ctx.workspace.id, Document.clean_text != "")
        .order_by(func.length(Document.clean_text).desc()).limit(1)
    )
    if not doc:
        text = ("Writing is how I think out loud. I start with a question I cannot answer yet, then I follow it "
                "until the answer surprises me. Some weeks that takes a paragraph; some weeks it takes a month. "
                "What matters is that every sentence earns its place, and that the reader leaves with something "
                "they did not have when they arrived.")
        return {"title": "Sample passage", "text": text, "words": len(text.split())}
    paragraphs = [p for p in re.split(r"\n\s*\n", doc.clean_text) if len(p.split()) > 12 and not p.startswith("## ")]
    picked, words = [], 0
    for p in paragraphs:
        picked.append(p.strip())
        words += len(p.split())
        if words >= 280:  # roughly two minutes read aloud
            break
    if not picked:  # short or list heavy posts: read the text as is
        plain = re.sub(r"^## .*$", "", doc.clean_text, flags=re.M).split()
        picked, words = [" ".join(plain[:280])], min(len(plain), 280)
    return {"title": doc.title, "text": "\n\n".join(picked), "words": words}


@router.get("/quota")
async def quota(ctx: Ctx = Depends(get_ctx)):
    if not settings.elevenlabs_api_key:
        return {}
    return await run_in_threadpool(tts.subscription)


@router.post("/consent")
def give_consent(body: ConsentIn, request: Request, ctx: Ctx = Depends(get_ctx)):
    if not effective_plan(ctx.db, ctx.workspace).voice_cloning:
        raise HTTPException(402, {"code": "plan_limit", "message": "Voice cloning is on the Writer and Studio plans."})
    if not body.agreed or body.consent_text.strip() != CONSENT_TEXT:
        raise HTTPException(400, "Please read and accept the consent statement.")
    if not settings.elevenlabs_api_key:
        raise HTTPException(503, "Voice cloning needs ELEVENLABS_API_KEY in .env")
    ids = body.upload_ids or ([body.upload_id] if body.upload_id else [])
    uploads = ctx.db.scalars(select(Upload).where(Upload.id.in_(ids), Upload.workspace_id == ctx.workspace.id)).all()
    uploads = [u for u in uploads if u.status == "complete" and u.content_type.startswith("audio/")]
    if not uploads:
        raise HTTPException(400, "Record or upload at least one audio sample first.")
    # A new clone replaces the previous one.
    old = _consent(ctx)
    if old:
        old.revoked_at = datetime.now(UTC)
    consent = VoiceConsent(workspace_id=ctx.workspace.id, user_id=ctx.user.id, sample_key=uploads[0].key,
                           consent_text=CONSENT_TEXT, ip_address=request.client.host if request.client else None)
    ctx.db.add(consent)
    ctx.db.commit()
    job = create_job(ctx.db, ctx.workspace.id, "voice_clone", {
        "consent_id": str(consent.id), "sample_keys": [u.key for u in uploads],
        "remove_background_noise": body.remove_background_noise,
        "replaces_voice_id": old.elevenlabs_voice_id if old else None,
    }, max_attempts=1)
    return {"job": serialize_job(job), **_serialize(ctx)}


@router.delete("/consent")
async def revoke_consent(ctx: Ctx = Depends(get_ctx)):
    consent = _consent(ctx)
    if not consent:
        return _serialize(ctx)
    if consent.elevenlabs_voice_id and settings.elevenlabs_api_key:
        try:
            await run_in_threadpool(tts.delete_voice, consent.elevenlabs_voice_id)
        except tts.TTSError:
            pass
    consent.revoked_at = datetime.now(UTC)
    storage.delete(consent.sample_key)
    vp = _profile(ctx)
    if vp and vp.host_voices:
        vp.host_voices = {k: v for k, v in vp.host_voices.items() if v != consent.elevenlabs_voice_id}
    ctx.db.commit()
    return _serialize(ctx)

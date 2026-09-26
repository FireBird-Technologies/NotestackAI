import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.config import settings
from app.models import Upload, VoiceConsent, VoiceProfile
from app.services import tts
from app.services.jobs import create_job, serialize_job
from app.services.plans import effective_plan
from app.services.storage import storage

router = APIRouter(prefix="/api/voice", tags=["voice"])

CONSENT_TEXT = (
    "I confirm this recording is my own voice. I allow Notestack to create a synthetic copy of it with "
    "ElevenLabs, only for audio and video made in my workspace. I can revoke this at any time, which deletes "
    "the synthetic voice."
)


class BuildIn(BaseModel):
    document_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)


class ProfileIn(BaseModel):
    profile: dict | None = None
    host_voices: dict[str, str] | None = None


class ConsentIn(BaseModel):
    upload_id: uuid.UUID
    agreed: bool
    consent_text: str


def _profile(ctx: Ctx) -> VoiceProfile | None:
    return ctx.db.scalar(select(VoiceProfile).where(VoiceProfile.workspace_id == ctx.workspace.id))


def _consent(ctx: Ctx) -> VoiceConsent | None:
    return ctx.db.scalar(
        select(VoiceConsent).where(VoiceConsent.workspace_id == ctx.workspace.id, VoiceConsent.revoked_at.is_(None))
        .order_by(VoiceConsent.created_at.desc())
    )


def _serialize(ctx: Ctx) -> dict:
    vp = _profile(ctx)
    consent = _consent(ctx)
    plan = effective_plan(ctx.db, ctx.workspace)
    voices = (vp.host_voices if vp else None) or {}
    return {
        "profile": vp.profile_json if vp else None,
        "sample_doc_ids": vp.sample_doc_ids if vp else [],
        "updated_at": vp.updated_at.isoformat() if vp and vp.updated_at else None,
        "host_voices": {"host_a": voices.get("host_a") or settings.elevenlabs_voice_a,
                        "host_b": voices.get("host_b") or settings.elevenlabs_voice_b},
        "clone": {
            "allowed": plan.voice_cloning,
            "consent_text": CONSENT_TEXT,
            "status": ("ready" if consent and consent.elevenlabs_voice_id else "processing" if consent else "none"),
            "voice_id": consent.elevenlabs_voice_id if consent else None,
            "created_at": consent.created_at.isoformat() if consent else None,
        },
        "tts_configured": bool(settings.elevenlabs_api_key),
    }


@router.get("")
def get_voice(ctx: Ctx = Depends(get_ctx)):
    return _serialize(ctx)


@router.put("")
def update_voice(body: ProfileIn, ctx: Ctx = Depends(get_ctx)):
    vp = _profile(ctx)
    if not vp:
        vp = VoiceProfile(workspace_id=ctx.workspace.id)
        ctx.db.add(vp)
    if body.profile is not None:
        vp.profile_json = body.profile
    if body.host_voices is not None:
        vp.host_voices = {k: v for k, v in body.host_voices.items() if k in ("host_a", "host_b") and v}
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
    if consent and consent.elevenlabs_voice_id and not any(v["voice_id"] == consent.elevenlabs_voice_id for v in items):
        items = [{"voice_id": consent.elevenlabs_voice_id, "name": "My voice", "category": "cloned"}, *items]
    return items


@router.post("/consent")
def give_consent(body: ConsentIn, request: Request, ctx: Ctx = Depends(get_ctx)):
    if not effective_plan(ctx.db, ctx.workspace).voice_cloning:
        raise HTTPException(402, {"code": "plan_limit", "message": "Voice cloning is on the Writer and Studio plans."})
    if not body.agreed or body.consent_text.strip() != CONSENT_TEXT:
        raise HTTPException(400, "Please read and accept the consent statement.")
    if not settings.elevenlabs_api_key:
        raise HTTPException(503, "Voice cloning needs ELEVENLABS_API_KEY in .env")
    upload = ctx.db.scalar(select(Upload).where(Upload.id == body.upload_id, Upload.workspace_id == ctx.workspace.id))
    if not upload or upload.status != "complete" or not upload.content_type.startswith("audio/"):
        raise HTTPException(400, "Upload an audio recording first.")
    consent = VoiceConsent(workspace_id=ctx.workspace.id, user_id=ctx.user.id, sample_key=upload.key,
                           consent_text=CONSENT_TEXT, ip_address=request.client.host if request.client else None)
    ctx.db.add(consent)
    ctx.db.commit()
    job = create_job(ctx.db, ctx.workspace.id, "voice_clone", {"consent_id": str(consent.id)}, max_attempts=1)
    return {"job": serialize_job(job), **_serialize(ctx)}


@router.delete("/consent")
async def revoke_consent(ctx: Ctx = Depends(get_ctx)):
    consent = _consent(ctx)
    if not consent:
        return _serialize(ctx)
    if consent.elevenlabs_voice_id and settings.elevenlabs_api_key:
        try:
            await run_in_threadpool(tts.delete_voice, consent.elevenlabs_voice_id)
        except Exception:
            pass
    consent.revoked_at = datetime.now(UTC)
    storage.delete(consent.sample_key)
    vp = _profile(ctx)
    if vp and vp.host_voices:
        vp.host_voices = {k: v for k, v in vp.host_voices.items() if v != consent.elevenlabs_voice_id}
    ctx.db.commit()
    return _serialize(ctx)

"""The workspace's own ElevenLabs voices, made or added on the Voice page: its clone, designed voices, and voices added
from the ElevenLabs library. blog2video speaks with the same ElevenLabs account, so these can be used in videos too
(as `custom_voice_id`); video_voices lists them and b2v_access accepts them."""

import uuid

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import UserSavedVoice, VoiceConsent, VoiceProfile


def notestack_voices(db: Session, workspace_id: uuid.UUID) -> list[dict]:
    """[{voice_id, name, kind}], kind: clone | designed | library. The clone first, no repeats."""
    out: list[dict] = []
    consent = db.scalar(select(VoiceConsent).where(VoiceConsent.workspace_id == workspace_id,
                                                   VoiceConsent.revoked_at.is_(None))
                        .order_by(VoiceConsent.created_at.desc()))
    if consent and consent.elevenlabs_voice_id:
        out.append({"voice_id": consent.elevenlabs_voice_id, "name": "My voice", "kind": "clone"})
    vp = db.scalar(select(VoiceProfile).where(VoiceProfile.workspace_id == workspace_id))
    voices = (vp.host_voices if vp else None) or {}
    for kind, key in (("designed", "custom"), ("library", "added")):
        for v in voices.get(key) or []:
            if v.get("voice_id") and all(o["voice_id"] != v["voice_id"] for o in out):
                out.append({"voice_id": v["voice_id"], "name": v.get("name") or "Voice", "kind": kind})
    return out


def is_notestack_voice(db: Session, workspace_id: uuid.UUID, voice_id: str) -> bool:
    return any(v["voice_id"] == voice_id for v in notestack_voices(db, workspace_id))


def forget_video_voice(db: Session, workspace_id: uuid.UUID, voice_id: str) -> None:
    """A Notestack voice that is gone (clone revoked) leaves the workspace's saved video voices too."""
    db.execute(delete(UserSavedVoice).where(UserSavedVoice.workspace_id == workspace_id,
                                            UserSavedVoice.voice_id == voice_id))

"""The workspace's own ElevenLabs voices, made or added on the Voice page: its clone, designed voices, and voices added
from the ElevenLabs library. They speak audio overviews; video_voices lists them with the workspace's saved voices."""

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


def save_notestack_voice(db: Session, workspace_id: uuid.UUID, voice_id: str, name: str) -> UserSavedVoice:
    """Put a Notestack voice in the workspace's voices (the one list for audio and video), once. Saving needs no plan; it speaks audio
    overviews (a video uses the free built-in voices). No preview link: it is played through /api/voice/preview.
    The caller commits."""
    row = db.get(UserSavedVoice, {"workspace_id": workspace_id, "voice_id": voice_id})
    if row is None:
        row = UserSavedVoice(workspace_id=workspace_id, voice_id=voice_id, name=(name or "Voice")[:255], premium=True,
                             is_custom=True)
        db.add(row)
    return row


def forget_video_voice(db: Session, workspace_id: uuid.UUID, voice_id: str) -> None:
    """A Notestack voice that is gone (clone revoked) leaves the workspace's saved video voices too."""
    db.execute(delete(UserSavedVoice).where(UserSavedVoice.workspace_id == workspace_id,
                                            UserSavedVoice.voice_id == voice_id))

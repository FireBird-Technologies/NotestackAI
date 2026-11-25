"""Deleted accounts, 30 days on: everything the person made or connected is removed for good (App Store 5.1.1(v),
Google Play's account deletion policy). Only the users row is kept, signed out and unusable, as a record that the
account existed and was deleted. Runs from the worker's daily cleanup and sends nothing to anyone.

Deleted from the iOS app there is no wait and no record: everything goes at once, the users row included
(erase_requested_accounts).
"""

import logging
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import Table, delete, select, update
from sqlalchemy.orm import Session

from app.config import settings
from app.db import Base
from app.models import B2VVideo, EmailVerificationCode, Upload, User, VoiceConsent, VoiceProfile, Workspace
from app.services import blog2video as b2v
from app.services import tts
from app.services.storage import storage

log = logging.getLogger(__name__)

PURGE_AFTER = timedelta(days=30)

# Kept: the account record itself, the workspaces table (its rows are deleted at the end, after their contents), the
# plan catalog, and Stripe's processed event ids (no personal data, they stop a retried webhook being handled twice).
_KEEP = {"users", "workspaces", "plans", "billing_events"}


def purge_deleted_accounts(db: Session, now: datetime | None = None) -> int:
    """Purge every account deleted more than PURGE_AFTER ago and not purged yet. Returns how many were purged."""
    cutoff = (now or datetime.now(UTC)) - PURGE_AFTER
    due = db.scalars(
        select(User).where(User.deleted_at.is_not(None), User.deleted_at < cutoff, User.purged_at.is_(None),
                           User.erase_requested_at.is_(None))
    ).all()
    purged = 0
    for user in due:
        try:
            purge_account(db, user)
            db.commit()
            purged += 1
        except Exception:
            db.rollback()
            log.exception("Could not purge deleted account %s; trying again tomorrow", user.id)
    return purged


def erase_requested_accounts(db: Session, only: uuid.UUID | None = None, later: Callable | None = None) -> int:
    """Erase the accounts deleted from the iOS app: called by the deletion itself (`only`), and by the worker for any
    that could not finish then. Returns how many were erased. `later` runs a call after the response: blog2video takes
    long to delete a video, and the person should not wait on it."""
    due = select(User.id).where(User.erase_requested_at.is_not(None), User.deleted_at.is_not(None))
    if only:
        due = due.where(User.id == only)
    erased = 0
    for user_id in db.scalars(due).all():
        try:
            user = db.get(User, user_id)
            if user is None:
                continue
            videos = _video_ids(db, user_id)
            _erase(db, user)
            db.commit()
            erased += 1
            if videos:
                later(_delete_videos, videos) if later else _delete_videos(videos)
        except Exception:
            db.rollback()
            log.exception("Could not erase deleted account %s; trying again soon", user_id)
    return erased


def _erase(db: Session, user: User) -> None:
    user_id, email = user.id, user.email
    owned = list(db.scalars(select(Workspace.id).where(Workspace.owner_id == user_id)))
    _delete_cloned_voices(db, owned, user_id=user_id)
    _delete_designed_voices(db, owned)
    db.execute(delete(EmailVerificationCode).where(EmailVerificationCode.email == email))
    # What the person left in a workspace someone else owns: their voice goes, files they added stay with its owner.
    db.execute(delete(VoiceConsent).where(VoiceConsent.user_id == user_id))
    owner = select(Workspace.owner_id).where(Workspace.id == Upload.workspace_id).scalar_subquery()
    others = Upload.workspace_id.not_in(owned) if owned else Upload.workspace_id.is_not(None)
    db.execute(update(Upload).where(Upload.user_id == user_id, others).values(user_id=owner)
               .execution_options(synchronize_session=False))
    purge_account(db, user)
    db.flush()
    for table in Base.metadata.sorted_tables:
        for fk in table.foreign_keys:
            if fk.column.table.name == "users" and fk.ondelete == "SET NULL":
                db.execute(update(table).where(fk.parent == user_id).values({fk.parent.name: None}))
    db.expunge(user)
    db.execute(delete(User).where(User.id == user_id))


def _video_ids(db: Session, user_id: uuid.UUID) -> list[int]:
    return list(db.scalars(
        select(B2VVideo.b2v_video_id).join(Workspace, Workspace.id == B2VVideo.workspace_id)
        .where(Workspace.owner_id == user_id, B2VVideo.b2v_video_id.is_not(None))
    ))


def _delete_videos(video_ids: list[int]) -> None:
    """The videos also live at blog2video. Best effort: everything here is already gone."""
    if not b2v.configured():
        return
    for video_id in video_ids:
        try:
            b2v.delete_project(video_id)
        except Exception:
            log.warning("Could not delete blog2video video %s of an erased account", video_id)


def purge_account(db: Session, user: User) -> None:
    """Remove the account's data: its workspaces with all their content and files, the voices it cloned, and every
    row tied to the person. The users row stays with the email, the dates and the Google / Apple ids (so signing in
    there again is still refused as a deleted account, not taken as a new one); the rest of it is cleared."""
    owned = list(db.scalars(select(Workspace.id).where(Workspace.owner_id == user.id)))

    _delete_cloned_voices(db, owned)
    for workspace_id in owned:
        storage.delete_prefix(f"ws/{workspace_id}/")

    # Children before parents (reverse dependency order), so nothing is left pointing at a deleted row.
    for table in reversed(Base.metadata.sorted_tables):
        if table.name in _KEEP:
            continue
        if owned:
            _delete_workspace_rows(db, table, owned)
        if _personal(table):
            db.execute(delete(table).where(table.c.user_id == user.id))
    if owned:
        db.execute(delete(Workspace).where(Workspace.id.in_(owned)))

    user.name = None
    user.avatar_url = None
    user.password_hash = None
    user.apple_refresh_token = None
    user.is_active = False
    user.token_version += 1
    user.purged_at = datetime.now(UTC)


def _delete_workspace_rows(db: Session, table: Table, owned: list[uuid.UUID]) -> None:
    if "workspace_id" in table.c:
        db.execute(delete(table).where(table.c.workspace_id.in_(owned)))
        return
    # A child with no workspace_id of its own (a link table, say): its rows that point at a workspace's rows.
    for fk in table.foreign_keys:
        parent = fk.column.table
        if parent.name != "workspaces" and "workspace_id" in parent.c:
            in_owned = select(fk.column).where(parent.c.workspace_id.in_(owned))
            db.execute(delete(table).where(fk.parent.in_(in_owned)))


def _personal(table: Table) -> bool:
    """Rows that belong to the person and go with the account (its sessions, grants, memberships, email records).
    A user_id that is set null or kept on delete marks who did something in a workspace, which goes with the
    workspace instead."""
    if "user_id" not in table.c:
        return False
    return any(fk.column.table.name == "users" and fk.ondelete == "CASCADE" for fk in table.c.user_id.foreign_keys)


def _delete_cloned_voices(db: Session, owned: list[uuid.UUID], user_id: uuid.UUID | None = None) -> None:
    """Voices cloned from the person's recordings live at ElevenLabs too. Best effort: the rest is purged anyway."""
    if not (owned or user_id) or not settings.elevenlabs_api_key:
        return
    theirs = VoiceConsent.workspace_id.in_(owned)
    if user_id:
        theirs = theirs | (VoiceConsent.user_id == user_id)
    voice_ids = db.scalars(select(VoiceConsent.elevenlabs_voice_id).where(
        theirs, VoiceConsent.elevenlabs_voice_id.is_not(None))).all()
    for voice_id in voice_ids:
        try:
            tts.delete_voice(voice_id)
        except Exception:
            log.warning("Could not delete ElevenLabs voice %s of a purged account", voice_id)


def _delete_designed_voices(db: Session, owned: list[uuid.UUID]) -> None:
    """Voices designed in the workspace live at ElevenLabs as well. Best effort, as the cloned ones."""
    if not owned or not settings.elevenlabs_api_key:
        return
    for voices in db.scalars(select(VoiceProfile.host_voices).where(VoiceProfile.workspace_id.in_(owned))).all():
        for voice in (voices or {}).get("custom") or []:
            try:
                tts.delete_voice(voice["voice_id"])
            except Exception:
                log.warning("Could not delete a designed ElevenLabs voice of an erased account")

"""Files users upload (ws/<workspace>/uploads/<upload id>/<name>): kept only while their upload record exists.

Deleting a record through the app removes its file at commit (app.models.content). The daily sweep catches the rest:
files whose record is gone (deleted straight in the database, or a delete that failed) and uploads that were started
but never finished."""

import logging
import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import Artifact, Upload, Workspace
from app.services.storage import storage

log = logging.getLogger("notestack.storage")

GRACE = timedelta(days=1)  # a file or a pending upload younger than this may still be on its way


def remove_upload_artifact(db: Session, a: Artifact) -> None:
    """An uploaded file or uploaded carousel is being deleted: remove its upload records and files. Caller commits."""
    if a.type == "carousel":
        ids = []
        for value in (a.content_json or {}).get("upload_ids") or []:
            try:
                ids.append(uuid.UUID(str(value)))
            except (TypeError, ValueError):
                continue
        if ids:
            for upload in db.scalars(select(Upload).where(Upload.id.in_(ids))):
                db.delete(upload)
        return
    if a.type == "upload" and a.storage_key:
        shared = db.scalar(select(Artifact.id).where(Artifact.storage_key == a.storage_key, Artifact.id != a.id).limit(1))
        if shared:
            return
        for up in db.scalars(select(Upload).where(Upload.key == a.storage_key)):
            db.delete(up)


def sweep_orphan_uploads(session_factory: Callable[[], Session] = SessionLocal) -> int:
    """Delete upload files with no upload record, and uploads still pending after a day. Returns files removed."""
    removed = 0
    cutoff = datetime.now(UTC) - GRACE
    with session_factory() as db:
        # Started but never finished: drop the record (its file, if any, goes at commit).
        for up in db.scalars(select(Upload).where(Upload.status == "pending", Upload.created_at < cutoff)):
            db.delete(up)
        db.commit()
        known = set(db.scalars(select(Upload.key)))
        for ws_id in db.scalars(select(Workspace.id)):
            try:
                files = storage.list_keys(f"ws/{ws_id}/uploads/")
            except Exception:
                log.warning("couldn't list uploads for workspace %s", ws_id, exc_info=True)
                continue
            for key, modified in files:
                if key in known or time.time() - modified < GRACE.total_seconds():
                    continue
                try:
                    storage.delete(key)
                    removed += 1
                except Exception:
                    log.warning("couldn't delete orphan upload %s", key, exc_info=True)
    if removed:
        log.info("removed %d upload files with no record", removed)
    return removed

"""Keeps our videos in line with blog2video: one mapping from blog2video's status to the artifact (and the b2v_videos
row and the allowance), used by the editor's poll, the lists and a background reconcile, so a change on blog2video
(a video that finished, failed or ran again while our server was down or nobody watched) shows everywhere.

Failed means blog2video says failed, nothing else: the `error` it reports alongside another status can be left over
from an earlier run. A first generation that failed is refunded and its item deleted, so the video never comes back
(blog2video removes the failed project itself). The b2v_videos row stays, marked deleted, as the record."""

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import Artifact, B2VVideo
from app.services import blog2video as b2v
from app.services import video_quota

log = logging.getLogger(__name__)

# blog2video status -> our artifact status (failed is FAILED below)
STATUS_MAP = {"awaiting_stock_footage_review": "review", "awaiting_script_review": "review", "rendering": "rendering"}
# blog2video's statuses while an edit job runs on a finished video, kept on the artifact as they are so the list and
# the editor can tell them from first generation: regenerating is a template switch (its relayout).
JOB_STATUSES = {"regenerating", "voice_regenerating", "language_regenerating", "script_regenerating"}
# Artifact statuses that may still change on blog2video's side: checked again by the lists and the reconcile.
BUSY_STATUSES = JOB_STATUSES | {"generating", "pending", "rendering"}
FAILED = video_quota.FAILED
FINISHED = video_quota.FINISHED
ROW_FIELDS = {"video_url", "preview_url", "title"}
RECONCILE_BATCH = 50
RECONCILE_AFTER = timedelta(minutes=1)  # a video just created is left to the request that made it


def store(db: Session, a: Artifact, row: B2VVideo | None = None, **fields) -> None:
    """Merge fields into content_json (and status), and the reference fields into the video's row, committing only
    when something changed."""
    if row is not None:
        for key in ROW_FIELDS & fields.keys():
            if fields[key] is not None and getattr(row, key) != fields[key]:
                setattr(row, key, fields[key])
                db.commit()
    content = dict(a.content_json or {})
    status = fields.pop("status", None)
    changed = {k: v for k, v in fields.items() if v is not None and content.get(k) != v}
    if changed or (status and status != a.status):
        a.content_json = {**content, **changed}
        if status:
            a.status = status
        db.commit()


def artifact_status(raw: str, ready: bool = False) -> str:
    if raw in FAILED:
        return "failed"
    if raw in STATUS_MAP:
        return STATUS_MAP[raw]
    if raw in JOB_STATUSES:
        return raw
    if ready or raw in FINISHED:
        return "ready"
    return "generating"


def discard_failed(db: Session, a: Artifact | None, row: B2VVideo, raw: str = "failed") -> None:
    """A first generation that failed: give the video back once, then delete its item so it can not come back. The
    row stays as the record (status deleted, refunded), which _restore_missing_artifacts never rebuilds."""
    video_quota.refund(db, row, raw or "failed")
    db.execute(update(B2VVideo).where(B2VVideo.id == row.id).values(status="deleted", artifact_id=None,
                                                                    updated_at=datetime.now(UTC)))
    if a is not None:
        db.delete(a)
    db.commit()
    db.refresh(row)


def apply_status(db: Session, a: Artifact, row: B2VVideo, s: dict) -> str | None:
    """Bring the artifact and row in line with one blog2video status answer. Returns the artifact's status, or None
    when the video failed and was discarded (its artifact is gone)."""
    raw = str(s.get("status") or "")
    # The v1 status endpoint calls this `video_url`; some project/job responses use
    # `r2_video_url`. Treat both as the same finished MP4 so every caller sees it.
    video_url = s.get("video_url") or s.get("r2_video_url")
    status = artifact_status(raw, bool(s.get("ready")))
    if status == "failed" and row.quota_state != "kept":
        # The first generation failed (a finished video whose later edit failed keeps its charge and its item)
        discard_failed(db, a, row, raw)
        return None
    if status == "ready" and row.quota_state == "refunded":
        video_quota.recharge(db, row)  # marked failed before (a stale error), but blog2video finished it
    video_quota.record_status(db, row, raw)
    store(db, a, row, status=status, b2v_status=raw or None, step=s.get("step"), video_url=video_url,
          error=s.get("error") if status == "failed" else None)
    return status


def refresh_busy(db: Session, pairs: list[tuple[Artifact, B2VVideo]], limit: int = 10) -> set:
    """Ask blog2video about videos that may have changed (still generating, rendering, in an edit job, or failed), so
    one that finished or failed while nobody had it open shows its real state. A blog2video hiccup leaves the stored
    status. Returns the ids of artifacts deleted because their video failed."""
    gone = set()
    todo = [(a, r) for a, r in pairs if (a.status in BUSY_STATUSES or a.status == "failed")
            and r.b2v_video_id is not None][:limit]
    for a, row in todo:
        aid = a.id
        try:
            s = b2v.status(row.b2v_video_id, row.created_via)
        except b2v.NotFound:
            s = {"status": "failed", "error": "The video service lost this video."}
        except b2v.B2VError as e:
            log.info("status refresh for video %s skipped: %s", row.b2v_video_id, e)
            continue
        if apply_status(db, a, row, s) is None:
            gone.add(aid)
    return gone


def reconcile_videos(session_factory: Callable[[], Session] = SessionLocal) -> int:
    """Background: every video that may have changed on blog2video, whoever has it open (or nobody), least recently
    checked first. Also refunds creates that never got a blog2video id. Runs from PERIODIC. Returns how many changed."""
    if not b2v.configured():
        return 0
    now = datetime.now(UTC)
    changed = 0
    with session_factory() as db:
        # The create never got an answer and the request died before refunding
        for row in db.scalars(select(B2VVideo).where(B2VVideo.b2v_video_id.is_(None), B2VVideo.quota_state == "charged",
                                                     B2VVideo.created_at < now - video_quota.SWEEP_AFTER)).all():
            a = db.get(Artifact, row.artifact_id) if row.artifact_id else None
            discard_failed(db, a, row)
            changed += 1
        pairs = db.execute(
            select(Artifact, B2VVideo).join(B2VVideo, B2VVideo.artifact_id == Artifact.id)
            .where(B2VVideo.b2v_video_id.is_not(None), B2VVideo.status != "deleted",
                   Artifact.status.in_(BUSY_STATUSES | {"failed"}), Artifact.created_at < now - RECONCILE_AFTER)
            .order_by(B2VVideo.updated_at.asc()).limit(RECONCILE_BATCH)
        ).all()
        for a, row in pairs:
            before = a.status
            try:
                s = b2v.status(row.b2v_video_id, row.created_via)
            except b2v.NotFound:
                s = {"status": "failed", "error": "The video service lost this video."}
            except b2v.B2VError as e:
                log.warning("video reconcile: status of %s failed: %s", row.b2v_video_id, e)
                continue
            rid = row.id
            after = apply_status(db, a, row, s)
            if after != before:
                changed += 1
            # Checked now: the next run starts with the ones checked longest ago
            db.execute(update(B2VVideo).where(B2VVideo.id == rid).values(updated_at=datetime.now(UTC)))
            db.commit()
    return changed

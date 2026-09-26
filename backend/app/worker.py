"""Worker: runs queued jobs from the Postgres jobs table plus scheduled email batches.

Run: python -m app.worker

- Claims jobs with FOR UPDATE SKIP LOCKED, runs up to WORKER_CONCURRENCY at once in threads.
- Failed jobs retry with backoff up to max_attempts; jobs whose worker died (no heartbeat for
  JOB_STALE_SECONDS) are requeued.
- Periodic tasks take a Postgres advisory lock, so with several workers only one runs each tick.
"""

import logging
import os
import signal
import socket
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal, engine
from app.models import (
    Artifact,
    Job,
    Source,
    Subscription,
    UpdateEmail,
    UpdateEmailSend,
    Upload,
    User,
    VoiceConsent,
    VoiceProfile,
    Workspace,
    WorkspaceMember,
)
from app.pipeline import generate, launchkit, media
from app.pipeline.generate import NothingToDo
from app.pipeline.ingest import FeedNotFound, entry_from_upload, extract_article, ingest_source, store_entries
from app.services import launchpad, tts
from app.services.email import email_service
from app.services.email_verification import purge_old_codes
from app.services.jobs import claim_next, create_job, record_usage, retry_or_fail, stale_jobs, update_job
from app.services.plans import effective_plan
from app.services.renderer import PermanentJobError, request_render
from app.services.storage import keys, storage

log = logging.getLogger("notestack.worker")


@dataclass
class Done:
    result: dict = field(default_factory=dict)
    message: str = "Done"


HANDED_OFF = object()  # the job continues elsewhere (renderer) and reports back via callbacks


# Handlers: (db, job) -> Done | HANDED_OFF. Raise to trigger a retry.


def _after_import(db: Session, job: Job, workspace_id: uuid.UUID, changed: list[str]) -> None:
    """New or changed posts get mapped into the topic constellation automatically."""
    if changed and settings.llm_api_key:
        create_job(db, workspace_id, "topics", {"document_ids": changed}, max_attempts=2)


def handle_ingest(db: Session, job: Job):
    source = db.get(Source, uuid.UUID(job.params["source_id"]))
    if not source:
        return Done({"error": "source deleted"}, "Source no longer exists")
    plan = effective_plan(db, db.get(Workspace, source.workspace_id))
    try:
        result = ingest_source(db, source, job, max_posts=plan.indexed_posts)
    except Exception as exc:
        db.rollback()
        source.sync_status = "error"
        source.sync_error = str(exc)[:500]
        db.commit()
        if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (401, 403, 404, 410):
            raise PermanentJobError(f"The feed returned {exc.response.status_code}.") from exc
        raise
    _after_import(db, job, source.workspace_id, result.get("changed", []))
    return Done(result, f"All posts in orbit: {result['indexed']} new or updated")


def handle_import_url(db: Session, job: Job):
    source = db.get(Source, uuid.UUID(job.params["source_id"]))
    update_job(db, job, progress=0.1, message="Fetching the article")
    try:
        entry = extract_article(job.params["url"])
    except FeedNotFound as exc:
        raise PermanentJobError(str(exc)) from exc
    indexed, _, changed = store_entries(db, source, [entry])
    _after_import(db, job, source.workspace_id, [str(i) for i in changed])
    return Done({"indexed": indexed, "document_ids": [str(i) for i in changed]}, f"{entry.title[:80]} is in orbit")


def handle_import_upload(db: Session, job: Job):
    source = db.get(Source, uuid.UUID(job.params["source_id"]))
    upload = db.get(Upload, uuid.UUID(job.params["upload_id"]))
    update_job(db, job, progress=0.1, message=f"Reading {upload.filename}")
    entry = entry_from_upload(upload.filename, upload.content_type, storage.get_bytes(upload.key))
    if not entry.sections and not entry.html:
        raise PermanentJobError("We could not read any text in that file.")
    indexed, _, changed = store_entries(db, source, [entry])
    _after_import(db, job, source.workspace_id, [str(i) for i in changed])
    return Done({"indexed": indexed, "document_ids": [str(i) for i in changed]}, f"{entry.title[:80]} is in orbit")


def handle_topics(db: Session, job: Job):
    return Done(generate.extract_topics(db, job, job.workspace_id, job.params.get("document_ids")), "Topic map ready")


def handle_voice_profile(db: Session, job: Job):
    try:
        result = generate.build_voice_profile(db, job, job.workspace_id, job.params.get("document_ids") or [])
    except NothingToDo as exc:
        raise PermanentJobError(str(exc)) from exc
    return Done(result, "Voice profile ready")


def handle_voice_clone(db: Session, job: Job):
    consent = db.get(VoiceConsent, uuid.UUID(job.params["consent_id"]))
    if not consent or consent.revoked_at:
        return Done({}, "Consent was revoked")
    sample_keys = job.params.get("sample_keys") or [consent.sample_key]
    update_job(db, job, progress=0.15, message=f"Sending {len(sample_keys)} recording(s) to ElevenLabs")
    samples = []
    for key in sample_keys:
        head = storage.head(key) or {}
        samples.append((key.rsplit("/", 1)[-1], storage.get_bytes(key), head.get("ContentType") or "audio/webm"))
    owner = db.get(User, consent.user_id)
    try:
        voice_id = tts.clone_voice(f"{(owner.name if owner and owner.name else 'My')} (Notestack)", samples,
                                   remove_background_noise=bool(job.params.get("remove_background_noise", True)))
    except tts.TTSError as exc:
        raise PermanentJobError(str(exc)) from exc
    consent.elevenlabs_voice_id = voice_id
    db.commit()

    # Make the new voice host A and record a short preview so the writer can judge it straight away.
    update_job(db, job, progress=0.7, message="Recording a preview in your voice")
    vp = db.scalar(select(VoiceProfile).where(VoiceProfile.workspace_id == consent.workspace_id))
    if not vp:
        vp = VoiceProfile(workspace_id=consent.workspace_id)
        db.add(vp)
    vp.host_voices = {**(vp.host_voices or {}), "host_a": voice_id}
    db.commit()
    preview_text = job.params.get("preview_text") or (
        "Hi, this is my Notestack voice. From now on, my audio overviews and videos can sound like me.")
    preview_key = None
    try:
        clip = tts.synthesize(consent.workspace_id, preview_text[:600], voice_id)
        preview_key = storage.put_bytes(keys.artifact(consent.workspace_id, consent.id, "voice-preview", "mp3"),
                                        clip, "audio/mpeg")
        record_usage(db, workspace_id=consent.workspace_id, kind="tts", provider="elevenlabs",
                     quantity=round(tts.mp3_seconds(clip), 1), unit="seconds", job=job)
    except tts.TTSError:
        log.warning("voice preview failed for %s", voice_id, exc_info=True)
    return Done({"voice_id": voice_id, "preview_key": preview_key}, "Your voice is ready and set as host A")


def handle_resurface(db: Session, job: Job):
    return Done(generate.score_evergreen(db, job, job.workspace_id), "Evergreen scores updated")


def _artifact_handler(fn: Callable[[Session, Job, Artifact], object], done_message: str):
    def handler(db: Session, job: Job):
        artifact = db.get(Artifact, uuid.UUID(job.params["artifact_id"]))
        if not artifact:
            return Done({}, "Artifact was deleted")
        artifact.status = "generating"
        db.commit()
        try:
            result = fn(db, job, artifact)
        except (NothingToDo, tts.TTSError) as exc:
            raise PermanentJobError(str(exc)) from exc
        if result is None:
            return HANDED_OFF  # the renderer reports back through /api/internal/jobs/{id}/progress
        return Done(result if isinstance(result, dict) else {}, done_message)

    return handler


def handle_render(db: Session, job: Job):
    """Direct render of caller supplied props (POST /api/artifacts/{id}/render)."""
    artifact = db.get(Artifact, uuid.UUID(job.params["artifact_id"]))
    update_job(db, job, progress=0.01, message="T-minus: preparing render")
    request_render(job, artifact, job.params["composition"], job.params.get("props") or {})
    return HANDED_OFF


HANDLERS: dict[str, Callable[[Session, Job], object]] = {
    "ingest": handle_ingest,
    "import_url": handle_import_url,
    "import_upload": handle_import_upload,
    "topics": handle_topics,
    "voice_profile": handle_voice_profile,
    "voice_clone": handle_voice_clone,
    "resurface_scan": handle_resurface,
    "summary": _artifact_handler(generate.summarize_notebook, "Summary ready"),
    "audio_overview": _artifact_handler(media.audio_overview, "Audio overview ready"),
    "video": _artifact_handler(media.make_video, "Video ready"),
    "quote_card": _artifact_handler(media.make_quote_card, "Quote card ready"),
    "carousel": _artifact_handler(media.render_carousel, "Carousel ready"),
    "launch_kit": _artifact_handler(launchkit.build_launch_kit, "Launch Kit ready"),
    "render": handle_render,
}


def mark_artifact_failed(db: Session, job: Job, error: str) -> None:
    if job.artifact_id:
        artifact = db.get(Artifact, job.artifact_id)
        if artifact:
            artifact.status = "failed"
            artifact.content_json = {**(artifact.content_json or {}), "error": error[:500]}
            db.commit()


def run_job(
    job_id: uuid.UUID,
    session_factory: Callable[[], Session] = SessionLocal,
    handlers: dict | None = None,
) -> None:
    handlers = handlers or HANDLERS
    with session_factory() as db:
        job = db.get(Job, job_id)
        if not job:
            return
        handler = handlers.get(job.kind)
        if not handler:
            update_job(db, job, status="failed", error=f"No handler for job kind {job.kind!r}")
            return
        try:
            outcome = handler(db, job)
        except PermanentJobError as exc:
            db.rollback()
            job = db.get(Job, job_id)
            update_job(db, job, status="failed", error=str(exc), message=str(exc)[:500])
            mark_artifact_failed(db, job, str(exc))
            return
        except Exception as exc:
            log.exception("job %s (%s) attempt %s failed", job.id, job.kind, job.attempts)
            db.rollback()
            job = db.get(Job, job_id)
            if not retry_or_fail(db, job, f"{type(exc).__name__}: {exc}"):
                mark_artifact_failed(db, job, f"{type(exc).__name__}: {exc}")
            return
        if outcome is HANDED_OFF:
            return
        done = outcome if isinstance(outcome, Done) else Done()
        update_job(db, job, status="done", progress=1.0, message=done.message, result=done.result)


def recover_stale(session_factory: Callable[[], Session] = SessionLocal) -> int:
    with session_factory() as db:
        jobs = stale_jobs(db)
        for job in jobs:
            log.warning("job %s stale (worker %s), requeueing", job.id, job.locked_by)
            retry_or_fail(db, job, "Worker stopped responding")
        db.commit()
        return len(jobs)


# Periodic tasks


@contextmanager
def single_flight(name: str):
    """Postgres advisory lock on a dedicated connection; yields False if another worker holds it."""
    if engine.dialect.name != "postgresql":
        yield True
        return
    with engine.connect() as conn:
        got = conn.execute(text("SELECT pg_try_advisory_lock(hashtext(:n))"), {"n": name}).scalar()
        try:
            yield bool(got)
        finally:
            if got:
                conn.execute(text("SELECT pg_advisory_unlock(hashtext(:n))"), {"n": name})
                conn.commit()


def update_email_batch(session_factory: Callable[[], Session] = SessionLocal) -> None:
    """Sends one daily batch per scheduled campaign at its send hour (UTC)."""
    now = datetime.now(UTC)
    with session_factory() as db:
        campaigns = db.scalars(select(UpdateEmail).where(UpdateEmail.status.in_(["scheduled", "running"]))).all()
        for campaign in campaigns:
            hour = campaign.send_hour if campaign.send_hour >= 0 else settings.update_email_send_hour
            if now.hour != hour:
                continue
            if campaign.last_batch_at and campaign.last_batch_at.date() == now.date():
                continue
            already = select(UpdateEmailSend.user_id).where(UpdateEmailSend.update_email_id == campaign.id)
            q = select(User).where(
                User.is_active.is_(True), User.email_unsubscribed.is_(False), User.id.not_in(already)
            )
            if campaign.user_filter != "all":
                plans = {"paid": ["writer", "studio"]}.get(campaign.user_filter, [campaign.user_filter])
                q = (
                    q.join(WorkspaceMember, WorkspaceMember.user_id == User.id)
                    .join(Subscription, Subscription.workspace_id == WorkspaceMember.workspace_id)
                    .where(Subscription.plan.in_(plans))
                )
            users = db.scalars(q.limit(campaign.batch_size)).unique().all()
            campaign.status = "running"
            for user in users:
                ok = email_service.send_blast_email(
                    str(user.id), user.email, user.name, campaign.subject, campaign.body
                )
                db.add(UpdateEmailSend(update_email_id=campaign.id, user_id=user.id, status="sent" if ok else "failed"))
                campaign.sent_count += int(ok)
                campaign.failed_count += int(not ok)
            campaign.total_users = campaign.sent_count + campaign.failed_count
            campaign.last_batch_at = now
            if len(users) < campaign.batch_size:
                campaign.status = "completed"
            db.commit()


def daily_cleanup(session_factory: Callable[[], Session] = SessionLocal) -> None:
    with session_factory() as db:
        purge_old_codes(db)


@dataclass
class Periodic:
    name: str
    every_seconds: float
    fn: Callable[[], object]
    next_at: float = 0.0


PERIODIC = [
    Periodic("recover_stale", 60, recover_stale),
    Periodic("publish_due", 30, launchpad.publish_due),
    Periodic("sync_engagement", 3600, launchpad.sync_engagement),
    Periodic("update_email_batch", 300, update_email_batch),
    Periodic("daily_cleanup", 24 * 3600, daily_cleanup),
]


def run_periodic(now: float) -> None:
    for task in PERIODIC:
        if now < task.next_at:
            continue
        task.next_at = now + task.every_seconds
        try:
            with single_flight(task.name) as got:
                if got:
                    task.fn()
        except Exception:
            log.exception("periodic task %s failed", task.name)


# Main loop


def run_loop(stop: threading.Event, worker_id: str | None = None) -> None:
    """Claim and run jobs until `stop` is set. Used by the CLI and, in development, by the API."""
    worker_id = worker_id or f"{socket.gethostname()}:{os.getpid()}"
    pool = ThreadPoolExecutor(max_workers=settings.worker_concurrency, thread_name_prefix="job")
    running: set[Future] = set()
    log.info("worker %s up, concurrency=%s", worker_id, settings.worker_concurrency)

    while not stop.is_set():
        running = {f for f in running if not f.done()}
        run_periodic(time.monotonic())
        claimed = False
        while len(running) < settings.worker_concurrency and not stop.is_set():
            try:
                with SessionLocal() as db:
                    job_id = claim_next(db, worker_id)
            except Exception:
                log.exception("claim failed")
                break
            if not job_id:
                break
            running.add(pool.submit(run_job, job_id))
            claimed = True
        if not claimed:
            stop.wait(settings.worker_poll_seconds)

    log.info("worker %s stopping, waiting for %d running jobs", worker_id, len(running))
    pool.shutdown(wait=True)


def start_background(stop: threading.Event) -> threading.Thread:
    thread = threading.Thread(target=run_loop, args=(stop, f"api:{os.getpid()}"), name="worker", daemon=True)
    thread.start()
    return thread


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    run_loop(stop)


if __name__ == "__main__":
    main()

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
    User,
    Workspace,
    WorkspaceMember,
)
from app.pipeline.ingest import ingest_source
from app.services.email import email_service
from app.services.email_verification import purge_old_codes
from app.services.jobs import claim_next, retry_or_fail, stale_jobs, update_job
from app.services.plans import effective_plan
from app.services.storage import keys, storage

log = logging.getLogger("notestack.worker")


@dataclass
class Done:
    result: dict = field(default_factory=dict)
    message: str = "Done"


HANDED_OFF = object()  # the job continues elsewhere (renderer) and reports back via callbacks


# Handlers: (db, job) -> Done | HANDED_OFF. Raise to trigger a retry.


def handle_ingest(db: Session, job: Job):
    source = db.get(Source, uuid.UUID(job.params["source_id"]))
    if not source:
        return Done({"error": "source deleted"}, "Source no longer exists")
    plan = effective_plan(db, db.get(Workspace, source.workspace_id))
    try:
        result = ingest_source(db, source, job, max_posts=min(plan.indexed_posts, 200))
    except Exception as exc:
        db.rollback()
        source.sync_status = "error"
        source.sync_error = str(exc)[:500]
        db.commit()
        raise
    return Done(result, "All posts in orbit")


def handle_render(db: Session, job: Job):
    """Hand off to the Remotion renderer with a presigned PUT so it never holds R2 credentials."""
    p = job.params
    artifact = db.get(Artifact, uuid.UUID(p["artifact_id"]))
    ext = "png" if p["format"] == "png" else "mp4"
    key = keys.artifact(artifact.workspace_id, artifact.id, p["composition"].lower(), ext)
    content_type = "image/png" if ext == "png" else "video/mp4"
    update_job(db, job, progress=0.01, message="T-minus: preparing render")
    resp = httpx.post(
        f"{settings.renderer_url}/render",
        headers={"x-internal-token": settings.internal_token},
        json={
            "jobId": str(job.id),
            "compositionId": p["composition"],
            "props": p["props"],
            "format": p["format"],
            "uploadUrl": storage.presign_put(key, content_type, ttl=6 * 3600),
            "uploadContentType": content_type,
            "callbackUrl": f"{settings.api_url}/api/internal/jobs/{job.id}/progress",
            "storageKey": key,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return HANDED_OFF


HANDLERS: dict[str, Callable[[Session, Job], object]] = {
    "ingest": handle_ingest,
    "render": handle_render,
}


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
        except Exception as exc:
            log.exception("job %s (%s) attempt %s failed", job.id, job.kind, job.attempts)
            db.rollback()
            job = db.get(Job, job_id)
            retry_or_fail(db, job, f"{type(exc).__name__}: {exc}")
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


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    worker_id = f"{socket.gethostname()}:{os.getpid()}"
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())

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


if __name__ == "__main__":
    main()

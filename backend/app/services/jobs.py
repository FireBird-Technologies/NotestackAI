"""Jobs on Postgres: the jobs table is the queue, the progress record and the SSE source.

Enqueue = insert a queued row. Workers claim with FOR UPDATE SKIP LOCKED, so any number of worker
processes can poll the same table without double-running a job. Progress lives on the row, and the
SSE endpoint polls it.
"""

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime, timedelta

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import case, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.llm.languages import PARAM as APP_LANGUAGE_PARAM
from app.llm.languages import app_language, app_language_name
from app.models import Job, UsageEvent

TERMINAL = {"done", "failed"}


def utcnow() -> datetime:
    return datetime.now(UTC)


def serialize_job(job: Job) -> dict:
    return {
        "id": str(job.id),
        "kind": job.kind,
        "params": job.params,
        "status": job.status,
        "progress": job.progress,
        "message": job.message,
        "error": job.error,
        "result": job.result,
        "artifact_id": str(job.artifact_id) if job.artifact_id else None,
        "attempts": job.attempts,
        "cost_usd": job.cost_usd,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


# Producer side


def pending_job(db: Session, workspace_id: uuid.UUID, kind: str) -> bool:
    """A job of this kind is already queued or running for the workspace."""
    return db.scalar(select(Job.id).where(Job.workspace_id == workspace_id, Job.kind == kind,
                                          Job.status.in_(("queued", "running"))).limit(1)) is not None


def queue_for_documents(db: Session, workspace_id: uuid.UUID, kind: str, ids: list[str], **kw) -> Job | None:
    """Enqueue a per-post job (topics, ideas, post_cards) for these posts, or fold them into one of that kind still
    waiting in the queue (never tried yet), so a batch of uploads makes one job instead of one per file. A queued job with no
    document_ids already covers every post. SKIP LOCKED passes over a job a worker is claiming right now."""
    if not ids:
        return None
    params = with_app_language(kind, {"document_ids": ids})
    waiting = db.scalars(
        select(Job)
        .where(Job.workspace_id == workspace_id, Job.kind == kind, Job.status == "queued",
               Job.attempts == 0)  # not one waiting out a retry
        .order_by(Job.created_at)
        .with_for_update(skip_locked=True)
    ).all()
    for job in waiting:
        theirs = {k: v for k, v in (job.params or {}).items() if k != "document_ids"}
        if theirs != {k: v for k, v in params.items() if k != "document_ids"}:
            continue  # different options (another language, force): kept apart
        have = job.params.get("document_ids")
        if have is not None:
            job.params = {**job.params, "document_ids": list(dict.fromkeys([*have, *ids]))}
        db.commit()
        return job
    return create_job(db, workspace_id, kind, {"document_ids": ids}, **kw)


# Jobs whose pipeline takes params["language"] (falling back to the language of the sources when it is empty).
LANGUAGE_KINDS = frozenset({"quiz", "flashcards", "report", "report_block", "slide_deck", "audio_overview"})


def with_app_language(kind: str, params: dict) -> dict:
    """Carry the app language into the job: its code always (the worker restores it, so jobs the job starts inherit
    it), and its name as the default output language for kinds that take one. An explicit language wins."""
    code = app_language()
    if not code:
        return params
    out = {**params, APP_LANGUAGE_PARAM: code}
    if kind in LANGUAGE_KINDS and not str(params.get("language") or "").strip():
        out["language"] = app_language_name()
    return out


def create_job(
    db: Session,
    workspace_id: uuid.UUID,
    kind: str,
    params: dict | None = None,
    *,
    artifact_id: uuid.UUID | None = None,
    max_attempts: int = 3,
    run_after: datetime | None = None,
) -> Job:
    """Enqueue. The worker picks it up within WORKER_POLL_SECONDS, or after `run_after` when that is set."""
    job = Job(
        workspace_id=workspace_id,
        kind=kind,
        params=with_app_language(kind, params or {}),
        artifact_id=artifact_id,
        status="queued",
        max_attempts=max_attempts,
        run_after=run_after,
    )
    db.add(job)
    db.commit()
    return job


def update_job(
    db: Session,
    job: Job,
    *,
    status: str | None = None,
    progress: float | None = None,
    message: str | None = None,
    error: str | None = None,
    result: dict | None = None,
) -> None:
    """Every update is also a heartbeat, so a job that keeps reporting is never treated as stale."""
    if status:
        job.status = status
        if status in TERMINAL:
            job.finished_at = utcnow()
            job.locked_by = None
    if progress is not None:
        job.progress = max(0.0, min(1.0, progress))
    if message is not None:
        job.message = message
    if error is not None:
        job.error = error
    if result is not None:
        job.result = result
    job.heartbeat_at = utcnow()
    db.commit()


# Consumer side (worker)


# Imports someone is watching a progress bar for: taken before the background work earlier imports queued.
FOREGROUND_KINDS = ("ingest", "import_url", "import_upload")


def claim_next(db: Session, worker_id: str) -> uuid.UUID | None:
    """Atomically take the oldest runnable job, imports first. SKIP LOCKED lets parallel workers pass each other."""
    now = utcnow()
    job = db.scalar(
        select(Job)
        .where(Job.status == "queued", or_(Job.run_after.is_(None), Job.run_after <= now))
        .order_by(case((Job.kind.in_(FOREGROUND_KINDS), 0), else_=1), Job.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if not job:
        db.rollback()
        return None
    job.status = "running"
    job.attempts += 1
    job.locked_by = worker_id
    job.heartbeat_at = now
    job.run_after = None
    db.commit()
    return job.id


def backoff_seconds(attempt: int) -> int:
    return min(30 * 2 ** max(attempt - 1, 0), 900)  # 30s, 60s, 120s ... capped at 15 min


def retry_or_fail(db: Session, job: Job, error: str) -> bool:
    """Requeue with backoff if attempts remain. Returns True if it will retry."""
    if job.attempts < job.max_attempts:
        wait = backoff_seconds(job.attempts)
        job.status = "queued"
        job.locked_by = None
        job.run_after = utcnow() + timedelta(seconds=wait)
        update_job(db, job, error=error[:1000], message=f"Retrying in {wait}s")
        return True
    update_job(db, job, status="failed", error=error[:1000], message="Failed")
    return False


def stale_jobs(db: Session) -> list[Job]:
    cutoff = utcnow() - timedelta(seconds=settings.job_stale_seconds)
    return list(
        db.scalars(
            select(Job)
            .where(Job.status == "running", or_(Job.heartbeat_at.is_(None), Job.heartbeat_at < cutoff))
            .with_for_update(skip_locked=True)
        ).all()
    )


# Progress stream (API)


async def watch_job(
    session_factory: Callable[[], Session],
    job_id: uuid.UUID,
    interval: float = 1.0,
    max_seconds: float = 4 * 3600,
) -> AsyncIterator[str]:
    """Yield the serialized job whenever it changes, until it finishes. Polls the row."""

    def snapshot() -> dict | None:
        with session_factory() as db:
            job = db.get(Job, job_id)
            return serialize_job(job) if job else None

    last: dict | None = None
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max_seconds
    while loop.time() < deadline:
        data = await run_in_threadpool(snapshot)
        if data is None:
            return
        if data != last:
            yield json.dumps(data)
            last = data
        if data["status"] in TERMINAL:
            return
        await asyncio.sleep(interval)


def record_usage(
    db: Session,
    *,
    workspace_id: uuid.UUID,
    kind: str,
    provider: str,
    quantity: float,
    unit: str,
    model: str | None = None,
    cost_usd: float = 0.0,
    job: Job | None = None,
) -> None:
    db.add(
        UsageEvent(
            workspace_id=workspace_id,
            job_id=job.id if job else None,
            kind=kind,
            provider=provider,
            model=model,
            quantity=quantity,
            unit=unit,
            cost_usd=cost_usd,
        )
    )
    if job:
        job.cost_usd = (job.cost_usd or 0.0) + cost_usd
    db.commit()

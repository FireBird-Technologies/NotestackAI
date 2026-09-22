"""Job rows + progress fan-out over Redis pub/sub (consumed by the SSE endpoint)."""

import json
import uuid
from datetime import UTC, datetime

import redis
import redis.asyncio as aredis
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Job, UsageEvent

_sync_redis: redis.Redis | None = None


def _redis() -> redis.Redis:
    global _sync_redis
    if _sync_redis is None:
        _sync_redis = redis.Redis.from_url(settings.redis_url)
    return _sync_redis


def channel(job_id: uuid.UUID | str) -> str:
    return f"job:{job_id}"


def serialize_job(job: Job) -> dict:
    return {
        "id": str(job.id),
        "kind": job.kind,
        "status": job.status,
        "progress": job.progress,
        "message": job.message,
        "error": job.error,
        "result": job.result,
        "artifact_id": str(job.artifact_id) if job.artifact_id else None,
        "cost_usd": job.cost_usd,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


def create_job(db: Session, workspace_id: uuid.UUID, kind: str, params: dict | None = None) -> Job:
    job = Job(workspace_id=workspace_id, kind=kind, params=params or {})
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
    if status:
        job.status = status
        if status in {"done", "failed"}:
            job.finished_at = datetime.now(UTC)
    if progress is not None:
        job.progress = max(0.0, min(1.0, progress))
    if message is not None:
        job.message = message
    if error is not None:
        job.error = error
    if result is not None:
        job.result = result
    db.commit()
    try:
        _redis().publish(channel(job.id), json.dumps(serialize_job(job)))
    except redis.RedisError:
        pass  # progress is also readable from GET /jobs/{id}


async def subscribe(job_id: uuid.UUID):
    client = aredis.Redis.from_url(settings.redis_url)
    pubsub = client.pubsub()
    await pubsub.subscribe(channel(job_id))
    try:
        async for msg in pubsub.listen():
            if msg["type"] == "message":
                yield msg["data"].decode()
    finally:
        await pubsub.unsubscribe(channel(job_id))
        await client.aclose()


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

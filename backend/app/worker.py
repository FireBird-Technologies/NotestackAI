"""arq worker: long running jobs + scheduled email batches.

Run: arq app.worker.WorkerSettings
"""

import logging
import uuid
from datetime import UTC, datetime

import httpx
from arq import cron
from arq.connections import RedisSettings
from sqlalchemy import select

from app.config import settings
from app.db import SessionLocal
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
from app.services.jobs import update_job
from app.services.plans import effective_plan
from app.services.storage import keys, storage

log = logging.getLogger(__name__)


async def ingest_source_task(ctx, source_id: str, job_id: str) -> dict:
    with SessionLocal() as db:
        job = db.get(Job, uuid.UUID(job_id))
        source = db.get(Source, uuid.UUID(source_id))
        if not job or not source:
            return {"error": "missing"}
        try:
            plan = effective_plan(db, db.get(Workspace, source.workspace_id))
            result = ingest_source(db, source, job, max_posts=min(plan.indexed_posts, 200))
            update_job(db, job, status="done", progress=1.0, message="All posts in orbit", result=result)
            return result
        except Exception as exc:
            log.exception("ingest failed source=%s", source_id)
            db.rollback()
            source.sync_status = "error"
            source.sync_error = str(exc)[:500]
            update_job(db, job, status="failed", error=str(exc)[:1000], message="Ingestion failed")
            return {"error": str(exc)}


async def render_task(ctx, artifact_id: str, job_id: str, composition: str, props: dict, fmt: str) -> dict:
    """Hand off to the Remotion renderer with a presigned PUT so it never holds R2 credentials."""
    with SessionLocal() as db:
        job = db.get(Job, uuid.UUID(job_id))
        artifact = db.get(Artifact, uuid.UUID(artifact_id))
        ext = "png" if fmt == "png" else "mp4"
        key = keys.artifact(artifact.workspace_id, artifact.id, composition.lower(), ext)
        content_type = "image/png" if ext == "png" else "video/mp4"
        update_job(db, job, status="running", progress=0.01, message="T-minus: preparing render")
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{settings.renderer_url}/render",
                headers={"x-internal-token": settings.internal_token},
                json={
                    "jobId": job_id,
                    "compositionId": composition,
                    "props": props,
                    "format": fmt,
                    "uploadUrl": storage.presign_put(key, content_type, ttl=6 * 3600),
                    "uploadContentType": content_type,
                    "callbackUrl": f"{settings.api_url}/api/internal/jobs/{job_id}/progress",
                    "storageKey": key,
                },
            )
            resp.raise_for_status()
        return {"accepted": True, "key": key}


async def update_email_batch(ctx) -> None:
    """Hourly check; sends one daily batch per scheduled campaign at its send hour (UTC)."""
    now = datetime.now(UTC)
    with SessionLocal() as db:
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


async def daily_cleanup(ctx) -> None:
    with SessionLocal() as db:
        purge_old_codes(db)


async def startup(ctx) -> None:
    logging.basicConfig(level=logging.INFO)


class WorkerSettings:
    functions = [ingest_source_task, render_task]
    cron_jobs = [cron(update_email_batch, minute=5), cron(daily_cleanup, hour=3, minute=17)]
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    on_startup = startup
    max_jobs = 10
    job_timeout = 60 * 30

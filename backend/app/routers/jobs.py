import uuid

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import Ctx, get_ctx
from app.config import settings
from app.db import SessionLocal, get_db
from app.models import Artifact, Job
from app.services.jobs import record_usage, serialize_job, update_job, watch_job

router = APIRouter(prefix="/api", tags=["jobs"])


def _get(ctx: Ctx, job_id: uuid.UUID) -> Job:
    job = ctx.db.scalar(select(Job).where(Job.id == job_id, Job.workspace_id == ctx.workspace.id))
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@router.get("/jobs")
def list_jobs(ctx: Ctx = Depends(get_ctx), active: bool = False, kind: str | None = None, limit: int = 20):
    q = select(Job).where(Job.workspace_id == ctx.workspace.id)
    if active:
        q = q.where(Job.status.in_(["queued", "running"]))
    if kind:
        q = q.where(Job.kind.in_(kind.split(",")))
    jobs = ctx.db.scalars(q.order_by(Job.created_at.desc()).limit(min(limit, 100))).all()
    return [serialize_job(j) for j in jobs]


@router.get("/jobs/{job_id}")
def get_job(job_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    return serialize_job(_get(ctx, job_id))


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    _get(ctx, job_id)  # ownership check

    async def stream():
        async for data in watch_job(SessionLocal, job_id):
            yield f"data: {data}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


class ProgressIn(BaseModel):
    status: str | None = None
    progress: float | None = None
    message: str | None = None
    error: str | None = None
    render_seconds: float | None = None
    storage_key: str | None = None
    storage_keys: list[str] | None = None  # carousels: one PNG per slide


@router.post("/internal/jobs/{job_id}/progress", include_in_schema=False)
def renderer_progress(
    job_id: uuid.UUID,
    body: ProgressIn,
    x_internal_token: str = Header(...),
    db: Session = Depends(get_db),
):
    if x_internal_token != settings.internal_token:
        raise HTTPException(403, "Forbidden")
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    artifact = db.get(Artifact, job.artifact_id) if job.artifact_id else None
    if body.status == "failed" and artifact:
        artifact.status = "failed"
        artifact.content_json = {**(artifact.content_json or {}), "error": (body.error or "Render failed")[:500]}
    if body.status == "done" and artifact:
        if body.storage_keys:
            artifact.content_json = {**(artifact.content_json or {}), "slide_keys": body.storage_keys}
            artifact.storage_key = body.storage_keys[0]
            artifact.status = "ready"
        elif body.storage_key:
            artifact.storage_key = body.storage_key
            artifact.status = "ready"
        if body.render_seconds:
            record_usage(
                db, workspace_id=job.workspace_id, kind="render", provider="remotion",
                quantity=body.render_seconds, unit="seconds", job=job,
            )
    update_job(
        db, job, status=body.status, progress=body.progress, message=body.message, error=body.error,
        result={"storage_key": body.storage_key} if body.storage_key else None,
    )
    return {"ok": True}

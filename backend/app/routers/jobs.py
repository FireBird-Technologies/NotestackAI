import json
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import Ctx, get_ctx
from app.config import settings
from app.db import get_db
from app.models import Artifact, Job
from app.services.jobs import record_usage, serialize_job, subscribe, update_job

router = APIRouter(prefix="/api", tags=["jobs"])


def _get(ctx: Ctx, job_id: uuid.UUID) -> Job:
    job = ctx.db.scalar(select(Job).where(Job.id == job_id, Job.workspace_id == ctx.workspace.id))
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@router.get("/jobs/{job_id}")
def get_job(job_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    return serialize_job(_get(ctx, job_id))


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    job = _get(ctx, job_id)
    snapshot = serialize_job(job)

    async def stream():
        yield f"data: {json.dumps(snapshot)}\n\n"
        if snapshot["status"] in {"done", "failed"}:
            return
        async for data in subscribe(job_id):
            yield f"data: {data}\n\n"
            if json.loads(data).get("status") in {"done", "failed"}:
                return

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


class ProgressIn(BaseModel):
    status: str | None = None
    progress: float | None = None
    message: str | None = None
    error: str | None = None
    render_seconds: float | None = None
    storage_key: str | None = None


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
    if body.status == "done" and job.artifact_id:
        artifact = db.get(Artifact, job.artifact_id)
        if artifact and body.storage_key:
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

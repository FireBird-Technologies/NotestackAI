"""Artifacts are every generated thing (summaries, audio, video, launch kits, stills). Creating one always
means: artifact row + queued job, returned together so the UI can stream progress."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Artifact, Job
from app.services.jobs import create_job, serialize_job
from app.services.storage import storage

TYPE_LABELS = {
    "summary": "Summary",
    "audio_overview": "Audio overview",
    "video": "Video",
    "quote_card": "Quote card",
    "carousel": "Carousel",
    "launch_kit": "Launch Kit",
}


def start_artifact(
    db: Session,
    workspace_id: uuid.UUID,
    type_: str,
    *,
    title: str,
    notebook_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    content: dict | None = None,
    job_kind: str | None = None,
    params: dict | None = None,
    max_attempts: int = 2,
) -> tuple[Artifact, Job]:
    artifact = Artifact(workspace_id=workspace_id, type=type_, notebook_id=notebook_id, document_id=document_id,
                        status="pending", content_json={"title": title, **(content or {})})
    db.add(artifact)
    db.commit()
    job = create_job(db, workspace_id, job_kind or type_, {"artifact_id": str(artifact.id), **(params or {})},
                     artifact_id=artifact.id, max_attempts=max_attempts)
    return artifact, job


def latest_jobs(db: Session, artifact_ids: list[uuid.UUID]) -> dict[uuid.UUID, Job]:
    if not artifact_ids:
        return {}
    jobs = db.scalars(select(Job).where(Job.artifact_id.in_(artifact_ids)).order_by(Job.created_at)).all()
    return {j.artifact_id: j for j in jobs}  # later rows win, so this is the newest job per artifact


def serialize_artifact(a: Artifact, job: Job | None = None) -> dict:
    content = a.content_json or {}
    slides = content.get("slide_keys") or []
    return {
        "id": str(a.id),
        "type": a.type,
        "type_label": TYPE_LABELS.get(a.type, a.type),
        "title": content.get("title") or TYPE_LABELS.get(a.type, a.type),
        "status": a.status,
        "notebook_id": str(a.notebook_id) if a.notebook_id else None,
        "document_id": str(a.document_id) if a.document_id else None,
        "content": content,
        "storage_key": a.storage_key,
        "url": storage.presign_get(a.storage_key) if a.storage_key else None,
        "download_url": storage.presign_get(a.storage_key, download_name=_download_name(a)) if a.storage_key else None,
        "slide_urls": [storage.presign_get(k) for k in slides],
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "job": serialize_job(job) if job else None,
    }


def _download_name(a: Artifact) -> str:
    title = (a.content_json or {}).get("title") or a.type
    ext = (a.storage_key or "").rsplit(".", 1)[-1]
    return f"{title[:60]}.{ext}"

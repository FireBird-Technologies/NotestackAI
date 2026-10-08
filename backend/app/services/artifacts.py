"""Artifacts are every generated thing (summaries, audio, video, launch kits, stills). Creating one always
means: artifact row + queued job, returned together so the UI can stream progress."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from app.models import Artifact, Job
from app.services.jobs import create_job, serialize_job
from app.services.storage import storage
from app.slides.build import slots as slide_slots
from app.slides.build import view as slide_pages

TYPE_LABELS = {
    "summary": "Summary",
    "audio_overview": "Audio overview",
    "video": "Video",
    "quote_card": "Quote card",
    "carousel": "Carousel",
    "launch_kit": "Launch Kit",
    "mind_map": "Mind Constellation",
    "quiz": "Quiz",
    "flashcards": "Flashcards",
    "report": "Report",
    "infographic": "Infographic",
    "slide_deck": "Slide deck",
    "upload": "Upload",
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


def report_blocks(a: Artifact) -> list[dict]:
    """A report's blocks, each infographic block with its page: the child artifact's html and status (or "missing"
    once it was deleted). Read when the report is read, so one still being written shows up when it is ready."""
    from app.pipeline.infographic import infographic_html  # not at import: pipeline imports this module

    blocks = list((a.content_json or {}).get("blocks") or [])
    ids = [uuid.UUID(b["artifact_id"]) for b in blocks if b.get("type") == "infographic" and b.get("artifact_id")]
    db = object_session(a)
    kids = {k.id: k for k in db.scalars(select(Artifact).where(Artifact.id.in_(ids), Artifact.workspace_id == a.workspace_id))} \
        if ids and db else {}
    out = []
    for b in blocks:
        if b.get("type") != "infographic":
            out.append(b)
            continue
        kid = kids.get(uuid.UUID(b["artifact_id"])) if b.get("artifact_id") else None
        ready = bool(kid and kid.status == "ready" and (kid.content_json or {}).get("content"))
        out.append({**b, "status": kid.status if kid else "missing",
                    "html": infographic_html(kid.content_json) if ready else None,
                    "html_landscape": infographic_html(kid.content_json, "landscape") if ready else None})
    return out


def serialize_artifact(a: Artifact, job: Job | None = None) -> dict:
    content = a.content_json or {}
    if a.type == "infographic" and a.status == "ready":
        from app.pipeline.infographic import infographic_html  # not at import: pipeline imports this module

        content = {**content, "html": infographic_html(content), "html_landscape": infographic_html(content, "landscape")}
    if a.type == "slide_deck" and a.status == "ready":
        content = {**content, "slides_html": slide_pages(content), "slide_slots": slide_slots(content)}
    if a.type == "report" and any(b.get("type") == "infographic" for b in content.get("blocks") or []):
        content = {**content, "blocks": report_blocks(a)}
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
        # blog2video videos live on blog2video's storage (video_url once rendered)
        "url": storage.presign_get(a.storage_key) if a.storage_key else content.get("video_url"),
        "download_url": (storage.presign_get(a.storage_key, download_name=_download_name(a)) if a.storage_key
                         else content.get("video_url")),
        "provider": content.get("provider"),
        "slide_urls": [storage.presign_get(k) for k in slides],
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "job": serialize_job(job) if job else None,
    }


def _download_name(a: Artifact) -> str:
    title = (a.content_json or {}).get("title") or a.type
    ext = (a.storage_key or "").rsplit(".", 1)[-1]
    return f"{title[:60]}.{ext}"

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.models import Artifact
from app.services.jobs import create_job, serialize_job
from app.services.storage import storage

router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])

COMPOSITIONS = {"ShortVertical": "mp4", "QuoteCard": "png"}


class ArtifactIn(BaseModel):
    type: Literal["summary", "audio_overview", "video", "thread", "linkedin", "notes", "quote_card", "carousel", "seo"]
    notebook_id: uuid.UUID | None = None
    document_id: uuid.UUID | None = None
    content: dict = {}


class RenderIn(BaseModel):
    composition: Literal["ShortVertical", "QuoteCard"]
    props: dict


def _serialize(a: Artifact) -> dict:
    return {
        "id": str(a.id),
        "type": a.type,
        "status": a.status,
        "content": a.content_json,
        "storage_key": a.storage_key,
        "url": storage.presign_get(a.storage_key) if a.storage_key else None,
    }


def _get(ctx: Ctx, artifact_id: uuid.UUID) -> Artifact:
    a = ctx.db.scalar(select(Artifact).where(Artifact.id == artifact_id, Artifact.workspace_id == ctx.workspace.id))
    if not a:
        raise HTTPException(404, "Artifact not found")
    return a


@router.post("")
def create_artifact(body: ArtifactIn, ctx: Ctx = Depends(get_ctx)):
    a = Artifact(
        workspace_id=ctx.workspace.id,
        type=body.type,
        notebook_id=body.notebook_id,
        document_id=body.document_id,
        content_json=body.content,
        status="draft",
    )
    ctx.db.add(a)
    ctx.db.commit()
    return _serialize(a)


@router.get("/{artifact_id}")
def get_artifact(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    return _serialize(_get(ctx, artifact_id))


@router.post("/{artifact_id}/render")
def render_artifact(artifact_id: uuid.UUID, body: RenderIn, ctx: Ctx = Depends(get_ctx)):
    a = _get(ctx, artifact_id)
    a.status = "rendering"
    job = create_job(
        ctx.db,
        ctx.workspace.id,
        "render",
        {"artifact_id": str(a.id), "composition": body.composition, "props": body.props,
         "format": COMPOSITIONS[body.composition]},
        artifact_id=a.id,
    )
    return serialize_job(job)

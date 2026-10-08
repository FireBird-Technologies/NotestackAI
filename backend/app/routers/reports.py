import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.llm import run
from app.models import Artifact
from app.pipeline.report import EMBED_KINDS, keep_visual, remove_block
from app.routers.artifacts import get_artifact_or_404
from app.routers.videos import FocusIn, _focus_material
from app.services import report_suggestions
from app.services.artifacts import latest_jobs, serialize_artifact
from app.services.jobs import create_job
from app.services.report_templates import INTERACTIVE, TEMPLATES
from app.services.usage import check_limit

router = APIRouter(prefix="/api/reports", tags=["reports"])



@router.get("/templates")
def templates(_ctx: Ctx = Depends(get_ctx)):
    """The fixed templates (each with its instruction text, {about} to be filled in) and the interactive one."""
    return {"templates": TEMPLATES, "interactive": INTERACTIVE}


class SuggestIn(FocusIn):
    topic: str | None = Field(None, max_length=500)


@router.post("/suggest")
def suggest_templates(body: SuggestIn, ctx: Ctx = Depends(get_ctx)):
    """Four kinds of report these sources could make, each with its own ready-written instructions. The AI reads each post's stored
    ideas and topics (not its text); the answer is kept, so the same sources get it again at once (and it is prepared in the
    background as soon as ideas are extracted). Never an error: when there is nothing usable the list is empty and the dialog shows
    only the fixed templates."""
    material, docs = _focus_material(ctx, body)
    if not material:
        return {"templates": []}
    items = report_suggestions.suggestion_items(material, docs)
    return {"templates": report_suggestions.suggest(ctx.db, ctx.workspace.id, items, (body.topic or "").strip())}


class AddBlockIn(BaseModel):
    kind: Literal["mind_map", "flashcards", "quiz", "infographic"]
    theme: str | None = Field(None, max_length=30)  # infographic: the premade theme
    after_block_id: str | None = Field(None, max_length=20)
    suggestion_id: str | None = Field(None, max_length=20)
    brief: str = Field("", max_length=500)
    existing_artifact_id: uuid.UUID | None = None  # copy this Mind Constellation, quiz or flashcard set instead


def _report_or_404(ctx: Ctx, artifact_id: uuid.UUID) -> Artifact:
    a = get_artifact_or_404(ctx, artifact_id)
    if a.type != "report" or a.status != "ready":
        raise HTTPException(404, "Report not found")
    return a


@router.post("/{artifact_id}/blocks")
def add_block(artifact_id: uuid.UUID, body: AddBlockIn, ctx: Ctx = Depends(get_ctx)):
    """Add a visual after a section: made new from the report's sources, or copied from one you already made. Runs as a
    job; the report page shows its progress and reloads when it is done."""
    a = _report_or_404(ctx, artifact_id)
    content = a.content_json or {}
    if body.kind not in EMBED_KINDS:
        raise HTTPException(400, "Unknown kind of visual")
    if body.kind == "mind_map" and not content.get("source", {}).get("document_ids"):
        raise HTTPException(400, "A Mind Constellation is made from posts, not chats")
    if body.after_block_id and body.after_block_id not in {b["id"] for b in content.get("blocks") or []}:
        raise HTTPException(404, "Section not found")
    last = latest_jobs(ctx.db, [a.id]).get(a.id)
    if last and last.status in {"queued", "running"}:
        raise HTTPException(409, "Something is already being added to this report")
    if body.existing_artifact_id:
        existing = ctx.db.scalar(select(Artifact).where(Artifact.id == body.existing_artifact_id,
                                                        Artifact.workspace_id == ctx.workspace.id,
                                                        Artifact.type == body.kind, Artifact.status == "ready"))
        if not existing:
            raise HTTPException(404, "That one was not found")
    if body.kind == "infographic" and not body.existing_artifact_id:
        check_limit(ctx.db, ctx.workspace, "infographics", 1)
    params = {"artifact_id": str(a.id), "kind": body.kind, "theme": body.theme, "after_block_id": body.after_block_id,
              "suggestion_id": body.suggestion_id, "brief": body.brief.strip(),
              "existing_artifact_id": str(body.existing_artifact_id) if body.existing_artifact_id else None}
    job = create_job(ctx.db, ctx.workspace.id, "report_block", params, artifact_id=a.id, max_attempts=1)
    return serialize_artifact(a, job)


@router.delete("/{artifact_id}/blocks/{block_id}")
def delete_block(artifact_id: uuid.UUID, block_id: str, ctx: Ctx = Depends(get_ctx)):
    a = _report_or_404(ctx, artifact_id)
    removed = next((b for b in (a.content_json or {}).get("blocks") or [] if b.get("id") == block_id), None)
    content = remove_block(a.content_json or {}, block_id)
    if content is None:
        raise HTTPException(404, "Visual not found")
    keep_visual(ctx.db, a, removed)
    a.content_json = content
    ctx.db.commit()
    return serialize_artifact(a, latest_jobs(ctx.db, [a.id]).get(a.id))

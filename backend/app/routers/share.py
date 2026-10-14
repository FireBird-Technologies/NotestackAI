import time
import uuid
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import Ctx, get_ctx
from app.db import get_db
from app.models import Artifact, ArtifactShare, Workspace
from app.routers.artifacts import get_artifact_or_404
from app.services.share import (
    new_token,
    public_audio,
    public_flashcards,
    public_infographic,
    public_mind_map,
    public_quiz,
    public_report,
    public_slides,
    public_video,
    share_url,
    video_file,
    video_preview,
)

router = APIRouter(tags=["share"])

PUBLIC_PER_MINUTE = 60  # reads of shared pages from one address
_hits: dict[str, deque] = defaultdict(deque)


def _limit(request: Request) -> None:
    ip = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip() or (request.client.host if request.client else "?")
    now, window = time.monotonic(), _hits[ip]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= PUBLIC_PER_MINUTE:
        raise HTTPException(429, "Too many requests. Try again in a minute.")
    window.append(now)


SHAREABLE = ("report", "infographic", "audio_overview", "video", "slide_deck", "flashcards", "quiz", "mind_map")


def _ready(a: Artifact) -> bool:
    """Finished, so there is something to show (a video once its file exists)."""
    return a.type in SHAREABLE and (a.status == "ready" or (a.type == "video" and bool(video_file(a) or video_preview(a))))


def _report(ctx: Ctx, artifact_id: uuid.UUID) -> Artifact:
    """A finished shareable artifact of this workspace."""
    a = get_artifact_or_404(ctx, artifact_id)
    if not _ready(a):
        raise HTTPException(404, "Not found")
    return a


def _mint_preview(ctx: Ctx, a: Artifact) -> None:
    """A video's live-preview link is made when its editor first opens; one shared before that gets it now."""
    from app.models import B2VVideo
    from app.routers.videos import preview_url

    vid = (a.content_json or {}).get("b2v_video_id")
    if not str(vid or "").isdigit():
        return
    row = ctx.db.scalar(select(B2VVideo).where(B2VVideo.artifact_id == a.id, B2VVideo.workspace_id == ctx.workspace.id))
    preview_url(ctx, a, int(vid), row)


PUBLIC_VIEWS = {"infographic": lambda a, s: public_infographic(a), "report": public_report,
                "audio_overview": lambda a, s: public_audio(a), "video": lambda a, s: public_video(a),
                "slide_deck": lambda a, s: public_slides(a), "flashcards": lambda a, s: public_flashcards(a),
                "quiz": lambda a, s: public_quiz(a), "mind_map": lambda a, s: public_mind_map(a)}


def _share(ctx: Ctx, a: Artifact) -> ArtifactShare | None:
    return ctx.db.scalar(select(ArtifactShare).where(ArtifactShare.artifact_id == a.id))


def _out(share: ArtifactShare | None) -> dict:
    return {"shared": bool(share), "url": share_url(share.token) if share else None,
            "show_sources": share.show_sources if share else True}


@router.get("/api/artifacts/{artifact_id}/share")
def get_share(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    return _out(_share(ctx, _report(ctx, artifact_id)))


@router.post("/api/artifacts/{artifact_id}/share")
def create_share(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    """Turn the link on (the same link if it already is)."""
    a = _report(ctx, artifact_id)
    if not ctx.workspace.allow_public_links:
        raise HTTPException(403, "Public links are turned off for this workspace. Turn them on in Settings, Privacy.")
    if a.type == "video" and not video_preview(a):
        _mint_preview(ctx, a)
    share = _share(ctx, a)
    if not share:
        share = ArtifactShare(workspace_id=ctx.workspace.id, artifact_id=a.id, token=new_token(), show_sources=True)
        ctx.db.add(share)
        try:
            ctx.db.commit()
        except IntegrityError:  # made by a request that ran at the same time: that one's link
            ctx.db.rollback()
            share = _share(ctx, a)
    return _out(share)


class ShareIn(BaseModel):
    show_sources: bool


@router.patch("/api/artifacts/{artifact_id}/share")
def update_share(artifact_id: uuid.UUID, body: ShareIn, ctx: Ctx = Depends(get_ctx)):
    share = _share(ctx, _report(ctx, artifact_id))
    if not share:
        raise HTTPException(404, "This is not shared")
    share.show_sources = body.show_sources
    ctx.db.commit()
    return _out(share)


@router.delete("/api/artifacts/{artifact_id}/share")
def delete_share(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    """Turn the link off for good: the old address stops working, and sharing again makes a new one."""
    share = _share(ctx, _report(ctx, artifact_id))
    if share:
        ctx.db.delete(share)
        ctx.db.commit()
    return _out(None)


@router.get("/api/public/s/{token}")
@router.get("/api/public/reports/{token}")  # the address links made before every type could be shared used
def public(token: str, request: Request, response: Response, db: Session = Depends(get_db)):
    """The shared view of an artifact. No sign in. A wrong, revoked or switched-off link is a plain 404."""
    _limit(request)
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    response.headers["Cache-Control"] = "no-store"
    share = db.scalar(select(ArtifactShare).where(ArtifactShare.token == token[:64]))
    artifact = db.get(Artifact, share.artifact_id) if share else None
    workspace = db.get(Workspace, share.workspace_id) if share else None
    if not share or not artifact or not _ready(artifact) or not workspace or not workspace.allow_public_links:
        raise HTTPException(404, "This link does not work")
    return PUBLIC_VIEWS[artifact.type](artifact, share)

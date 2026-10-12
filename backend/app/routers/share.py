import time
import uuid
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import Ctx, get_ctx
from app.db import get_db
from app.models import Artifact, ArtifactShare, Workspace
from app.routers.artifacts import get_artifact_or_404
from app.services.share import new_token, public_infographic, public_report, share_url

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


SHAREABLE = ("report", "infographic")


def _report(ctx: Ctx, artifact_id: uuid.UUID) -> Artifact:
    """A finished report or infographic of this workspace."""
    a = get_artifact_or_404(ctx, artifact_id)
    if a.type not in SHAREABLE or a.status != "ready":
        raise HTTPException(404, "Not found")
    return a


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
    share = _share(ctx, a)
    if not share:
        share = ArtifactShare(workspace_id=ctx.workspace.id, artifact_id=a.id, token=new_token(), show_sources=True)
        ctx.db.add(share)
        ctx.db.commit()
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


@router.get("/api/public/reports/{token}")
def public(token: str, request: Request, response: Response, db: Session = Depends(get_db)):
    """The shared view of a report or an infographic. No sign in. A wrong, revoked or switched-off link is a plain 404."""
    _limit(request)
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    response.headers["Cache-Control"] = "no-store"
    share = db.scalar(select(ArtifactShare).where(ArtifactShare.token == token[:64]))
    artifact = db.get(Artifact, share.artifact_id) if share else None
    workspace = db.get(Workspace, share.workspace_id) if share else None
    if not share or not artifact or artifact.type not in SHAREABLE or artifact.status != "ready" \
            or not workspace or not workspace.allow_public_links:
        raise HTTPException(404, "This link does not work")
    return public_infographic(artifact) if artifact.type == "infographic" else public_report(artifact, share)

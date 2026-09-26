"""Browser uploads go straight to R2 with presigned PUTs; reads redirect to presigned GETs."""

import mimetypes
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.config import settings
from app.models import Upload
from app.services.storage import LocalStorage, keys, safe_filename, storage, verify_local_sig, workspace_owns_key

router = APIRouter(prefix="/api/storage", tags=["storage"])

ALLOWED_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/svg+xml",
    "audio/mpeg",
    "audio/wav",
    "audio/webm",
    "audio/mp4",
    "audio/ogg",
    "video/mp4",
    "application/pdf",
    "text/markdown",
    "text/plain",
    "text/html",
}


class UploadStartIn(BaseModel):
    filename: str = Field(max_length=300)
    content_type: str
    size_bytes: int = Field(gt=0)


@router.post("/uploads")
def start_upload(body: UploadStartIn, ctx: Ctx = Depends(get_ctx)):
    if body.content_type not in ALLOWED_TYPES:
        raise HTTPException(415, "File type not supported")
    if body.size_bytes > settings.max_upload_bytes:
        raise HTTPException(413, "File too large")
    upload_id = uuid.uuid4()
    key = keys.upload(ctx.workspace.id, upload_id, body.filename)
    upload = Upload(
        id=upload_id,
        workspace_id=ctx.workspace.id,
        user_id=ctx.user.id,
        key=key,
        filename=body.filename,
        content_type=body.content_type,
    )
    ctx.db.add(upload)
    ctx.db.commit()
    return {
        "upload_id": str(upload_id),
        "key": key,
        "upload_url": storage.presign_put(key, body.content_type, ttl=900),
        "headers": {"Content-Type": body.content_type},
    }


@router.post("/uploads/{upload_id}/complete")
def complete_upload(upload_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    upload = ctx.db.scalar(
        select(Upload).where(Upload.id == upload_id, Upload.workspace_id == ctx.workspace.id)
    )
    if not upload:
        raise HTTPException(404, "Upload not found")
    head = storage.head(upload.key)
    if not head:
        raise HTTPException(409, "Object not found in storage yet")
    size = int(head.get("ContentLength") or 0)
    if size > settings.max_upload_bytes:
        storage.delete(upload.key)
        raise HTTPException(413, "File too large")
    upload.size_bytes = size
    upload.status = "complete"
    ctx.db.commit()
    return {"upload_id": str(upload.id), "key": upload.key, "size_bytes": size}


@router.get("/objects/{key:path}")
def read_object(key: str, download: bool = False, ctx: Ctx = Depends(get_ctx)):
    if not workspace_owns_key(ctx.workspace.id, key):
        raise HTTPException(404, "Not found")
    name = key.rsplit("/", 1)[-1] if download else None
    return RedirectResponse(storage.presign_get(key, download_name=name), status_code=302)


# Local disk backend: the "presigned" URLs LocalStorage hands out point here.

local_router = APIRouter(prefix="/api/storage/local", tags=["storage"], include_in_schema=False)


def _local_path(method: str, key: str, exp: int, sig: str):
    if not isinstance(storage, LocalStorage) or not verify_local_sig(method, key, exp, sig):
        raise HTTPException(403, "Invalid or expired link")
    try:
        return storage.path(key)
    except ValueError as exc:
        raise HTTPException(404, "Not found") from exc


@local_router.get("/{key:path}")
def local_get(key: str, exp: int, sig: str, download: str | None = None):
    path = _local_path("GET", key, exp, sig)
    if not path.is_file():
        raise HTTPException(404, "Not found")
    media_type = mimetypes.guess_type(key)[0] or "application/octet-stream"
    # FileResponse answers Range requests, so audio and video can seek.
    return FileResponse(path, media_type=media_type, filename=safe_filename(download) if download else None,
                        content_disposition_type="attachment" if download else "inline")


@local_router.put("/{key:path}")
async def local_put(key: str, exp: int, sig: str, request: Request):
    _local_path("PUT", key, exp, sig)
    body = await request.body()
    if len(body) > settings.max_upload_bytes:
        raise HTTPException(413, "File too large")
    storage.put_bytes(key, body)
    return {"ok": True, "size_bytes": len(body)}

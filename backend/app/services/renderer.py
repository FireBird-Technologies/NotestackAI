"""Hands a render to the Remotion service with presigned upload URLs (it never holds storage keys)."""

import httpx

from app.config import settings
from app.models import Artifact, Job
from app.services.storage import keys, storage

COMPOSITIONS = {
    "AudiogramSquare": "mp4",
    "QuoteCard": "png",
    "CarouselSlide": "png",
}


class PermanentJobError(RuntimeError):
    """Fail the job now; retrying will not help."""


def available() -> bool:
    """Whether the render service answers right now (a quick health check, not a promise for later)."""
    try:
        return httpx.get(f"{settings.renderer_url}/health", timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


def request_render(job: Job, artifact: Artifact, composition: str, props: dict | None = None,
                   stills: list[dict] | None = None) -> None:
    """Start a render. `stills` renders one PNG per props dict (carousels) instead of a single output."""
    fmt = COMPOSITIONS[composition]
    content_type = "image/png" if fmt == "png" else "video/mp4"
    body: dict = {
        "jobId": str(job.id),
        "compositionId": composition,
        "props": props or {},
        "format": fmt,
        "uploadContentType": content_type,
        "callbackUrl": f"{settings.api_url}/api/internal/jobs/{job.id}/progress",
    }
    if stills:
        outputs = []
        for i, still_props in enumerate(stills, start=1):
            key = keys.artifact(artifact.workspace_id, artifact.id, f"slide-{i:02d}", fmt)
            outputs.append({"props": still_props, "uploadUrl": storage.presign_put(key, content_type, ttl=6 * 3600),
                            "storageKey": key})
        body.update(stills=outputs, props=stills[0], uploadUrl=outputs[0]["uploadUrl"],
                    storageKey=outputs[0]["storageKey"])
    else:
        key = keys.artifact(artifact.workspace_id, artifact.id, composition.lower(), fmt)
        body.update(uploadUrl=storage.presign_put(key, content_type, ttl=6 * 3600), storageKey=key)
    try:
        resp = httpx.post(f"{settings.renderer_url}/render", headers={"x-internal-token": settings.internal_token},
                          json=body, timeout=30)
    except httpx.ConnectError as exc:
        raise PermanentJobError("Renderer is not running. Start it with: cd renderer && npm start") from exc
    if resp.status_code == 400:
        raise PermanentJobError(f"Renderer rejected the props: {resp.text[:400]}")
    resp.raise_for_status()

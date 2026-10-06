import logging
import threading
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.llm.provider import configure_default
from app.routers import (
    artifacts,
    auth,
    billing,
    jobs,
    launchpad,
    memory,
    notebooks,
    resurface,
    sources,
    storage,
    support,
    topics,
    unsubscribe,
    video_edit,
    video_styles,
    video_voices,
    videos,
    voice,
)
from app.routers import settings as settings_router
from app.services.storage import storage as store

log = logging.getLogger("notestack")


def _drop_color_message(record: logging.LogRecord) -> bool:
    """litellm (via dspy) adds a secret redaction filter to uvicorn.error that formats the message
    and clears record.args. uvicorn's colored formatter then swaps in its color_message template
    and prints it with no args ("Uvicorn running on %s://%s:%d"). Without the template it prints
    the already formatted, redacted message."""
    record.__dict__.pop("color_message", None)
    return True


logging.getLogger("uvicorn.error").addFilter(_drop_color_message)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO)
    configure_default()
    if settings.env == "development" and (settings.r2_endpoint_url or settings.use_local_storage):
        try:
            store.ensure_bucket()  # MinIO or the local storage folder
        except Exception:
            log.warning("could not ensure local bucket", exc_info=True)
    stop = threading.Event()
    if settings.worker_in_api:
        from app.worker import start_background

        start_background(stop)
        log.info("worker running inside the API (RUN_WORKER_IN_API)")
    yield
    stop.set()


app = FastAPI(title="Notestack API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_id(request: Request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    start = time.perf_counter()
    response = await call_next(request)
    response.headers["x-request-id"] = rid
    log.info("%s %s %s %.0fms rid=%s", request.method, request.url.path, response.status_code,
             (time.perf_counter() - start) * 1000, rid)
    return response


@app.get("/api/health")
def health():
    return {"ok": True, "llm": settings.llm_model, "billing_enabled": settings.billing_enabled}


# video_templates (custom templates) is switched off: users pick only from the built-in templates.
for r in (auth, billing, storage, sources, notebooks, artifacts, jobs, unsubscribe, topics, voice, resurface,
          launchpad, videos, video_edit, video_voices, video_styles, settings_router, memory, support):
    app.include_router(r.router)
app.include_router(sources.documents_router)
app.include_router(launchpad.links_router)
if settings.use_local_storage:
    app.include_router(storage.local_router)

import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.llm.provider import configure_default
from app.routers import artifacts, auth, billing, jobs, notebooks, sources, storage, unsubscribe

log = logging.getLogger("notestack")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO)
    configure_default()
    if settings.env == "development" and settings.r2_endpoint_url:
        try:
            from app.services.storage import storage as store

            store.ensure_bucket()  # MinIO locally
        except Exception:
            log.warning("could not ensure local bucket", exc_info=True)
    yield


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


for r in (auth, billing, storage, sources, notebooks, artifacts, jobs, unsubscribe):
    app.include_router(r.router)
app.include_router(sources.documents_router)

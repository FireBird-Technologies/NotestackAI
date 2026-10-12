# Hugging Face Spaces image, built from the repo root (the Space holds the whole repo).
# Upload this file to the Space root as `Dockerfile`. One container, non-root uid 1000, port 7860;
# the worker runs inside the API process.
FROM python:3.12-slim

RUN useradd -m -u 1000 user
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    ENV=production \
    RUN_WORKER_IN_API=true \
    CORPUS_CACHE_DIR=/app/.corpus-cache \
    LOCAL_STORAGE_DIR=/app/.storage

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=user backend/ .
RUN rm -f .env
USER user

EXPOSE 7860
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 7860 --proxy-headers --forwarded-allow-ips='*'"]

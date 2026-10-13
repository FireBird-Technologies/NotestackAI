"""One door for every generation call: runs the signature, meters tokens, writes a trace, and strips
em dashes from the outputs. Tests replace `predict` to return canned outputs."""

import logging
import random
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import dspy
from sqlalchemy.orm import Session

from app.config import settings
from app.llm.postprocess import clean_output
from app.llm.provider import main_lm, provider_name, track_usage
from app.models import DspyTrace, Job, Workspace
from app.services.jobs import record_usage

log = logging.getLogger(__name__)

# Every model call takes a slot, so jobs that split their work in two cannot together flood the provider.
_slots = threading.BoundedSemaphore(max(settings.llm_max_concurrent, 1))
_RETRIES = 2


def _rate_limited(exc: Exception) -> bool:
    """Z.ai's "rate limit" (1305) and "busy" (1312) answers, or any 429: worth a short wait and one more try. Its quota
    answer (1310) is not: it stays until the window resets."""
    text = f"{type(exc).__name__} {exc}"
    if "1310" in text:
        return False
    return "RateLimit" in text or "429" in text or "1305" in text or "1312" in text


def _call(fn):
    """Run one model call in a slot; when rate limited, wait a random second or few and try again (the jitter keeps calls
    that failed together from coming back together)."""
    for attempt in range(_RETRIES + 1):
        try:
            with _slots:
                return fn()
        except Exception as exc:
            if attempt == _RETRIES or not _rate_limited(exc):
                raise
            log.warning("rate limited, retrying (%s)", attempt + 1)
            time.sleep(random.uniform(1, 3) * (attempt + 1))


def _dump(value):
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if isinstance(value, list):
        return [_dump(v) for v in value]
    return value


def predict(
    signature: type[dspy.Signature],
    *,
    db: Session,
    workspace_id: uuid.UUID,
    job: Job | None = None,
    lm: dspy.LM | None = None,
    **inputs,
) -> dict:
    """Run `signature` and return its outputs as plain dicts/lists (pydantic models dumped)."""
    lm = lm or main_lm()
    def run():
        with dspy.context(lm=lm):
            return dspy.Predict(signature)(**inputs)

    with track_usage(lm) as usage:
        pred = _call(run)
    outputs = {name: clean_output(_dump(pred[name])) for name in signature.output_fields}
    _record(db, workspace_id, job, signature, lm, usage, [(inputs, outputs)])
    return outputs


def predict_many(
    signature: type[dspy.Signature],
    inputs_list: list[dict],
    *,
    db: Session,
    workspace_id: uuid.UUID,
    lm: dspy.LM | None = None,
    workers: int = 5,
    job: Job | None = None,
) -> list[dict | None]:
    """`predict` once per inputs, in parallel. Only the model calls run in threads: usage, traces and the commit
    happen here, on the caller's session. A call that fails is None in its place."""
    if not inputs_list:
        return []
    lm = lm or main_lm()

    def call(inputs: dict) -> dict | None:
        try:
            def run():
                with dspy.context(lm=lm):
                    return dspy.Predict(signature)(**inputs)

            pred = _call(run)
            return {name: clean_output(_dump(pred[name])) for name in signature.output_fields}
        except Exception:
            log.warning("%s failed", signature.__name__, exc_info=True)
            return None

    with track_usage(lm) as usage, ThreadPoolExecutor(max_workers=min(workers, len(inputs_list))) as pool:
        results = list(pool.map(call, inputs_list))
    _record(db, workspace_id, job, signature, lm, usage,
            [(i, o) for i, o in zip(inputs_list, results, strict=True) if o is not None])
    return results


def _record(db: Session, workspace_id: uuid.UUID, job: Job | None, signature: type[dspy.Signature], lm: dspy.LM,
            usage, calls: list[tuple[dict, dict]]) -> None:
    if usage.total:
        model = getattr(lm, "model", None) or settings.llm_model  # the model that answered, not always the main one
        record_usage(db, workspace_id=workspace_id, kind="llm", provider=provider_name(model), model=model,
                     quantity=usage.total, unit="tokens", cost_usd=usage.cost_usd, job=job)
    workspace = db.get(Workspace, workspace_id)
    for inputs, outputs in calls:
        db.add(DspyTrace(
            workspace_id=workspace_id, module=signature.__name__, model=lm.model,
            inputs={k: (v if len(str(v)) < 4000 else str(v)[:4000]) for k, v in inputs.items()},
            outputs=outputs, training_allowed=bool(workspace and workspace.training_opt_in),
        ))
    db.commit()

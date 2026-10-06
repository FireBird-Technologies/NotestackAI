"""One door for every generation call: runs the signature, meters tokens, writes a trace, and strips
em dashes from the outputs. Tests replace `predict` to return canned outputs."""

import logging
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
    with track_usage(lm) as usage, dspy.context(lm=lm):
        pred = dspy.Predict(signature)(**inputs)
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
) -> list[dict | None]:
    """`predict` once per inputs, in parallel. Only the model calls run in threads: usage, traces and the commit
    happen here, on the caller's session. A call that fails is None in its place."""
    if not inputs_list:
        return []
    lm = lm or main_lm()

    def call(inputs: dict) -> dict | None:
        try:
            with dspy.context(lm=lm):
                pred = dspy.Predict(signature)(**inputs)
            return {name: clean_output(_dump(pred[name])) for name in signature.output_fields}
        except Exception:
            log.warning("%s failed", signature.__name__, exc_info=True)
            return None

    with track_usage(lm) as usage, ThreadPoolExecutor(max_workers=min(workers, len(inputs_list))) as pool:
        results = list(pool.map(call, inputs_list))
    _record(db, workspace_id, None, signature, lm, usage,
            [(i, o) for i, o in zip(inputs_list, results, strict=True) if o is not None])
    return results


def _record(db: Session, workspace_id: uuid.UUID, job: Job | None, signature: type[dspy.Signature], lm: dspy.LM,
            usage, calls: list[tuple[dict, dict]]) -> None:
    if usage.total:
        record_usage(db, workspace_id=workspace_id, kind="llm", provider=provider_name(), model=settings.llm_model,
                     quantity=usage.total, unit="tokens", cost_usd=usage.cost_usd, job=job)
    workspace = db.get(Workspace, workspace_id)
    for inputs, outputs in calls:
        db.add(DspyTrace(
            workspace_id=workspace_id, module=signature.__name__, model=lm.model,
            inputs={k: (v if len(str(v)) < 4000 else str(v)[:4000]) for k, v in inputs.items()},
            outputs=outputs, training_allowed=bool(workspace and workspace.training_opt_in),
        ))
    db.commit()

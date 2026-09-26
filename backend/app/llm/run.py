"""One door for every generation call: runs the signature, meters tokens, writes a trace, and strips
em dashes from the outputs. Tests replace `predict` to return canned outputs."""

import uuid

import dspy
from sqlalchemy.orm import Session

from app.config import settings
from app.llm.postprocess import clean_output
from app.llm.provider import main_lm, provider_name, track_usage
from app.models import DspyTrace, Job, Workspace
from app.services.jobs import record_usage


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
    if usage.total:
        record_usage(db, workspace_id=workspace_id, kind="llm", provider=provider_name(), model=settings.llm_model,
                     quantity=usage.total, unit="tokens", cost_usd=usage.cost_usd, job=job)
    workspace = db.get(Workspace, workspace_id)
    db.add(DspyTrace(
        workspace_id=workspace_id, module=signature.__name__, model=lm.model,
        inputs={k: (v if len(str(v)) < 4000 else str(v)[:4000]) for k, v in inputs.items()},
        outputs=outputs, training_allowed=bool(workspace and workspace.training_opt_in),
    ))
    db.commit()
    return outputs

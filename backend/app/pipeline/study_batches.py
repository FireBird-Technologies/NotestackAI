"""Quizzes and flashcards in two calls at once instead of one long one: each call writes half the items from its own half of
the material, so the wait is about that of the slower half. A half that fails costs only its share."""

import math
import uuid

from sqlalchemy.orm import Session

from app.llm import run
from app.models import Job

MIN_TO_SPLIT = 6  # a set this small is quicker as one call than as two


def predict_in_halves(signature, *, db: Session, workspace_id: uuid.UUID, job: Job | None, lm, material: list[str],
                      count: int, inputs: dict, key: str, shared: int = 1) -> list[dict]:
    """The `key` items (questions or cards) of every half that answered, in order. One call when the set is small or there
    is too little material to give each half its own. The halves get different material, so they differ and neither is a
    cached repeat of the other; the caller drops repeats and trims to `count`. Raises when nothing came back."""
    note, rest = material[:shared], material[shared:]  # the format note (ideas only) goes to both halves, the rest is dealt out
    if count < MIN_TO_SPLIT or len(rest) < 2:
        out = run.predict(signature, db=db, workspace_id=workspace_id, job=job, lm=lm, material=material, count=count, **inputs)
        return out.get(key) or []
    first = math.ceil(count / 2)
    # One more from each half than its share: repeats and unusable items are dropped afterwards, and the set is trimmed to count.
    calls = [dict(inputs, material=note + rest[i::2], count=n + 1) for i, n in enumerate((first, count - first))]
    results = run.predict_many(signature, calls, db=db, workspace_id=workspace_id, lm=lm, workers=2, job=job)
    items = [x for r in results if r for x in r.get(key) or []]
    if not items and not any(results):  # both failed: say why, with the full set as one call
        out = run.predict(signature, db=db, workspace_id=workspace_id, job=job, lm=lm, material=material, count=count, **inputs)
        return out.get(key) or []
    return items

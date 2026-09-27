"""TypeSafe Jev: a System One classifier. It picks from options we define (with probabilities) and never
generates text, so it is the fast, cheap way to decide what a chat message needs.

API: POST {TYPESAFE_URL}/v1/systemone with {"state", "model", "questions"}; answers come back per
question id with "choice", "confidence" and "probabilities". https://docs.typesafe.ai/primitives/choice
"""

from dataclasses import dataclass

import httpx

from app.config import settings


class JevError(RuntimeError):
    pass


@dataclass
class Choice:
    choice: str
    confidence: float
    probabilities: dict[str, float]


def configured() -> bool:
    return bool(settings.typesafe_api_key)


def decide(state: str | dict, questions: dict[str, dict], timeout: float = 6.0) -> dict[str, Choice]:
    """Ask several Choice questions about one state in a single request (Jev evaluates them in parallel)."""
    if not configured():
        raise JevError("TYPESAFE_API_KEY is not set")
    body = {
        "state": state,
        "model": settings.typesafe_model,
        "questions": {qid: {"type": "choice", **q} for qid, q in questions.items()},
    }
    try:
        resp = httpx.post(f"{settings.typesafe_url.rstrip('/')}/v1/systemone", json=body, timeout=timeout,
                          headers={"Authorization": f"Bearer {settings.typesafe_api_key}"})
    except httpx.HTTPError as exc:
        raise JevError(f"Jev unreachable: {exc}") from exc
    if resp.status_code >= 400:
        raise JevError(f"Jev {resp.status_code}: {resp.text[:300]}")
    answers = resp.json().get("answers") or {}
    out = {}
    for qid in questions:
        a = answers.get(qid) or {}
        if "choice" not in a:
            raise JevError(f"Jev returned no answer for {qid}")
        out[qid] = Choice(a["choice"], float(a.get("confidence") or 0), a.get("probabilities") or {})
    return out

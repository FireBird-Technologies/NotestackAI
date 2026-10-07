"""Flashcards: front and back cards written from a notebook's posts or from notebook chats, flipped in the browser."""

import uuid

from sqlalchemy.orm import Session

from app.llm import run
from app.llm.provider import fast_lm
from app.llm.signatures import GenerateFlashcards
from app.models import Artifact, Job
from app.pipeline.generate import NothingToDo
from app.pipeline.material import Material, load_material
from app.services.jobs import update_job

SAME_LANGUAGE = "the same language as the sources"  # no language picked: write as the material is written
CARD_COUNTS = {"fewer": 8, "standard": 16, "more": 24}


def make_cards(db: Session, workspace_id: uuid.UUID, material: Material, *, topic: str = "", count: int = 16,
               difficulty: str = "medium", language: str = SAME_LANGUAGE, job: Job | None = None) -> list[dict]:
    """Cards about the material: a front, a back and verified source lines. Repeats and empty cards are dropped."""
    out = run.predict(GenerateFlashcards, db=db, workspace_id=workspace_id, job=job, title=material.title,
                      material=material.text, topic=topic or "(none)", difficulty=difficulty, count=count,
                      language=language.strip() or SAME_LANGUAGE, lm=fast_lm())
    cards, seen = [], set()
    for c in out.get("cards") or []:
        front, back = (c.get("front") or "").strip(), (c.get("back") or "").strip()
        key = front.lower()
        if not front or not back or key in seen:
            continue
        seen.add(key)
        cards.append({"front": front[:300], "back": back[:800], "sources": material.refs(c.get("sources"))})
    return cards[:count]


def build_flashcards(db: Session, job: Job, artifact: Artifact) -> dict:
    params = job.params
    count = CARD_COUNTS.get(params.get("count") or "standard", CARD_COUNTS["standard"])
    topic = (params.get("topic") or "").strip()
    difficulty = params.get("difficulty") if params.get("difficulty") in ("easy", "medium", "hard") else "medium"
    material = load_material(db, artifact.workspace_id, artifact.notebook_id, params, job=job, what="flashcard set")
    update_job(db, job, progress=0.4, message="Writing the cards")
    cards = make_cards(db, artifact.workspace_id, material, topic=topic, count=count, difficulty=difficulty,
                       language=params.get("language") or SAME_LANGUAGE, job=job)
    if not cards:
        raise NothingToDo("The material did not give enough to make cards from. Try other posts or another topic.")
    artifact.content_json = {
        "title": f"Flashcards: {topic[:60] or material.title}", "topic": topic, "difficulty": difficulty,
        "language": params.get("language") or SAME_LANGUAGE, "source": material.source, "cards": cards,
        "card_count": len(cards),
    }
    artifact.status = "ready"
    db.commit()
    return {"artifact_id": str(artifact.id)}

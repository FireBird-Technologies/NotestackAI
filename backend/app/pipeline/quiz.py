"""Quizzes: questions written from a notebook's posts or from notebook chats, graded in the browser."""

import uuid

from sqlalchemy.orm import Session

from app.config import settings
from app.llm import run
from app.llm.provider import fast_lm
from app.llm.signatures import GenerateQuiz
from app.models import Artifact, Job
from app.pipeline import idea_pool
from app.pipeline.generate import NothingToDo
from app.pipeline.material import Material, load_material
from app.services.jobs import update_job

SAME_LANGUAGE = "the same language as the sources"  # no language picked: write as the material is written
QUESTION_COUNTS = {"fewer": 5, "standard": 10, "more": 15}
DIFFICULTIES = ("easy", "medium", "hard")
QUESTION_TYPES = ("multiple_choice", "multiple_select", "fill_blank", "short_answer")


def _clean(q: dict, refs) -> dict | None:
    """One generated question in the shape the page plays, or None when it cannot be played."""
    kind, text = q.get("type"), (q.get("question") or "").strip()
    if kind not in QUESTION_TYPES or not text:
        return None
    base = {"type": kind, "question": text, "explanation": (q.get("explanation") or "").strip(),
            "sources": refs(q.get("sources"))}
    if kind in ("multiple_choice", "multiple_select"):
        options = [str(o).strip() for o in q.get("options") or [] if str(o).strip()]
        correct = sorted({i for i in q.get("correct") or [] if isinstance(i, int) and 0 <= i < len(options)})
        if len(options) < 2 or not correct:
            return None
        if kind == "multiple_choice":
            correct = correct[:1]
        elif len(correct) < 2:
            kind = base["type"] = "multiple_choice"
        return {**base, "options": options, "correct": correct}
    answer = (q.get("answer") or "").strip()
    if not answer:
        return None
    if kind == "fill_blank":
        accepted = [a.strip() for a in q.get("accepted") or [] if a and a.strip()]
        if "____" not in text:
            base["question"] = f"{text} ____"
        return {**base, "answer": answer, "accepted": accepted}
    return {**base, "answer": answer}


def make_questions(db: Session, workspace_id: uuid.UUID, material: Material, *, topic: str = "",
                   difficulty: str = "medium", types: list[str] | None = None, count: int = 10,
                   language: str = SAME_LANGUAGE, job: Job | None = None) -> list[dict]:
    """Playable questions about the material (fewer than `count` when the model gave unusable ones)."""
    types = [t for t in types or [] if t in QUESTION_TYPES] or list(QUESTION_TYPES[:2])
    # A multiple select with a single right answer was turned into a multiple choice: fine when that was asked for too.
    allowed = set(types) | ({"multiple_choice"} if "multiple_select" in types else set())
    inputs = dict(title=material.title, topic=topic or "(none)", difficulty=difficulty, question_types=types,
                  language=language.strip() or SAME_LANGUAGE)
    # Many posts: one call over a random sample of the ideas already extracted from them (idea_pool), not the posts' text.
    text = idea_pool.sample(db, workspace_id, material.docs, topic, chats=material.text) if material.mode == "ideas" else material.text
    out = run.predict(GenerateQuiz, db=db, workspace_id=workspace_id, job=job, material=text, count=count, lm=fast_lm(), **inputs)
    cleaned = [c for q in out.get("questions") or [] if (c := _clean(q, material.refs))]
    return [c for c in cleaned if c["type"] in allowed][:count]


def build_quiz(db: Session, job: Job, artifact: Artifact) -> dict:
    params = job.params
    types = [t for t in params.get("question_types") or [] if t in QUESTION_TYPES] or list(QUESTION_TYPES[:2])
    count = QUESTION_COUNTS.get(params.get("count") or "standard", QUESTION_COUNTS["standard"])
    difficulty = params.get("difficulty") if params.get("difficulty") in DIFFICULTIES else "medium"
    topic = (params.get("topic") or "").strip()
    material = load_material(db, artifact.workspace_id, artifact.notebook_id, params, job=job, what="quiz", large_ok=True,
                             passage_budget=settings.artifact_quiz_passage_budget)
    update_job(db, job, progress=0.4, message="Writing the questions")
    questions = make_questions(db, artifact.workspace_id, material, topic=topic, difficulty=difficulty, types=types,
                               count=count, language=params.get("language") or SAME_LANGUAGE, job=job)
    if not questions:
        raise NothingToDo("The material did not give enough to ask about. Try other posts or another topic.")
    artifact.content_json = {
        "title": f"Quiz: {(topic[:60] or material.title)}", "topic": topic, "difficulty": difficulty,
        "language": params.get("language") or SAME_LANGUAGE, "question_types": types, "source": material.source,
        "questions": questions, "question_count": len(questions),
    }
    artifact.status = "ready"
    db.commit()
    return {"artifact_id": str(artifact.id)}

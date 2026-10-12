"""Thumbs up or down on generated reports, quizzes, flashcards and infographics: what can be rated, why a thumbs down can be
given, and how the ratings ride along on the artifacts the app lists."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Artifact, ArtifactFeedback

# What each kind can be marked down for (the ids the app sends; anything else is dropped).
REASONS: dict[str, set[str]] = {
    "report": {"inaccurate", "missed_points", "structure", "tone", "too_long", "too_short", "other"},
    "quiz": {"wrong_answers", "too_easy", "too_hard", "unclear", "off_topic", "other"},
    "flashcards": {"inaccurate", "too_basic", "too_detailed", "unclear", "other"},
    "infographic": {"messy_layout", "cut_off", "missing_content", "look", "hard_to_read", "other"},
}
RATEABLE = tuple(REASONS)


def feedback_out(f: ArtifactFeedback | None) -> dict | None:
    if not f:
        return None
    return {"rating": "up" if f.rating > 0 else "down", "reasons": f.reasons or [], "comment": f.comment}


def attach(db: Session, user_id: uuid.UUID, items: list[dict]) -> list[dict]:
    """Add `feedback` (this person's rating, or None) to each serialized artifact that can be rated. One query."""
    ids = [uuid.UUID(i["id"]) for i in items if i.get("type") in RATEABLE]
    rows = {f.artifact_id: f for f in db.scalars(select(ArtifactFeedback).where(
        ArtifactFeedback.artifact_id.in_(ids), ArtifactFeedback.user_id == user_id))} if ids else {}
    for i in items:
        if i.get("type") in RATEABLE:
            i["feedback"] = feedback_out(rows.get(uuid.UUID(i["id"])))
    return items


def snapshot(a: Artifact) -> dict:
    """What the artifact was when it was rated: enough to tell what a rating is about."""
    c = a.content_json or {}
    inner = c.get("content") if isinstance(c.get("content"), dict) else {}
    keep = {k: c.get(k) for k in ("title", "prompt", "source", "theme", "format", "template_id", "difficulty", "question_count",
                                  "card_count", "language", "topic") if c.get(k) is not None}
    if a.type == "infographic":
        keep["layout"] = "composed" if "body_html" in inner else "fixed"
        keep["fit"] = inner.get("fit")
    return keep

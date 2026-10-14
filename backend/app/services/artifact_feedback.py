"""Thumbs up or down, with a few words of feedback, on anything generated (reports, quizzes, flashcards, infographics,
slide decks, audio overviews, videos, Mind Constellations, summaries, quote cards, carousels and launch kits): what can be rated, why a thumbs down can be
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
    "slide_deck": {"inaccurate", "design", "cut_off", "too_long", "too_short", "other"},
    "audio_overview": {"inaccurate", "voices", "boring", "too_long", "too_short", "other"},
    "video": {"inaccurate", "visuals", "voice", "too_long", "too_short", "other"},
    # "missing_content" and "structure" are the older ids, still accepted so a rating already saved with one stays valid.
    "mind_map": {"inaccurate", "missed_ideas", "poor_links", "too_few", "too_many", "hard_to_read", "other",
                 "missing_content", "structure"},
    "summary": {"inaccurate", "missed_points", "too_long", "too_short", "unclear", "other"},
    "quote_card": {"wrong_quote", "design", "hard_to_read", "other"},
    "carousel": {"inaccurate", "design", "cut_off", "too_long", "too_short", "other"},
    "launch_kit": {"inaccurate", "tone", "weak_hooks", "too_long", "too_short", "other"},
}
RATEABLE = tuple(REASONS)


def feedback_out(f: ArtifactFeedback | None) -> dict | None:
    if not f:
        return None
    # A thumbs up is stored as 1, a thumbs down as -1 (older thumbs up kept a rating of 2 to 5: still up).
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

"""Start trusted Studio artifacts for compound chat actions.

The request thread only enqueues the real artifact. A worker later waits for that
artifact and sends its exact content to the requested connected app.
"""

import uuid

from sqlalchemy import select

from app.config import settings
from app.db import SessionLocal
from app.infographics.themes import theme_id as infographic_theme_id
from app.models import Notebook, Workspace
from app.services.artifacts import start_artifact
from app.services.usage import check_limit
from app.slides.themes import theme_id as slide_theme_id

TRANSFERABLE_ARTIFACTS = frozenset({
    "quiz", "flashcards", "report", "infographic", "slide_deck", "mind_map",
})


def artifact_url(artifact_id: uuid.UUID) -> str:
    return f"{settings.frontend_url.rstrip('/')}/app/artifacts/{artifact_id}"


def start_flashcards(
    workspace_id: uuid.UUID,
    notebook_id: uuid.UUID,
    notebook_title: str,
    *,
    count: str = "standard",
    difficulty: str = "medium",
    topic: str = "",
    language: str | None = None,
) -> dict:
    """Create the pending artifact and return immediately; the normal worker builds it."""
    with SessionLocal() as db:
        notebook = db.scalar(select(Notebook).where(
            Notebook.id == notebook_id, Notebook.workspace_id == workspace_id,
        ))
        if notebook is None:
            raise ValueError("The notebook is no longer available.")
        clean_topic = topic.strip()[:500]
        artifact, _job = start_artifact(
            db,
            workspace_id,
            "flashcards",
            title=f"Flashcards: {clean_topic[:60] or notebook_title or notebook.title}",
            notebook_id=notebook_id,
            params={
                "document_ids": [],
                "chat_ids": [],
                "topic": clean_topic,
                "count": count if count in {"fewer", "standard", "more"} else "standard",
                "difficulty": difficulty if difficulty in {"easy", "medium", "hard"} else "medium",
                "language": (language or "").strip()[:40] or None,
            },
            job_kind="flashcards",
        )
        return {
            "id": str(artifact.id),
            "type": "flashcards",
            "status": artifact.status,
            "title": (artifact.content_json or {}).get("title"),
            "url": artifact_url(artifact.id),
        }


def start_quiz(
    workspace_id: uuid.UUID,
    notebook_id: uuid.UUID,
    notebook_title: str,
    *,
    count: str = "standard",
    difficulty: str = "medium",
    topic: str = "",
    language: str | None = None,
) -> dict:
    """Create a pending quiz artifact from the notebook and return immediately."""
    with SessionLocal() as db:
        notebook = db.scalar(select(Notebook).where(
            Notebook.id == notebook_id, Notebook.workspace_id == workspace_id,
        ))
        if notebook is None:
            raise ValueError("The notebook is no longer available.")
        clean_topic = topic.strip()[:500]
        artifact, _job = start_artifact(
            db,
            workspace_id,
            "quiz",
            title=f"Quiz: {clean_topic[:60] or notebook_title or notebook.title}",
            notebook_id=notebook_id,
            params={
                "document_ids": [],
                "chat_ids": [],
                "topic": clean_topic,
                "count": count if count in {"fewer", "standard", "more"} else "standard",
                "difficulty": difficulty if difficulty in {"easy", "medium", "hard"} else "medium",
                "question_types": ["multiple_choice", "multiple_select"],
                "language": (language or "").strip()[:40] or None,
            },
            job_kind="quiz",
        )
        return {
            "id": str(artifact.id),
            "type": "quiz",
            "status": artifact.status,
            "title": (artifact.content_json or {}).get("title"),
            "url": artifact_url(artifact.id),
        }


def start_from_chat(
    workspace_id: uuid.UUID,
    notebook_id: uuid.UUID,
    notebook_title: str,
    artifact_type: str,
    settings: dict | None = None,
) -> dict:
    """Start any structured Studio artifact that can be delivered to another app.

    Destination handling is intentionally absent here. The same generated artifact
    can be rendered by any delivery adapter that accepts structured text.
    """
    if artifact_type not in TRANSFERABLE_ARTIFACTS:
        raise ValueError(f"The {artifact_type.replace('_', ' ')} artifact cannot be transferred yet.")
    settings = settings or {}
    with SessionLocal() as db:
        notebook = db.scalar(select(Notebook).where(
            Notebook.id == notebook_id, Notebook.workspace_id == workspace_id,
        ))
        if notebook is None:
            raise ValueError("The notebook is no longer available.")
        workspace = db.get(Workspace, workspace_id)
        if workspace is None:
            raise ValueError("The workspace is no longer available.")

        target = notebook_title or notebook.title
        focus = str(settings.get("focus") or settings.get("about") or settings.get("prompt") or "").strip()[:500]
        params: dict = {"document_ids": [], "chat_ids": []}
        title = f"{artifact_type.replace('_', ' ').title()}: {focus[:60] or target}"
        if artifact_type in {"quiz", "flashcards"}:
            level = str(settings.get("level") or "medium")
            params.update({
                "topic": focus,
                "count": "standard",
                "difficulty": level if level in {"easy", "medium", "hard"} else "medium",
                "language": settings.get("language"),
            })
            if artifact_type == "quiz":
                question_types = settings.get("types") or ["multiple_choice", "multiple_select"]
                params["question_types"] = list(dict.fromkeys(question_types))
        elif artifact_type == "report":
            check_limit(db, workspace, "reports", 1)
            params.update({
                "topic": focus,
                "language": settings.get("language"),
                "report_format": settings.get("format") if settings.get("format") in {"document", "interactive"}
                else "document",
                "template_id": settings.get("template"),
                "instructions": str(settings.get("instructions") or "").strip()[:4000],
            })
        elif artifact_type == "infographic":
            check_limit(db, workspace, "infographics", 1)
            params.update({
                "theme": infographic_theme_id(settings.get("theme")),
                "style": settings.get("style") or "auto",
                "instructions": focus[:600],
            })
        elif artifact_type == "slide_deck":
            params.update({
                "theme": slide_theme_id(settings.get("theme")),
                "deck_format": settings.get("format") if settings.get("format") in {"detailed", "presenter"}
                else "detailed",
                "deck_length": settings.get("length") if settings.get("length") in {"short", "default", "long"}
                else "default",
                "language": settings.get("language"),
                "instructions": focus,
            })
        elif artifact_type == "mind_map":
            params = {"document_ids": [], "focus": focus}

        artifact, _job = start_artifact(
            db,
            workspace_id,
            artifact_type,
            title=title,
            notebook_id=notebook_id,
            params=params,
            job_kind=artifact_type,
        )
        return {
            "id": str(artifact.id),
            "type": artifact_type,
            "status": artifact.status,
            "title": (artifact.content_json or {}).get("title"),
            "url": artifact_url(artifact.id),
        }

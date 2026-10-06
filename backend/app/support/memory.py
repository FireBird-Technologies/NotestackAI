"""Conversation memory for the bot: the last few turns, a rolling summary of older ones, and small session facts.
All three live on the conversation rows and are rebuilt from the database each request; the model is stateless."""

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.base import utcnow
from app.models.support import SupportConversation, SupportMessage

RECENT_MESSAGES = 6  # about three turns
RECENT_HOURS = 24
SUMMARIZE_AT = 8  # total messages before older turns start folding into the summary
FOLD_BATCH = 4


def recent_messages(db: Session, conv_id) -> list[SupportMessage]:
    rows = db.scalars(
        select(SupportMessage)
        .where(SupportMessage.conversation_id == conv_id, SupportMessage.created_at >= utcnow() - timedelta(hours=RECENT_HOURS))
        .order_by(SupportMessage.created_at.desc())
        .limit(RECENT_MESSAGES)
    ).all()
    return list(reversed(rows))


def user_texts(messages: list[SupportMessage]) -> list[str]:
    return [m.content for m in messages if m.role == "user"]


def last_cited(messages: list[SupportMessage]) -> list[str]:
    for m in reversed(messages):
        if m.role == "assistant" and m.cited_docs:
            return list(m.cited_docs)
    return []


def to_fold(db: Session, conv_id, recent: list[SupportMessage]) -> list[SupportMessage]:
    """Older messages that fell out of the recent window, oldest first, a few at a time to keep it cheap."""
    if not recent:
        return []
    rows = db.scalars(
        select(SupportMessage)
        .where(SupportMessage.conversation_id == conv_id, SupportMessage.created_at < min(m.created_at for m in recent))
        .order_by(SupportMessage.created_at.desc())
        .limit(FOLD_BATCH)
    ).all()
    return list(reversed(rows))


def update_state(state: dict, *, page_path: str | None, cited: list[str], plan: str | None) -> dict:
    out = dict(state or {})
    if plan:
        out["plan"] = plan
    if page_path:
        out["current_page"] = page_path
        visited = [p for p in out.get("visited_pages", []) if p != page_path] + [page_path]
        out["visited_pages"] = visited[-10:]
    if cited:
        out["recent_cited_doc_ids"] = cited
    return out


def state_block(state: dict) -> str:
    keys = ("current_page", "visited_pages", "recent_cited_doc_ids", "plan")
    lines = [f"  {k}: {state[k]}" for k in keys if state.get(k)]
    return "USER CONTEXT:\n" + "\n".join(lines) if lines else "USER CONTEXT: (none)"

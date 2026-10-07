"""What a generated quiz, flashcard set or report reads: a notebook's posts (with numbered lines to cite) or the
transcripts of notebook chats. One loader for all of them, so every artifact picks its source the same way."""

import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.corpus import Corpus
from app.models import Chat, Document, Job, Message, Notebook
from app.pipeline.generate import NothingToDo
from app.pipeline.passages import ScopedTools, notebook_docs, passages_for, tools_for, verify_refs, workspace_docs
from app.services.jobs import update_job

MAX_POSTS = 20  # posts one artifact reads; the passage budget is shared between them
CHAT_BUDGET = 60_000  # characters of chat transcripts


@dataclass
class Material:
    title: str  # the notebook, the post, or the first chat's title
    text: list[str]  # passages (posts) or transcripts (chats), ready for a prompt
    source: dict  # {"kind": "posts"|"chats"|"mixed", "document_ids"?, "chat_ids"?, "count": n}
    docs: list[Document] = field(default_factory=list)  # empty for chats only
    # Turns the model's {path, line_start, line_end} items into verified refs with their quote. Chats give none.
    refs: Callable[[list | None], list[dict]] = lambda _items: []
    tools: ScopedTools | None = None  # reads back cited lines (posts only)

    @property
    def is_chat(self) -> bool:
        """Chats only: there are no posts to draw a mind map from or to cite lines of."""
        return not self.docs


def chat_material(db: Session, chats: list[Chat]) -> list[str]:
    """One transcript per chat, citation markers removed. A chat over its share loses its oldest turns first."""
    share = CHAT_BUDGET // max(len(chats), 1)
    out = []
    for chat in chats:
        msgs = db.scalars(select(Message).where(Message.chat_id == chat.id).order_by(Message.created_at)).all()
        turns = [f"{'User' if m.role == 'user' else 'Assistant'}: {t}" for m in msgs
                 if (t := re.sub(r"\s*\[\d+\]", "", m.content).strip())]
        size = sum(len(t) + 2 for t in turns)
        while len(turns) > 1 and size > share:
            size -= len(turns.pop(0)) + 2
        if any(m.role == "assistant" for m in msgs):
            out.append(f"CHAT {chat.title or 'Untitled chat'}\n" + "\n\n".join(turns))
    return out


def load_material(db: Session, workspace_id: uuid.UUID, notebook_id: uuid.UUID | None, params: dict, *,
                  job: Job | None = None, what: str = "quiz") -> Material:
    """The source a job's params name: posts (`document_ids`, a notebook's, the archive's or a single post), chats
    (`chat_ids`), or both together. With `chat_ids` and no posts it reads only the chats; with neither it reads the whole
    notebook. Raises NothingToDo when there is nothing to read."""
    chat_ids = [uuid.UUID(str(i)) for i in params.get("chat_ids") or []]
    picked = [uuid.UUID(str(i)) for i in params.get("document_ids") or []]
    nb = db.get(Notebook, notebook_id) if notebook_id else None

    docs: list[Document] = []
    if picked:
        docs = workspace_docs(db, workspace_id, picked)
    elif not chat_ids and nb:
        docs = notebook_docs(db, nb.id)
    docs = docs[:MAX_POSTS]

    chats: list[Chat] = []
    chat_text: list[str] = []
    if chat_ids:
        chats = list(db.scalars(select(Chat).where(Chat.id.in_(chat_ids), Chat.workspace_id == workspace_id)
                                .order_by(Chat.created_at)))
        chat_text = chat_material(db, chats)
        if not chat_text and not docs:
            raise NothingToDo(f"These chats have no answers to make a {what} from yet.")
    if not docs and not chat_text:
        raise NothingToDo(f"Pick at least one post or chat for the {what}.")

    text: list[str] = []
    refs: Callable[[list | None], list[dict]] = lambda _items: []  # noqa: E731  (chats have no lines to point at)
    tools: ScopedTools | None = None
    if docs:
        corpus = Corpus(workspace_id)
        if job:
            update_job(db, job, progress=0.1, message=f"Reading {len(docs)} posts")
        text = passages_for(corpus, docs)
        tools = tools_for(corpus, docs)
        by_path = {d.path: d for d in docs}

        def refs(items) -> list[dict]:  # noqa: F811
            return [{"document_id": str(by_path[r["path"]].id), "path": r["path"], "title": r["title"],
                     "line_start": r["line_start"], "line_end": r["line_end"], "quote": r["quote"]}
                    for r in verify_refs(tools, items or []) if r["path"] in by_path]

    if docs and nb and not picked:
        title = nb.title
    elif docs:
        title = docs[0].title + (f" + {len(docs) - 1} more" if len(docs) > 1 else "")
    else:
        first = chats[0].title or "Chat"
        title = first if len(chats) == 1 else f"{first} + {len(chats) - 1} more"
    if docs and chat_text:
        title += f" + {len(chats)} chat{'s' if len(chats) != 1 else ''}"

    source: dict = {"kind": "mixed" if docs and chat_text else "posts" if docs else "chats"}
    if docs:
        source["document_ids"] = [str(d.id) for d in docs]
    if chat_text:
        source["chat_ids"] = [str(c.id) for c in chats]
    source["count"] = len(docs) + (len(chats) if chat_text else 0)
    return Material(title=title, text=text + chat_text, docs=docs, refs=refs, tools=tools, source=source)

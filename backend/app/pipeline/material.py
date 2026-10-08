"""What a generated quiz, flashcard set or report reads: a notebook's posts (with numbered lines to cite) or the
transcripts of notebook chats. One loader for all of them, so every artifact picks its source the same way."""

import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.corpus import Corpus
from app.models import Chat, Document, Job, Message, Notebook, Workspace
from app.pipeline.generate import NothingToDo
from app.pipeline.passages import ScopedTools, notebook_docs, passages_for, tools_for, verify_refs, workspace_docs
from app.services.jobs import update_job
from app.services.plans import effective_plan

CHAT_BUDGET = 60_000  # characters of chat transcripts


def max_posts() -> int:
    """Posts a report or infographic reads, and the most a quiz or flashcard set reads straight from the posts (ARTIFACT_MAX_POSTS);
    the passage budget is shared between them."""
    return max(settings.artifact_max_posts, 1)


def use_ideas(docs: list[Document], *, large_ok: bool, ideas_always: bool) -> bool:
    """Read the posts through their stored ideas instead of their text? Only when most of them have ideas stored (the rest are
    represented by a short opening). A selection above max_posts() (quiz and flashcards) always, when it can; a flashcard set
    (`ideas_always`) whatever the size. Otherwise, or with too few ideas stored, the posts' text is read as it always was."""
    from app.pipeline.idea_pool import has_ideas

    if not docs or not (large_ok or ideas_always):
        return False
    if len(docs) > max_posts() or ideas_always:
        return has_ideas(docs) * 2 >= len(docs)
    return False


@dataclass
class Material:
    title: str  # the notebook, the post, or the first chat's title
    text: list[str]  # passages (posts) or transcripts (chats), ready for a prompt
    source: dict  # {"kind": "posts"|"chats"|"mixed", "document_ids"?, "chat_ids"?, "count": n}
    docs: list[Document] = field(default_factory=list)  # empty for chats only
    # Turns the model's {path, line_start, line_end} items into verified refs with their quote. Chats give none.
    refs: Callable[[list | None], list[dict]] = lambda _items: []
    tools: ScopedTools | None = None  # reads back cited lines (posts only)
    # "passages": `text` holds the posts' passages. "ideas": more posts than max_posts(), so `text` holds only chat transcripts and
    # the posts are read through their stored ideas (pipeline/idea_pool.py).
    mode: str = "passages"

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
                  job: Job | None = None, what: str = "quiz", large_ok: bool = False,
                  ideas_always: bool = False, passage_budget: int | None = None) -> Material:
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
    # Quiz and flashcards take as many posts as the plan indexes: their ideas are sampled. The rest read max_posts().
    docs = docs[:effective_plan(db, db.get(Workspace, workspace_id)).indexed_posts] if large_ok else docs[:max_posts()]
    ideas_mode = use_ideas(docs, large_ok=large_ok, ideas_always=ideas_always)
    if large_ok and not ideas_mode:
        docs = docs[:max_posts()]  # their ideas are not stored yet: read the first posts' text, as a small selection is

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
            update_job(db, job, progress=0.1, message=f"Gathering the key ideas of {len(docs)} posts" if ideas_mode
                       else f"Reading {len(docs)} posts")
        text = [] if ideas_mode else passages_for(corpus, docs, budget_chars=passage_budget)
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
    return Material(title=title, text=text + chat_text, docs=docs, refs=refs, tools=tools, source=source,
                    mode="ideas" if ideas_mode else "passages")

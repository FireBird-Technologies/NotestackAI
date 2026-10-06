import asyncio
import json
import logging
import time
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from app.auth import Ctx, get_ctx
from app.chat_memory.context import load_chat_memory
from app.chat_memory.organize import forget_chat, queue_chat_memory
from app.chat_memory.tools import is_chat_path
from app.config import settings
from app.corpus import Corpus
from app.llm.provider import provider_name
from app.models import (
    Artifact,
    Chat,
    Citation,
    Document,
    DocumentTopic,
    Message,
    MessageFeedback,
    Notebook,
    NotebookDocument,
    Topic,
)
from app.pipeline.generate import ideas_fresh
from app.pipeline.research import Turn, research
from app.pipeline.trace import ChatTrace, use_trace
from app.routers.sources import serialize_document
from app.services.artifacts import latest_jobs, serialize_artifact
from app.services.jobs import create_job, record_usage
from app.services.memory import list_facts, profile_text
from app.services.storage import storage

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/notebooks", tags=["notebooks"])


class NotebookIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str | None = None
    document_ids: list[uuid.UUID] = []


class NotebookPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    description: str | None = None


class DocumentsIn(BaseModel):
    document_ids: list[uuid.UUID]


class ChatIn(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    chat_id: uuid.UUID | None = None


def _get(ctx: Ctx, notebook_id: uuid.UUID) -> Notebook:
    nb = ctx.db.scalar(
        select(Notebook).where(Notebook.id == notebook_id, Notebook.workspace_id == ctx.workspace.id)
    )
    if not nb:
        raise HTTPException(404, "Notebook not found")
    return nb


def _add_docs(ctx: Ctx, nb: Notebook, ids: list[uuid.UUID]) -> int:
    valid = set(ctx.db.scalars(
        # Locked posts (beyond the plan's post limit) have no corpus file and cannot join a notebook.
        select(Document.id).where(Document.id.in_(ids), Document.workspace_id == ctx.workspace.id,
                                  Document.path.is_not(None))
    ).all())
    existing = set(ctx.db.scalars(select(NotebookDocument.document_id).where(NotebookDocument.notebook_id == nb.id)))
    for doc_id in valid - existing:
        ctx.db.add(NotebookDocument(notebook_id=nb.id, document_id=doc_id))
    # Their ideas are read in the background now, so a map asked for later finds them ready.
    fresh = [d for d in ctx.db.scalars(select(Document).where(Document.id.in_(valid - existing))) if not ideas_fresh(d)]
    if fresh and settings.llm_api_key:
        create_job(ctx.db, ctx.workspace.id, "ideas", {"document_ids": [str(d.id) for d in fresh]}, max_attempts=2)
    return len(valid - existing)


@router.post("")
def create_notebook(body: NotebookIn, ctx: Ctx = Depends(get_ctx)):
    nb = Notebook(workspace_id=ctx.workspace.id, title=body.title.strip(), description=body.description)
    ctx.db.add(nb)
    ctx.db.flush()
    added = _add_docs(ctx, nb, body.document_ids)
    ctx.db.commit()
    return {"id": str(nb.id), "title": nb.title, "added": added}


ARCHIVE_TITLE = "All posts"


def ensure_archive_notebook(ctx: Ctx) -> Notebook:
    """The workspace's "All posts" notebook, topped up with every indexed post (locked posts are skipped)."""
    nb = ctx.db.scalar(select(Notebook).where(Notebook.workspace_id == ctx.workspace.id, Notebook.is_archive.is_(True)))
    if not nb:
        nb = Notebook(workspace_id=ctx.workspace.id, title=ARCHIVE_TITLE, is_archive=True,
                      description="Every indexed post in your archive, kept up to date.")
        ctx.db.add(nb)
        ctx.db.flush()
    ids = list(ctx.db.scalars(select(Document.id).where(Document.workspace_id == ctx.workspace.id)))
    _add_docs(ctx, nb, ids)
    ctx.db.commit()
    return nb


@router.post("/archive")
def archive_notebook(ctx: Ctx = Depends(get_ctx)):
    nb = ensure_archive_notebook(ctx)
    return {"id": str(nb.id), "title": nb.title}


@router.post("/from-topic/{topic_id}")
def notebook_from_topic(topic_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    topic = ctx.db.scalar(select(Topic).where(Topic.id == topic_id, Topic.workspace_id == ctx.workspace.id))
    if not topic:
        raise HTTPException(404, "Topic not found")
    ids = list(ctx.db.scalars(select(DocumentTopic.document_id).where(DocumentTopic.topic_id == topic.id)))
    nb = Notebook(workspace_id=ctx.workspace.id, title=topic.name, description=topic.summary)
    ctx.db.add(nb)
    ctx.db.flush()
    added = _add_docs(ctx, nb, ids)
    ctx.db.commit()
    return {"id": str(nb.id), "title": nb.title, "added": added}


@router.get("")
def list_notebooks(ctx: Ctx = Depends(get_ctx)):
    rows = ctx.db.scalars(
        select(Notebook).where(Notebook.workspace_id == ctx.workspace.id)
        .order_by(Notebook.is_archive.desc(), Notebook.updated_at.desc())
    ).all()
    ids = [n.id for n in rows]
    doc_counts = dict(ctx.db.execute(
        select(NotebookDocument.notebook_id, func.count()).where(NotebookDocument.notebook_id.in_(ids))
        .group_by(NotebookDocument.notebook_id)
    ).all()) if ids else {}
    chat_counts = dict(ctx.db.execute(
        select(Chat.notebook_id, func.count()).where(Chat.notebook_id.in_(ids)).group_by(Chat.notebook_id)
    ).all()) if ids else {}
    artifact_counts = dict(ctx.db.execute(
        select(Artifact.notebook_id, func.count()).where(Artifact.notebook_id.in_(ids)).group_by(Artifact.notebook_id)
    ).all()) if ids else {}
    return [
        {"id": str(n.id), "title": n.title, "description": n.description, "summary": n.summary,
         "document_count": doc_counts.get(n.id, 0), "chat_count": chat_counts.get(n.id, 0),
         "artifact_count": artifact_counts.get(n.id, 0), "is_archive": n.is_archive,
         "updated_at": n.updated_at.isoformat() if n.updated_at else None}
        for n in rows
    ]


@router.get("/{notebook_id}")
def get_notebook(notebook_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    nb = _get(ctx, notebook_id)
    if nb.is_archive:  # posts synced since it was made join on open
        ensure_archive_notebook(ctx)
    docs = ctx.db.scalars(
        select(Document)
        .join(NotebookDocument, NotebookDocument.document_id == Document.id)
        .where(NotebookDocument.notebook_id == nb.id)
        .order_by(Document.published_at.desc())
    ).all()
    return {
        "id": str(nb.id),
        "title": nb.title,
        "description": nb.description,
        "summary": nb.summary,
        "is_archive": nb.is_archive,
        "documents": [serialize_document(d) for d in docs],
    }


@router.patch("/{notebook_id}")
def patch_notebook(notebook_id: uuid.UUID, body: NotebookPatch, ctx: Ctx = Depends(get_ctx)):
    nb = _get(ctx, notebook_id)
    if body.title is not None:
        nb.title = body.title.strip()
    if body.description is not None:
        nb.description = body.description
    ctx.db.commit()
    return {"id": str(nb.id), "title": nb.title, "description": nb.description}


@router.delete("/{notebook_id}")
def delete_notebook(notebook_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    nb = _get(ctx, notebook_id)
    ctx.db.execute(delete(NotebookDocument).where(NotebookDocument.notebook_id == nb.id))
    ctx.db.delete(nb)
    ctx.db.commit()
    try:  # the notebook's chats go with it, and so does their memory
        storage.delete_prefix(f"ws/{ctx.workspace.id}/chats/{notebook_id}/")
    except Exception:
        log.warning("Could not remove chat memory files for notebook %s", notebook_id, exc_info=True)
    return {"ok": True}


@router.post("/{notebook_id}/documents")
def add_documents(notebook_id: uuid.UUID, body: DocumentsIn, ctx: Ctx = Depends(get_ctx)):
    nb = _get(ctx, notebook_id)
    added = _add_docs(ctx, nb, body.document_ids)
    ctx.db.commit()
    return {"added": added}


@router.delete("/{notebook_id}/documents/{document_id}")
def remove_document(notebook_id: uuid.UUID, document_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    nb = _get(ctx, notebook_id)
    ctx.db.execute(delete(NotebookDocument).where(NotebookDocument.notebook_id == nb.id,
                                                  NotebookDocument.document_id == document_id))
    ctx.db.commit()
    return {"ok": True}


@router.get("/{notebook_id}/artifacts")
def notebook_artifacts(notebook_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    nb = _get(ctx, notebook_id)
    rows = list(ctx.db.scalars(
        select(Artifact).where(Artifact.notebook_id == nb.id).order_by(Artifact.created_at.desc())
    ).all())
    jobs = latest_jobs(ctx.db, [a.id for a in rows])
    return [serialize_artifact(a, jobs.get(a.id)) for a in rows]


@router.get("/{notebook_id}/chats")
def list_chats(notebook_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    nb = _get(ctx, notebook_id)
    chats = ctx.db.scalars(select(Chat).where(Chat.notebook_id == nb.id).order_by(Chat.updated_at.desc())).all()
    return [{"id": str(c.id), "title": c.title, "updated_at": c.updated_at.isoformat() if c.updated_at else None}
            for c in chats]


def _get_chat(ctx: Ctx, chat_id: uuid.UUID) -> Chat:
    chat = ctx.db.scalar(select(Chat).where(Chat.id == chat_id, Chat.workspace_id == ctx.workspace.id))
    if not chat:
        raise HTTPException(404, "Chat not found")
    return chat


def _cite(marker: int, path: str, line_start: int, line_end: int, span: str, doc: Document | None) -> dict:
    """One citation as the API returns it. A post citation has a document; a chat citation does not, and its title
    names the earlier topic ("Earlier chat: Evals and benchmarks")."""
    if doc is not None:
        base = {"kind": "post", "document_id": str(doc.id), "title": doc.title, "url": doc.url}
    else:
        slug = path.rsplit("/", 1)[-1].removesuffix(".md").replace("-", " ").strip()
        base = {"kind": "chat", "document_id": None, "title": f"Earlier chat: {slug.capitalize()}", "url": ""}
    return {"marker": marker, **base, "path": path, "line_start": line_start, "line_end": line_end, "span": span}


@router.get("/chats/{chat_id}/messages")
def chat_messages(chat_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    chat = _get_chat(ctx, chat_id)
    msgs = ctx.db.scalars(select(Message).where(Message.chat_id == chat.id).order_by(Message.created_at)).all()
    doc_ids = {c.document_id for m in msgs for c in m.citations if c.document_id}
    docs = {d.id: d for d in ctx.db.scalars(select(Document).where(Document.id.in_(doc_ids)))} if doc_ids else {}
    fb = {f.message_id: f for f in ctx.db.scalars(
        select(MessageFeedback).where(MessageFeedback.message_id.in_([m.id for m in msgs])))} if msgs else {}
    out = []
    for m in msgs:
        cites = [_cite(c.marker, c.path, c.line_start, c.line_end, c.span or "", docs.get(c.document_id))
                 for c in sorted(m.citations, key=lambda c: c.marker)]
        out.append({"id": str(m.id), "role": m.role, "text": m.content, "citations": cites,
                    "feedback": _feedback_out(fb.get(m.id))})
    return out


FEEDBACK_REASONS = {"wrong", "missed", "forgot_chat", "mixed_chat", "bad_sources", "other"}


class FeedbackIn(BaseModel):
    rating: Literal["up", "down"] | None  # null takes the rating back
    reasons: list[str] = []
    comment: str | None = Field(None, max_length=1000)


def _feedback_out(f: MessageFeedback | None) -> dict | None:
    if not f:
        return None
    return {"rating": "up" if f.rating > 0 else "down", "reasons": f.reasons or [], "comment": f.comment}


@router.put("/messages/{message_id}/feedback")
def rate_message(message_id: uuid.UUID, body: FeedbackIn, ctx: Ctx = Depends(get_ctx)):
    """Thumbs up or down on an assistant answer. Saves the question, the answer, what it cited and how recall behaved
    next to the rating, so the ratings can be used to improve recall. Rating again replaces; null removes."""
    db = ctx.db
    msg = db.scalar(select(Message).join(Chat, Chat.id == Message.chat_id)
                    .where(Message.id == message_id, Chat.workspace_id == ctx.workspace.id))
    if not msg or msg.role != "assistant":
        raise HTTPException(404, "Answer not found")
    row = db.scalar(select(MessageFeedback).where(MessageFeedback.message_id == msg.id))
    if body.rating is None:
        if row:
            db.delete(row)
            db.commit()
        return {"feedback": None}
    chat = db.get(Chat, msg.chat_id)
    question = db.scalar(select(Message.content).where(Message.chat_id == msg.chat_id, Message.role == "user",
                                                       Message.created_at <= msg.created_at)
                         .order_by(Message.created_at.desc()).limit(1)) or ""
    sources = [{"kind": c.kind, "path": c.path, "line_start": c.line_start, "line_end": c.line_end}
               for c in sorted(msg.citations, key=lambda c: c.marker)]
    reasons = [r for r in dict.fromkeys(body.reasons) if r in FEEDBACK_REASONS] if body.rating == "down" else []
    if not row:
        row = MessageFeedback(workspace_id=ctx.workspace.id, message_id=msg.id)
        db.add(row)
    row.notebook_id, row.chat_id = chat.notebook_id, chat.id
    row.rating = 1 if body.rating == "up" else -1
    row.reasons = reasons
    row.comment = (body.comment or "").strip() or None
    row.question, row.answer, row.sources, row.recall = question, msg.content, sources, msg.recall_json or {}
    db.commit()
    return {"feedback": _feedback_out(row)}


@router.get("/feedback/export")
def export_feedback(ctx: Ctx = Depends(get_ctx), rating: Literal["up", "down"] | None = None,
                    notebook_id: uuid.UUID | None = None, limit: int = 200):
    """The ratings with everything needed to study recall: question, answer, cited lines, reasons and the recall
    trace (triage route, the memory notes the agent saw, the steps it took). Newest first."""
    q = select(MessageFeedback).where(MessageFeedback.workspace_id == ctx.workspace.id)
    if rating:
        q = q.where(MessageFeedback.rating == (1 if rating == "up" else -1))
    if notebook_id:
        q = q.where(MessageFeedback.notebook_id == notebook_id)
    rows = ctx.db.scalars(q.order_by(MessageFeedback.updated_at.desc()).limit(min(limit, 1000))).all()
    return [{"id": str(f.id), "message_id": str(f.message_id) if f.message_id else None,
             "chat_id": str(f.chat_id) if f.chat_id else None,
             "notebook_id": str(f.notebook_id) if f.notebook_id else None,
             "rating": "up" if f.rating > 0 else "down", "reasons": f.reasons, "comment": f.comment,
             "question": f.question, "answer": f.answer, "sources": f.sources, "recall": f.recall,
             "rated_at": f.updated_at.isoformat() if f.updated_at else None} for f in rows]


@router.delete("/chats/{chat_id}")
def delete_chat(chat_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    chat = _get_chat(ctx, chat_id)
    workspace_id, notebook_id = chat.workspace_id, chat.notebook_id
    ctx.db.delete(chat)
    ctx.db.commit()
    try:
        forget_chat(workspace_id, notebook_id, chat_id, ctx.db)
    except Exception:  # the chat is gone either way; a leftover folder is removed by the cleanup pass
        log.warning("Could not remove chat memory files for %s", chat_id, exc_info=True)
        ctx.db.rollback()
    return {"ok": True}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


_STEP_LABEL = {"list": "Scanning the archive", "search": "Searching for", "read": "Reading", "think": "",
               "recall": "Remembering"}


async def _learn(db, workspace_id: uuid.UUID, message_id: uuid.UUID, kind: str,
                 trace: ChatTrace | None = None) -> list[dict]:
    """Queue the memory update for the writer's message, then wait briefly so the chat can say what was saved.
    The answer has already been sent; if the job is slow the notes still save, they just are not announced."""
    trace = trace or ChatTrace()
    if not settings.llm_api_key:
        trace.add("notes", "workspace notes: not updated (no LLM_API_KEY)")
        return []
    if kind == "chitchat":
        trace.add("notes", "workspace notes: not updated (small talk never holds a lasting note)")
        return []
    job = create_job(db, workspace_id, "memory_update", {"message_id": str(message_id)}, max_attempts=2)
    started = time.monotonic()
    deadline = started + settings.memory_notice_wait_seconds
    while time.monotonic() < deadline:
        await asyncio.sleep(0.4)
        db.refresh(job)
        waited = f"{time.monotonic() - started:.1f}s"
        if job.status == "failed":
            trace.add("notes", f"workspace notes: the memory_update job failed after {waited}: {job.error}")
            return []
        if job.status == "done":
            saved = (job.result or {}).get("saved") or []
            trace.add("notes", f"workspace notes: the memory_update job finished after {waited}: "
                               + (", ".join(f"{c['op']} {c['key']}" for c in saved) if saved else "nothing saved")
                               + " (the worker's own log says why: logger 'app.pipeline.memory')")
            return saved
    trace.add("notes", f"workspace notes: the memory_update job (status {job.status}) was still running after "
                       f"{settings.memory_notice_wait_seconds:.0f}s, so nothing was announced; "
                       "it keeps running in the worker")
    return []


@router.post("/{notebook_id}/chat")
async def chat(notebook_id: uuid.UUID, body: ChatIn, ctx: Ctx = Depends(get_ctx)):
    nb = _get(ctx, notebook_id)
    db = ctx.db
    trace = ChatTrace(notebook=nb.title, message=body.question)
    chat_row = db.get(Chat, body.chat_id) if body.chat_id else None
    if body.chat_id and (not chat_row or chat_row.notebook_id != nb.id):
        log.warning("Chat %s is not in notebook %s; starting a new chat", body.chat_id, nb.id)
    if not chat_row or chat_row.notebook_id != nb.id:
        chat_row = Chat(workspace_id=ctx.workspace.id, notebook_id=nb.id, title=body.question[:120])
        db.add(chat_row)
        db.flush()
    chat_row.updated_at = datetime.now(UTC)  # keeps the history list newest first
    trace.chat_id = str(chat_row.id)
    # Memory: the chat so far (before this message), oldest first, capped to the last few turns.
    with trace.stage("db-history+notes"):
        prior = db.scalars(
            select(Message).where(Message.chat_id == chat_row.id).order_by(Message.created_at.desc()).limit(8)
        ).all()
        history = [Turn(m.role, m.content) for m in reversed(prior)]
        facts = list_facts(db, ctx.workspace.id)
        profile = profile_text(facts)
    # Chat memory (topic summaries and exact quotes from earlier in this notebook's chats), loaded here so the research
    # thread needs no database session. None when the feature is off or nothing is remembered yet.
    with trace.stage("chat-memory(R2)"):
        chat_memory = load_chat_memory(db, ctx.workspace.id, nb.id, chat_row.id, {str(m.id) for m in prior})
    with trace.stage("save-question"):
        user_msg = Message(chat_id=chat_row.id, role="user", content=body.question)
        db.add(user_msg)
        db.commit()
    trace.add("load",
              f"history: {len(prior)} message(s) of this chat  [Postgres]",
              f"workspace notes: {len(facts)} note(s)  [Postgres]",
              ("chat memory: OFF (CHAT_MEMORY_READ=false), nothing read from R2" if not settings.chat_memory_read
               else "chat memory: nothing remembered for this chat yet, or it failed to load" if chat_memory is None
               else f"chat memory: {len(chat_memory.tf.entries)} topic(s) of this chat, "
                    f"{len(chat_memory.topics)} topic file(s) read  "
                    "[R2 manifest check, files from the local disk cache]"),
              "your message saved to Postgres before any model runs")

    with trace.stage("load-posts"):
        docs = db.scalars(
            select(Document)
            .join(NotebookDocument, NotebookDocument.document_id == Document.id)
            .where(NotebookDocument.notebook_id == nb.id, Document.path.is_not(None))
        ).all()
    allowed = {d.path: d.title for d in docs}
    by_path = {d.path: d for d in docs}
    corpus = Corpus(ctx.workspace.id)

    async def _run():
        yield _sse("status", {"chat_id": str(chat_row.id), "message": "Opening the archive"})
        loop = asyncio.get_running_loop()
        steps: asyncio.Queue = asyncio.Queue()

        def on_step(kind: str, detail: str) -> None:
            loop.call_soon_threadsafe(steps.put_nowait, (kind, detail))

        use_trace(trace)  # asyncio.to_thread copies this context, so research() finds the trace
        task = asyncio.create_task(asyncio.to_thread(
            research, corpus, allowed, body.question, on_step, history, nb.title, profile,
            **({"chat_memory": chat_memory} if chat_memory is not None else {})))
        while not task.done() or not steps.empty():
            try:
                kind, detail = await asyncio.wait_for(steps.get(), timeout=0.25)
            except TimeoutError:
                continue
            yield _sse("step", {"kind": kind, "message": f"{_STEP_LABEL.get(kind, kind)} {detail}".strip()})
        try:
            result = task.result()
        except Exception:
            log.exception("Research failed for chat %s: %r", chat_row.id, body.question[:200])  # the cause, not just "lost signal"
            trace.error = "research raised (see the traceback above); no answer was saved"
            yield _sse("error", {"message": "Lost signal while researching. Try again."})
            return

        save_started = time.perf_counter()
        msg = Message(chat_id=chat_row.id, role="assistant", content=result.text,
                      recall_json={**result.recall, "kind": result.kind, "unsupported": result.unsupported,
                                   "steps": [{"kind": k, "detail": d} for k, d in result.steps],
                                   "timings_ms": {name: round(took) for name, took in trace.stages}})
        db.add(msg)
        db.flush()
        citations = []
        for c in result.citations:
            if is_chat_path(c.path):  # verified against the notebook's chat memory by research()
                db.add(Citation(message_id=msg.id, kind="chat", document_id=None, marker=c.marker, path=c.path,
                                line_start=c.line_start, line_end=c.line_end, span=c.quote))
                citations.append(_cite(c.marker, c.path, c.line_start, c.line_end, c.quote, None))
                continue
            doc = by_path.get(c.path)
            if not doc:
                continue
            db.add(Citation(message_id=msg.id, document_id=doc.id, marker=c.marker, path=c.path,
                            line_start=c.line_start, line_end=c.line_end, span=c.quote))
            citations.append(_cite(c.marker, c.path, c.line_start, c.line_end, c.quote, doc))
        db.commit()
        trace.add("save", f"assistant message saved to Postgres with {len(citations)} citation row(s) and recall_json "
                          "(triage choices, memory notes shown, steps, timings)")
        if result.kind == "chitchat":
            trace.add("save", "chat-memory filing job: not queued (small talk is not filed)")
        else:
            try:
                queued = queue_chat_memory(db, ctx.workspace.id, chat_row.id)
                trace.add("save", "chat-memory filing job: " + (
                    f"queued, the worker runs it about {settings.chat_memory_delay_seconds:.0f}s from now and then "
                    "writes the topic files to R2" if queued
                    else "not queued (one is already waiting, or filing is off)"))
            except Exception:  # memory is a bonus: a failed enqueue never costs the writer their answer
                log.warning("Could not queue chat memory", exc_info=True)
                db.rollback()
                trace.add("save", "chat-memory filing job: could not be queued (see the warning above)")
        if result.prompt_tokens or result.completion_tokens:
            record_usage(
                db,
                workspace_id=ctx.workspace.id,
                kind="llm",
                provider=provider_name(),
                model=settings.llm_model,
                quantity=result.prompt_tokens + result.completion_tokens,
                unit="tokens",
            )
        trace.stages.append(("save-answer", (time.perf_counter() - save_started) * 1000))
        trace.mark("answer")
        yield _sse("answer", {
            "message_id": str(msg.id),
            "text": result.text,
            "unsupported": result.unsupported,
            "citations": citations,
        })
        wait_started = time.perf_counter()
        saved = await _learn(db, ctx.workspace.id, user_msg.id, result.kind, trace)
        trace.stages.append(("notes-wait(after answer)", (time.perf_counter() - wait_started) * 1000))
        if saved:
            yield _sse("memory", {"saved": saved})
        yield _sse("done", {})

    async def stream():
        try:
            async for chunk in _run():
                yield chunk
        finally:
            trace.emit()  # one block per message, also when the client left or research failed

    return StreamingResponse(stream(), media_type="text/event-stream")

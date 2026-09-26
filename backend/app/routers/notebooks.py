import asyncio
import json
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from app.auth import Ctx, get_ctx
from app.config import settings
from app.corpus import Corpus
from app.llm.provider import provider_name
from app.models import Artifact, Chat, Citation, Document, DocumentTopic, Message, Notebook, NotebookDocument, Topic
from app.pipeline.research import research
from app.routers.sources import serialize_document
from app.services.artifacts import latest_jobs, serialize_artifact
from app.services.jobs import record_usage

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
        select(Document.id).where(Document.id.in_(ids), Document.workspace_id == ctx.workspace.id)
    ).all())
    existing = set(ctx.db.scalars(select(NotebookDocument.document_id).where(NotebookDocument.notebook_id == nb.id)))
    for doc_id in valid - existing:
        ctx.db.add(NotebookDocument(notebook_id=nb.id, document_id=doc_id))
    return len(valid - existing)


@router.post("")
def create_notebook(body: NotebookIn, ctx: Ctx = Depends(get_ctx)):
    nb = Notebook(workspace_id=ctx.workspace.id, title=body.title.strip(), description=body.description)
    ctx.db.add(nb)
    ctx.db.flush()
    added = _add_docs(ctx, nb, body.document_ids)
    ctx.db.commit()
    return {"id": str(nb.id), "title": nb.title, "added": added}


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
        select(Notebook).where(Notebook.workspace_id == ctx.workspace.id).order_by(Notebook.updated_at.desc())
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
         "artifact_count": artifact_counts.get(n.id, 0),
         "updated_at": n.updated_at.isoformat() if n.updated_at else None}
        for n in rows
    ]


@router.get("/{notebook_id}")
def get_notebook(notebook_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    nb = _get(ctx, notebook_id)
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


@router.get("/chats/{chat_id}/messages")
def chat_messages(chat_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    chat = _get_chat(ctx, chat_id)
    msgs = ctx.db.scalars(select(Message).where(Message.chat_id == chat.id).order_by(Message.created_at)).all()
    doc_ids = {c.document_id for m in msgs for c in m.citations}
    docs = {d.id: d for d in ctx.db.scalars(select(Document).where(Document.id.in_(doc_ids)))} if doc_ids else {}
    out = []
    for m in msgs:
        cites = []
        for c in sorted(m.citations, key=lambda c: c.marker):
            d = docs.get(c.document_id)
            cites.append({"marker": c.marker, "document_id": str(c.document_id), "title": d.title if d else "",
                          "url": d.url if d else "", "path": c.path, "line_start": c.line_start,
                          "line_end": c.line_end, "span": c.span or ""})
        out.append({"id": str(m.id), "role": m.role, "text": m.content, "citations": cites})
    return out


@router.delete("/chats/{chat_id}")
def delete_chat(chat_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    chat = _get_chat(ctx, chat_id)
    ctx.db.delete(chat)
    ctx.db.commit()
    return {"ok": True}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


_STEP_LABEL = {"list": "Scanning the archive", "search": "Searching for", "read": "Reading"}


@router.post("/{notebook_id}/chat")
async def chat(notebook_id: uuid.UUID, body: ChatIn, ctx: Ctx = Depends(get_ctx)):
    nb = _get(ctx, notebook_id)
    db = ctx.db
    chat_row = db.get(Chat, body.chat_id) if body.chat_id else None
    if not chat_row or chat_row.notebook_id != nb.id:
        chat_row = Chat(workspace_id=ctx.workspace.id, notebook_id=nb.id, title=body.question[:120])
        db.add(chat_row)
        db.flush()
    chat_row.updated_at = datetime.now(UTC)  # keeps the history list newest first
    db.add(Message(chat_id=chat_row.id, role="user", content=body.question))
    db.commit()

    docs = db.scalars(
        select(Document)
        .join(NotebookDocument, NotebookDocument.document_id == Document.id)
        .where(NotebookDocument.notebook_id == nb.id, Document.path.is_not(None))
    ).all()
    allowed = {d.path: d.title for d in docs}
    by_path = {d.path: d for d in docs}
    corpus = Corpus(ctx.workspace.id)

    async def stream():
        yield _sse("status", {"chat_id": str(chat_row.id), "message": "Opening the archive"})
        loop = asyncio.get_running_loop()
        steps: asyncio.Queue = asyncio.Queue()

        def on_step(kind: str, detail: str) -> None:
            loop.call_soon_threadsafe(steps.put_nowait, (kind, detail))

        task = asyncio.create_task(asyncio.to_thread(research, corpus, allowed, body.question, on_step))
        while not task.done() or not steps.empty():
            try:
                kind, detail = await asyncio.wait_for(steps.get(), timeout=0.25)
            except TimeoutError:
                continue
            yield _sse("step", {"kind": kind, "message": f"{_STEP_LABEL.get(kind, kind)} {detail}".strip()})
        try:
            result = task.result()
        except Exception:
            yield _sse("error", {"message": "Lost signal while researching. Try again."})
            return

        msg = Message(chat_id=chat_row.id, role="assistant", content=result.text)
        db.add(msg)
        db.flush()
        citations = []
        for c in result.citations:
            doc = by_path.get(c.path)
            if not doc:
                continue
            db.add(Citation(message_id=msg.id, document_id=doc.id, marker=c.marker, path=c.path,
                            line_start=c.line_start, line_end=c.line_end, span=c.quote))
            citations.append({
                "marker": c.marker,
                "document_id": str(doc.id),
                "title": doc.title,
                "url": doc.url,
                "path": c.path,
                "line_start": c.line_start,
                "line_end": c.line_end,
                "span": c.quote,
            })
        db.commit()
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
        yield _sse("answer", {
            "message_id": str(msg.id),
            "text": result.text,
            "unsupported": result.unsupported,
            "citations": citations,
        })
        yield _sse("done", {})

    return StreamingResponse(stream(), media_type="text/event-stream")

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.config import settings
from app.llm.provider import provider_name
from app.models import Chat, Citation, Document, Message, Notebook, NotebookDocument
from app.pipeline.retrieval import grounded_answer, retrieve
from app.services.jobs import record_usage

router = APIRouter(prefix="/api/notebooks", tags=["notebooks"])


class NotebookIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
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


@router.post("")
def create_notebook(body: NotebookIn, ctx: Ctx = Depends(get_ctx)):
    nb = Notebook(workspace_id=ctx.workspace.id, title=body.title, description=body.description)
    ctx.db.add(nb)
    ctx.db.commit()
    return {"id": str(nb.id), "title": nb.title}


@router.get("")
def list_notebooks(ctx: Ctx = Depends(get_ctx)):
    rows = ctx.db.scalars(
        select(Notebook).where(Notebook.workspace_id == ctx.workspace.id).order_by(Notebook.updated_at.desc())
    ).all()
    return [{"id": str(n.id), "title": n.title, "description": n.description} for n in rows]


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
        "documents": [
            {"id": str(d.id), "title": d.title, "url": d.url,
             "published_at": d.published_at.isoformat() if d.published_at else None}
            for d in docs
        ],
    }


@router.post("/{notebook_id}/documents")
def add_documents(notebook_id: uuid.UUID, body: DocumentsIn, ctx: Ctx = Depends(get_ctx)):
    nb = _get(ctx, notebook_id)
    valid = set(
        ctx.db.scalars(
            select(Document.id).where(Document.id.in_(body.document_ids), Document.workspace_id == ctx.workspace.id)
        ).all()
    )
    existing = set(
        ctx.db.scalars(select(NotebookDocument.document_id).where(NotebookDocument.notebook_id == nb.id)).all()
    )
    for doc_id in valid - existing:
        ctx.db.add(NotebookDocument(notebook_id=nb.id, document_id=doc_id))
    ctx.db.commit()
    return {"added": len(valid - existing)}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/{notebook_id}/chat")
async def chat(notebook_id: uuid.UUID, body: ChatIn, ctx: Ctx = Depends(get_ctx)):
    nb = _get(ctx, notebook_id)
    db = ctx.db
    chat_row = db.get(Chat, body.chat_id) if body.chat_id else None
    if not chat_row or chat_row.notebook_id != nb.id:
        chat_row = Chat(workspace_id=ctx.workspace.id, notebook_id=nb.id, title=body.question[:120])
        db.add(chat_row)
        db.flush()
    db.add(Message(chat_id=chat_row.id, role="user", content=body.question))
    db.commit()

    async def stream():
        yield _sse("status", {"chat_id": str(chat_row.id), "message": "Scanning your archive"})
        hits = await run_in_threadpool(retrieve, db, ctx.workspace.id, body.question, nb.id)
        yield _sse("status", {"message": f"Found {len(hits)} relevant passages"})
        answer = await run_in_threadpool(grounded_answer, body.question, hits)
        msg = Message(chat_id=chat_row.id, role="assistant", content=answer.text)
        db.add(msg)
        db.flush()
        citations = []
        for marker, hit in answer.citations:
            db.add(Citation(message_id=msg.id, chunk_id=hit.chunk.id, marker=marker, span=hit.chunk.text[:500]))
            citations.append({
                "marker": marker,
                "chunk_id": str(hit.chunk.id),
                "document_id": str(hit.document.id),
                "title": hit.document.title,
                "url": hit.document.url,
                "heading": hit.chunk.heading,
                "span": hit.chunk.text[:500],
            })
        db.commit()
        if answer.prompt_tokens or answer.completion_tokens:
            record_usage(
                db,
                workspace_id=ctx.workspace.id,
                kind="llm",
                provider=provider_name(),
                model=settings.llm_model,
                quantity=answer.prompt_tokens + answer.completion_tokens,
                unit="tokens",
            )
        yield _sse("answer", {
            "message_id": str(msg.id),
            "text": answer.text,
            "unsupported": answer.unsupported,
            "citations": citations,
        })
        yield _sse("done", {})

    return StreamingResponse(stream(), media_type="text/event-stream")

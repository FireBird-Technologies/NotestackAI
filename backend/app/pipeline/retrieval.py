"""Vector retrieval + grounded answering with citations."""

import uuid
from dataclasses import dataclass

import dspy
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.llm.embeddings import embed_query
from app.llm.postprocess import strip_em_dashes
from app.llm.provider import main_lm, track_usage
from app.llm.signatures import GroundedAnswer
from app.models import Chunk, Document, NotebookDocument


@dataclass
class Retrieved:
    chunk: Chunk
    document: Document


def retrieve(db: Session, workspace_id: uuid.UUID, query: str, notebook_id: uuid.UUID | None, k: int = 8):
    vec = embed_query(query)
    stmt = (
        select(Chunk, Document)
        .join(Document, Document.id == Chunk.document_id)
        .where(Chunk.workspace_id == workspace_id, Chunk.embedding.is_not(None))
    )
    if notebook_id:
        stmt = stmt.join(NotebookDocument, NotebookDocument.document_id == Document.id).where(
            NotebookDocument.notebook_id == notebook_id
        )
    stmt = stmt.order_by(Chunk.embedding.cosine_distance(vec)).limit(k)
    return [Retrieved(c, d) for c, d in db.execute(stmt).all()]


@dataclass
class Answer:
    text: str
    unsupported: bool
    citations: list[tuple[int, Retrieved]]  # (marker, retrieved)
    prompt_tokens: int
    completion_tokens: int


def grounded_answer(question: str, hits: list[Retrieved]) -> Answer:
    if not hits:
        return Answer("I could not find anything about that in your posts yet.", True, [], 0, 0)
    passages = [f"[{i + 1}] {h.document.title}: {h.chunk.text}" for i, h in enumerate(hits)]
    lm = main_lm()
    with track_usage(lm) as usage, dspy.context(lm=lm, adapter=dspy.JSONAdapter()):
        pred = dspy.Predict(GroundedAnswer)(question=question, passages=passages)
    result = pred.result
    used = sorted({i for s in result.sentences for i in s.chunk_ids if 1 <= i <= len(hits)})
    return Answer(
        text=strip_em_dashes(result.answer),
        unsupported=result.unsupported,
        citations=[(i, hits[i - 1]) for i in used],
        prompt_tokens=usage.prompt_tokens,
        completion_tokens=usage.completion_tokens,
    )

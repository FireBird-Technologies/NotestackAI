"""Feeding posts to whole-document modules: numbered passages in, verified SourceRefs out."""

import uuid
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.corpus import Corpus, CorpusError, ScopedTools
from app.models import Document, NotebookDocument, VoiceProfile

DEFAULT_BUDGET = 120_000  # characters across all passages; GLM-5.3 has room, this keeps cost sane


def notebook_docs(db: Session, notebook_id: uuid.UUID) -> list[Document]:
    return list(db.scalars(
        select(Document)
        .join(NotebookDocument, NotebookDocument.document_id == Document.id)
        .where(NotebookDocument.notebook_id == notebook_id, Document.path.is_not(None))
        .order_by(Document.published_at.desc())
    ).all())


def workspace_docs(db: Session, workspace_id: uuid.UUID, ids: list[uuid.UUID] | None = None) -> list[Document]:
    q = select(Document).where(Document.workspace_id == workspace_id, Document.path.is_not(None))
    if ids is not None:
        q = q.where(Document.id.in_(ids))
    return list(db.scalars(q.order_by(Document.published_at.desc())).all())


def passages_for(corpus: Corpus, docs: list[Document], budget_chars: int = DEFAULT_BUDGET) -> list[str]:
    """One string per post: a header line then `n| text` numbered lines (same numbering as read()).
    The budget is split evenly, so one long post cannot crowd out the rest."""
    corpus.sync()
    per_doc = max(budget_chars // max(len(docs), 1), 1500)
    out = []
    for d in docs:
        try:
            lines = corpus.read_lines(d.path)
        except CorpusError:
            continue
        body, used = [], 0
        for n, line in enumerate(lines, start=1):
            if not line.strip():
                continue
            entry = f"{n}| {line}"
            if used + len(entry) > per_doc:
                body.append("[... post continues]")
                break
            body.append(entry)
            used += len(entry) + 1
        out.append(f"FILE {d.path} ({d.title})\n" + "\n".join(body))
    return out


def tools_for(corpus: Corpus, docs: list[Document]) -> ScopedTools:
    return ScopedTools(corpus, {d.path: d.title for d in docs})


def verify_refs(tools: ScopedTools, refs: list[dict]) -> list[dict]:
    """Keep refs that point at real lines of allowed files; attach the quoted text."""
    out = []
    for r in refs or []:
        try:
            start, end = int(r["line_start"]), int(r["line_end"])
        except (KeyError, TypeError, ValueError):
            continue
        quote = tools.quote(r.get("path", ""), start, end)
        if quote:
            out.append({"path": r["path"], "line_start": start, "line_end": max(start, end),
                        "title": tools.allowed.get(r["path"]), "quote": quote[:600]})
    return out


def as_citations(items: list[dict]) -> list[SimpleNamespace]:
    """Dicts from predict() in the shape research.verify_citations expects."""
    out = []
    for c in items or []:
        try:
            out.append(SimpleNamespace(marker=int(c["marker"]), path=c["path"],
                                       line_start=int(c["line_start"]), line_end=int(c["line_end"])))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def voice_text(db: Session, workspace_id: uuid.UUID) -> str:
    vp = db.scalar(select(VoiceProfile).where(VoiceProfile.workspace_id == workspace_id))
    if not vp or not vp.profile_json:
        return "No voice profile yet: write clearly, warmly and concretely."
    p = vp.profile_json
    parts = [p.get("summary", "")]
    for key in ("tone", "vocabulary", "structure_habits", "openings", "avoid"):
        if p.get(key):
            parts.append(f"{key.replace('_', ' ')}: {', '.join(p[key])}")
    if p.get("sentence_length"):
        parts.append(f"sentence length: {p['sentence_length']}")
    return "\n".join(x for x in parts if x)

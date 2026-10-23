import hashlib
import json
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, func, or_, select

from app.auth import Ctx, get_ctx
from app.config import settings
from app.corpus import INDEX, Corpus, CorpusError
from app.models import Artifact, Document, Job, Notebook, NotebookDocument, Source, Upload
from app.pipeline.ingest import (
    IMPORTS_FEED,
    FeedEntry,
    FeedNotFound,
    discover_feed,
    imports_source,
    markdown_to_sections,
    rebuild_index,
    store_entries,
)
from app.services.jobs import create_job, pending_job, serialize_job
from app.services.plans import effective_plan, plan_limit_error, post_room
from app.services.storage import storage
from app.services.url_policy import classify_url

router = APIRouter(prefix="/api/sources", tags=["sources"])


class SourceIn(BaseModel):
    url: str = Field(min_length=3, max_length=1000)
    notebook_id: uuid.UUID | None = None  # added from inside a notebook: its posts join it


class UploadImportIn(BaseModel):
    upload_id: uuid.UUID
    notebook_id: uuid.UUID | None = None


class NotebookLmPostIn(BaseModel):
    """One locally extracted NotebookLM source, chat, or report. Google credentials never reach this API."""

    title: str = Field(min_length=1, max_length=1000)
    content: str = Field(min_length=1, max_length=2_000_000)
    source_url: str | None = Field(None, max_length=1000)
    source_id: str = Field(default="", max_length=300)
    notebook_id: str = Field(default="", max_length=300)
    notebook_title: str = Field(default="", max_length=300)
    kind: Literal["source", "chat", "report"] = "source"
    added_at: datetime | None = None


class NotebookLmArtifactIn(BaseModel):
    """A completed interactive NotebookLM artifact, already read in the user's signed-in browser."""

    external_id: str = Field(min_length=1, max_length=300)
    type: Literal["quiz", "flashcards", "mind_map"]
    title: str = Field(min_length=1, max_length=1000)
    content: dict
    source_url: str | None = Field(None, max_length=1000)
    notebook_id: str = Field(default="", max_length=300)
    notebook_title: str = Field(default="", max_length=300)
    created_at: datetime | None = None


class NotebookLmImportIn(BaseModel):
    transfer_id: str = Field(min_length=8, max_length=100)
    target_notebook_id: uuid.UUID | None = None
    posts: list[NotebookLmPostIn] = Field(default_factory=list, max_length=500)
    artifacts: list[NotebookLmArtifactIn] = Field(default_factory=list, max_length=200)

    @model_validator(mode="after")
    def payload_fits_upload_limit(self):
        if not self.posts and not self.artifacts:
            raise ValueError("NotebookLM transfer has no content.")
        size = sum(len(post.content.encode("utf-8")) for post in self.posts)
        size += sum(len(json.dumps(artifact.content, ensure_ascii=False).encode("utf-8")) for artifact in self.artifacts)
        if size > settings.max_upload_bytes:
            raise ValueError("NotebookLM transfer is too large. Transfer fewer notebooks and try again.")
        return self


def _short_text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _quiz_content(raw: dict, title: str) -> dict:
    questions = []
    for item in raw.get("questions") or []:
        if not isinstance(item, dict):
            continue
        question = _short_text(item.get("question"), 2000)
        options_raw = item.get("answerOptions") or item.get("options") or []
        options, correct, rationales = [], [], []
        for option in options_raw[:20] if isinstance(options_raw, list) else []:
            if isinstance(option, dict):
                text = _short_text(option.get("text"), 1000)
                is_correct = bool(option.get("isCorrect"))
                rationale = _short_text(option.get("rationale"), 2000)
            else:
                text, is_correct, rationale = _short_text(option, 1000), False, ""
            if not text:
                continue
            if is_correct:
                correct.append(len(options))
                if rationale:
                    rationales.append(rationale)
            options.append(text)
        supplied_correct = item.get("correct")
        if not correct and isinstance(supplied_correct, list):
            correct = sorted({index for index in supplied_correct if isinstance(index, int) and 0 <= index < len(options)})
        if not question or len(options) < 2 or not correct:
            continue
        questions.append({
            "type": "multiple_choice" if len(correct) == 1 else "multiple_select",
            "question": question,
            "options": options,
            "correct": correct,
            "explanation": _short_text(item.get("rationale") or item.get("explanation"), 3000)
            or " ".join(rationales) or _short_text(item.get("hint"), 3000),
            "sources": [],
        })
    if not questions:
        raise ValueError("NotebookLM quiz has no playable questions.")
    return {"title": title, "questions": questions, "question_count": len(questions), "source": {"count": 0}}


def _flashcard_content(raw: dict, title: str) -> dict:
    cards = []
    for item in raw.get("cards") or []:
        if not isinstance(item, dict):
            continue
        front = _short_text(item.get("front") or item.get("f"), 300)
        back = _short_text(item.get("back") or item.get("b"), 800)
        if front and back:
            cards.append({"front": front, "back": back, "sources": []})
    if not cards:
        raise ValueError("NotebookLM flashcards have no playable cards.")
    return {"title": title, "cards": cards, "card_count": len(cards), "source": {"count": 0}}


def _mind_map_content(raw: dict, title: str) -> dict:
    tree = raw.get("tree", raw)
    # NotebookLM has shipped both the node itself and small wrappers around it. Peel only well-known/single-value
    # wrappers; the recursive normalizer below remains deliberately conservative about arbitrary payload fields.
    for _ in range(4):
        if not isinstance(tree, dict) or any(_short_text(tree.get(key), 1) for key in ("label", "name", "title", "text", "topic")):
            break
        wrapped = next((tree.get(key) for key in ("root", "mindMap", "mind_map", "tree", "data")
                        if isinstance(tree.get(key), dict | list)), None)
        if wrapped is None and len(tree) == 1:
            only = next(iter(tree.values()))
            wrapped = only if isinstance(only, dict | list) else None
        if wrapped is None:
            break
        tree = wrapped
    counter = 0

    def node(value, depth: int = 0) -> dict | None:
        nonlocal counter
        if counter >= 400 or depth > 8:
            return None
        if isinstance(value, str):
            label, note, children = value, "", []
        elif isinstance(value, dict):
            label = next((_short_text(value.get(key), 300) for key in ("label", "name", "title", "text", "topic")
                          if _short_text(value.get(key), 300)), "")
            note = next((_short_text(value.get(key), 1200) for key in ("note", "description", "summary", "details")
                         if _short_text(value.get(key), 1200)), "")
            children = next((value.get(key) for key in ("children", "nodes", "subtopics", "items")
                             if isinstance(value.get(key), list)), [])
        elif isinstance(value, list):
            if len(value) == 1:
                return node(value[0], depth)
            label, note, children = (title if depth == 0 else "Topic"), "", value
        else:
            return None
        if not label:
            label = title if depth == 0 else "Topic"
        current = counter
        counter += 1
        normalized_children = [child for item in children if (child := node(item, depth + 1))]
        return {"id": "root" if depth == 0 else f"nl-{current}", "label": label, "note": note,
                "sources": [], "children": normalized_children}

    root = node(tree)
    if not root:
        raise ValueError("NotebookLM mind map has no readable nodes.")
    return {"title": title, "root": root, "node_count": counter, "post_count": 0, "document_ids": []}


def _import_notebooklm_artifacts(ctx: Ctx, items: list[NotebookLmArtifactIn]) -> tuple[int, int]:
    """Upsert study artifacts by their stable NotebookLM id. They intentionally belong only to Library."""
    candidates = list(ctx.db.scalars(select(Artifact).where(
        Artifact.workspace_id == ctx.workspace.id,
        Artifact.type.in_(("quiz", "flashcards", "mind_map")),
    )))
    by_external_id = {
        str((artifact.content_json or {}).get("notebooklm", {}).get("artifact_id") or ""): artifact
        for artifact in candidates
        if isinstance((artifact.content_json or {}).get("notebooklm"), dict)
    }
    imported = updated = 0
    for item in items:
        title = item.title.strip()
        try:
            native = _quiz_content(item.content, title) if item.type == "quiz" else (
                _flashcard_content(item.content, title) if item.type == "flashcards" else _mind_map_content(item.content, title)
            )
        except ValueError:
            continue
        origin = {
            "artifact_id": item.external_id,
            "notebook_id": item.notebook_id,
            "notebook_title": item.notebook_title or "NotebookLM notebook",
            "source_url": item.source_url or "",
            "created_at": item.created_at.isoformat() if item.created_at else "",
        }
        content = {**native, "provider": "notebooklm", "transferred_from_notebooklm": True, "notebooklm": origin}
        artifact = by_external_id.get(item.external_id)
        if artifact:
            artifact.type = item.type
            artifact.status = "ready"
            artifact.notebook_id = None
            artifact.document_id = None
            artifact.content_json = content
            updated += 1
        else:
            artifact = Artifact(workspace_id=ctx.workspace.id, notebook_id=None, document_id=None,
                                type=item.type, status="ready", content_json=content)
            if item.created_at:
                artifact.created_at = item.created_at
            ctx.db.add(artifact)
            by_external_id[item.external_id] = artifact
            imported += 1
    return imported, updated


def serialize_source(source: Source, doc_count: int = 0, locked_count: int = 0) -> dict:
    return {
        "id": str(source.id),
        "feed_url": source.feed_url,
        "site_url": source.site_url,
        "platform": source.platform,
        "title": source.title,
        "sync_status": source.sync_status,
        "sync_error": source.sync_error,
        "last_synced_at": source.last_synced_at.isoformat() if source.last_synced_at else None,
        "document_count": doc_count,
        # Found but beyond the plan's post limit: listed, not indexed until the workspace upgrades.
        "locked_count": locked_count,
        "is_imports": source.feed_url == IMPORTS_FEED,
    }


def _get(ctx: Ctx, source_id: uuid.UUID) -> Source:
    source = ctx.db.scalar(select(Source).where(Source.id == source_id, Source.workspace_id == ctx.workspace.id))
    if not source:
        raise HTTPException(404, "Source not found")
    return source


def _enqueue_sync(ctx: Ctx, source: Source, notebook_id: uuid.UUID | None = None) -> Job:
    source.sync_status = "pending"
    return create_job(ctx.db, ctx.workspace.id, "ingest", {"source_id": str(source.id), **_into(ctx, notebook_id)})


def _into(ctx: Ctx, notebook_id: uuid.UUID | None) -> dict:
    """The job param that files imported posts into a notebook of this workspace (404 for anyone else's)."""
    if not notebook_id:
        return {}
    if not ctx.db.scalar(select(Notebook.id).where(Notebook.id == notebook_id, Notebook.workspace_id == ctx.workspace.id)):
        raise HTTPException(404, "Notebook not found")
    return {"notebook_id": str(notebook_id)}


def _check_url(url: str) -> None:
    """A link that can't be added (a social home page, an adult site) is refused before anything is fetched."""
    verdict = classify_url(url)
    if verdict.kind == "blocked":
        raise HTTPException(422, {"code": "source_blocked", "message": verdict.message})


def _doc_count(ctx: Ctx, source: Source) -> int:
    return ctx.db.scalar(select(func.count()).select_from(Document).where(Document.source_id == source.id)) or 0


@router.post("")
async def create_source(body: SourceIn, ctx: Ctx = Depends(get_ctx)):
    _check_url(body.url)
    try:
        found = await run_in_threadpool(discover_feed, body.url)
    except FeedNotFound as exc:
        raise HTTPException(422, {"code": "feed_not_found", "message": str(exc)}) from exc
    existing = ctx.db.scalar(
        select(Source).where(Source.workspace_id == ctx.workspace.id, Source.feed_url == found.feed_url)
    )
    if existing:
        job = _enqueue_sync(ctx, existing, body.notebook_id)
        return {"source": serialize_source(existing, _doc_count(ctx, existing)), "job": serialize_job(job)}
    plan = effective_plan(ctx.db, ctx.workspace)
    count = ctx.db.scalar(
        select(func.count()).select_from(Source)
        .where(Source.workspace_id == ctx.workspace.id, Source.feed_url != IMPORTS_FEED)
    )
    if 0 <= plan.sources <= count:
        raise plan_limit_error(plan, "sources", f"Your plan includes {plan.sources} sources.")
    source = Source(workspace_id=ctx.workspace.id, feed_url=found.feed_url, platform=found.platform,
                    site_url=found.site_url, title=found.title)
    _into(ctx, body.notebook_id)  # checked before the source is saved
    ctx.db.add(source)
    ctx.db.commit()
    job = _enqueue_sync(ctx, source, body.notebook_id)
    return {"source": serialize_source(source), "job": serialize_job(job)}


@router.get("")
def list_sources(ctx: Ctx = Depends(get_ctx)):
    rows = ctx.db.execute(
        select(Source, func.count(Document.id))
        .outerjoin(Document, Document.source_id == Source.id)
        .where(Source.workspace_id == ctx.workspace.id)
        .group_by(Source.id)
        .order_by(Source.created_at)
    ).all()
    locked = dict(ctx.db.execute(
        select(Document.source_id, func.count(Document.id))
        .where(Document.workspace_id == ctx.workspace.id, Document.path.is_(None))
        .group_by(Document.source_id)
    ).all())
    return [serialize_source(s, n, locked.get(s.id, 0)) for s, n in rows]


@router.post("/{source_id}/sync")
def sync_source(source_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    source = _get(ctx, source_id)
    if source.feed_url == IMPORTS_FEED:
        raise HTTPException(400, "Imported posts have no feed to sync.")
    job = _enqueue_sync(ctx, source)
    return {"source": serialize_source(source, _doc_count(ctx, source)), "job": serialize_job(job)}


def remove_documents(ctx: Ctx, docs: list[Document]) -> None:
    """Delete documents plus their corpus files and raw HTML, then rebuild INDEX.md."""
    if not docs:
        return
    paths = {d.path for d in docs if d.path}
    for d in docs:
        if d.raw_html_key:
            storage.delete_prefix(d.raw_html_key.rsplit("/", 1)[0])
    ids = [d.id for d in docs]
    ctx.db.execute(delete(NotebookDocument).where(NotebookDocument.document_id.in_(ids)))
    ctx.db.execute(delete(Document).where(Document.id.in_(ids)))
    ctx.db.flush()
    Corpus(ctx.workspace.id).write_files({INDEX: rebuild_index(ctx.db, ctx.workspace.id)}, remove=paths)


@router.delete("/{source_id}")
def delete_source(source_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    source = _get(ctx, source_id)
    docs = ctx.db.scalars(select(Document).where(Document.source_id == source.id)).all()
    remove_documents(ctx, list(docs))
    ctx.db.delete(source)
    ctx.db.commit()
    return {"ok": True, "removed_posts": len(docs)}


def _require_room(ctx: Ctx) -> None:
    """A link or a file adds a post: refused (with the upgrade prompt) once the plan's posts are all indexed."""
    plan = effective_plan(ctx.db, ctx.workspace)
    if post_room(ctx.db, ctx.workspace.id, plan) <= 0:
        raise plan_limit_error(plan, "indexed_posts", f"Your plan indexes up to {plan.indexed_posts} posts, and they are all "
                                                       "used. Remove a post or upgrade to add more.")


@router.post("/url")
def import_url(body: SourceIn, ctx: Ctx = Depends(get_ctx)):
    _check_url(body.url)
    _require_room(ctx)
    source = imports_source(ctx.db, ctx.workspace.id)
    ctx.db.commit()
    job = create_job(ctx.db, ctx.workspace.id, "import_url", {"source_id": str(source.id), "url": body.url,
                                                              **_into(ctx, body.notebook_id)})
    return {"source": serialize_source(source, _doc_count(ctx, source)), "job": serialize_job(job)}


@router.post("/upload")
def import_upload(body: UploadImportIn, ctx: Ctx = Depends(get_ctx)):
    upload = ctx.db.scalar(select(Upload).where(Upload.id == body.upload_id, Upload.workspace_id == ctx.workspace.id))
    if not upload or upload.status != "complete":
        raise HTTPException(404, "Upload not found or not finished")
    _require_room(ctx)
    source = imports_source(ctx.db, ctx.workspace.id)
    ctx.db.commit()
    job = create_job(ctx.db, ctx.workspace.id, "import_upload",
                     {"source_id": str(source.id), "upload_id": str(upload.id), **_into(ctx, body.notebook_id)})
    return {"source": serialize_source(source, _doc_count(ctx, source)), "job": serialize_job(job)}


def _notebooklm_url(post: NotebookLmPostIn, include_title: bool = True) -> str:
    """Use the original public URL when possible; otherwise make a stable, non-fetchable import identity.

    Without the title the identity survives renaming a source, report or notebook, so a repeat transfer overwrites the
    post instead of adding a second one. Posts stored before that keep their title-based identity (see the lookup in
    import_notebooklm), so nothing already imported is duplicated."""
    if post.source_url and post.source_url.startswith(("http://", "https://")):
        return post.source_url
    parts = (post.notebook_id, post.kind, post.source_id) + ((post.title,) if include_title or not post.source_id else ())
    return f"notebooklm://import/{hashlib.sha256(chr(0).join(parts).encode()).hexdigest()}"


def _queue_notebooklm_processing(ctx: Ctx, changed: list[uuid.UUID]) -> None:
    """Give transferred posts the same background enrichment as uploads and connected sources."""
    if not changed or not settings.llm_api_key:
        return
    ids = [str(doc_id) for doc_id in changed]
    create_job(ctx.db, ctx.workspace.id, "topics", {"document_ids": ids}, max_attempts=2)
    create_job(ctx.db, ctx.workspace.id, "ideas", {"document_ids": ids}, max_attempts=2)
    if not pending_job(ctx.db, ctx.workspace.id, "resurface_scan"):
        create_job(ctx.db, ctx.workspace.id, "resurface_scan", {}, max_attempts=2)


def _notebooklm_metadata(post: NotebookLmPostIn) -> dict:
    return {
        "notebooklm": {
            "kind": post.kind,
            "notebook_id": post.notebook_id,
            "notebook_title": post.notebook_title or "NotebookLM notebook",
            "source_id": post.source_id,
            "source_url": post.source_url or "",
            "added_at": post.added_at.isoformat() if post.added_at else "",
        }
    }


@router.post("/notebooklm")
def import_notebooklm(body: NotebookLmImportIn, ctx: Ctx = Depends(get_ctx)):
    """Store NotebookLM posts plus completed study artifacts; artifacts stay unassigned in Library."""
    target_notebook = None
    if body.target_notebook_id:
        target_notebook = ctx.db.scalar(
            select(Notebook).where(
                Notebook.id == body.target_notebook_id,
                Notebook.workspace_id == ctx.workspace.id,
            )
        )
        if not target_notebook:
            raise HTTPException(404, "Notebook not found")

    source = imports_source(ctx.db, ctx.workspace.id)
    ctx.db.flush()

    # Repeating a transfer updates the same posts and does not consume more allowance. Duplicate URLs inside a transfer
    # are likewise kept once. Apply the plan allowance newest-first; undated legacy extension payloads retain their
    # supplied order after all dated posts.
    unique: list[tuple[NotebookLmPostIn, str]] = []
    seen: set[str] = set()
    ordered = sorted(
        body.posts,
        key=lambda post: post.added_at.timestamp() if post.added_at else float("-inf"),
        reverse=True,
    )
    legacy_urls = {_notebooklm_url(post) for post in ordered}
    known_legacy = set(ctx.db.scalars(
        select(Document.url).where(Document.source_id == source.id, Document.url.in_(legacy_urls))
    )) if legacy_urls else set()
    for post in ordered:
        legacy_url = _notebooklm_url(post)
        url = legacy_url if legacy_url in known_legacy else _notebooklm_url(post, include_title=False)
        if url in seen:
            continue
        seen.add(url)
        unique.append((post, url))

    urls = [url for _, url in unique]
    existing = set(ctx.db.scalars(
        select(Document.url).where(Document.source_id == source.id, Document.url.in_(urls))
    )) if urls else set()
    plan = effective_plan(ctx.db, ctx.workspace)
    room = post_room(ctx.db, ctx.workspace.id, plan)
    accepted: list[tuple[NotebookLmPostIn, str]] = []
    new_taken = 0
    for item in unique:
        if item[1] in existing or new_taken < room:
            accepted.append(item)
            if item[1] not in existing:
                new_taken += 1

    entries = [
        FeedEntry(
            title=post.title.strip(),
            url=url,
            published_at=post.added_at,
            html="",
            sections=markdown_to_sections(post.content),
            metadata=_notebooklm_metadata(post),
        )
        for post, url in accepted
    ]
    indexed, unchanged, changed = store_entries(ctx.db, source, entries)
    # Older transfers may already have the same content without origin metadata. Replaying them should still repair the
    # visible notebook source and transfer label, even though store_entries correctly skipped rewriting their files.
    accepted_by_url = {url: post for post, url in accepted}
    stored = ctx.db.scalars(
        select(Document).where(Document.source_id == source.id, Document.url.in_(accepted_by_url))
    ).all() if accepted_by_url else []
    for doc in stored:
        doc.metadata_json = {**(doc.metadata_json or {}), **_notebooklm_metadata(accepted_by_url[doc.url])}
    if target_notebook:
        existing_links = set(ctx.db.scalars(
            select(NotebookDocument.document_id).where(NotebookDocument.notebook_id == target_notebook.id)
        ))
        for doc in stored:
            if doc.path and doc.id not in existing_links:
                ctx.db.add(NotebookDocument(notebook_id=target_notebook.id, document_id=doc.id))
    source.sync_status = "ok"
    _queue_notebooklm_processing(ctx, changed)
    artifacts_imported, artifacts_updated = _import_notebooklm_artifacts(ctx, body.artifacts)
    ctx.db.commit()

    skipped_plan = len(unique) - len(accepted)
    return {
        "transfer_id": body.transfer_id,
        "plan": plan.id,
        "plan_limit": plan.indexed_posts,
        "room_before": room,
        "received": len(body.posts),
        "eligible": len(unique),
        "imported": indexed,
        "unchanged": unchanged,
        "skipped_plan": skipped_plan,
        "document_ids": [str(doc.id) for doc in stored if doc.path],
        "artifacts_received": len(body.artifacts),
        "artifacts_imported": artifacts_imported,
        "artifacts_updated": artifacts_updated,
    }


documents_router = APIRouter(prefix="/api/documents", tags=["documents"])


def is_locked(d: Document) -> bool:
    """Past the plan's post limit (see ingest.store_locked): listed with title and link only, not indexed."""
    return not d.path and bool((d.metadata_json or {}).get("locked"))


def serialize_document(d: Document, source: Source | None = None) -> dict:
    meta = d.metadata_json or {}
    notebooklm = meta.get("notebooklm") if isinstance(meta.get("notebooklm"), dict) else None
    notebook_title = str(notebooklm.get("notebook_title") or "").strip() if notebooklm else ""
    return {
        "id": str(d.id),
        "title": d.title,
        "url": d.url,
        "path": d.path,
        "source_id": str(d.source_id) if d.source_id else None,
        # Every transferred item is a post whose real source is its NotebookLM notebook, including chat transcripts.
        "source_title": notebook_title if notebook_title else source.title if source else None,
        "added_at": d.created_at.isoformat() if d.created_at else None,
        "published_at": d.published_at.isoformat() if d.published_at else None,
        "transferred_from_notebooklm": bool(notebooklm),
        "words": meta.get("words") or len((d.clean_text or "").split()),
        "evergreen_score": d.evergreen_score,
        "locked": is_locked(d),
    }


def list_columns() -> tuple:
    """What a post list row shows, and no more: a post's text and its metadata (stored ideas, datasets) are most of its
    row, and loading them for every post made a large library take a minute to list. The word count and the locked flag
    come out of the metadata in SQL. Select them from Document outer-joined to Source."""
    return (Document.id, Document.title, Document.url, Document.path, Document.source_id, Document.created_at,
            Document.published_at, Document.evergreen_score,
            Document.metadata_json["words"].as_integer().label("words"),
            Document.metadata_json["locked"].as_boolean().label("locked"), Source.title.label("source_title"))


def serialize_list_rows(db, rows) -> list[dict]:
    """Rows of list_columns() as serialize_document gives them."""
    # Posts stored before the word count was kept: counted from their text, which only they load.
    uncounted = [r.id for r in rows if r.words is None]
    counted = dict(db.execute(select(Document.id, Document.clean_text).where(Document.id.in_(uncounted))).all()) \
        if uncounted else {}
    return [{
        "id": str(r.id), "title": r.title, "url": r.url, "path": r.path,
        "source_id": str(r.source_id) if r.source_id else None, "source_title": r.source_title,
        "added_at": r.created_at.isoformat() if r.created_at else None,
        "published_at": r.published_at.isoformat() if r.published_at else None,
        "words": r.words or len((counted.get(r.id) or "").split()), "evergreen_score": r.evergreen_score,
        "locked": not r.path and bool(r.locked),  # as is_locked
    } for r in rows]


@documents_router.get("")
def list_documents(
    ctx: Ctx = Depends(get_ctx),
    q: str = "",
    source_id: uuid.UUID | None = None,
    indexed_only: bool = False,
    sort: Literal["published", "added"] = "published",
    limit: int = 500,
    offset: int = 0,
):
    query = (
        select(Document, Source)
        .outerjoin(Source, Source.id == Document.source_id)
        .where(Document.workspace_id == ctx.workspace.id)
    )
    if q.strip():
        like = f"%{q.strip()}%"
        query = query.where(or_(Document.title.ilike(like), Document.clean_text.ilike(like)))
    if source_id:
        query = query.where(Document.source_id == source_id)
    if indexed_only:
        query = query.where(Document.path.is_not(None))
    total = ctx.db.scalar(select(func.count()).select_from(query.subquery()))
    order = ((Document.created_at.desc(), Document.published_at.desc().nulls_last()) if sort == "added" else
             (Document.published_at.desc().nulls_last(), Document.created_at.desc()))
    rows = ctx.db.execute(
        query.with_only_columns(*list_columns())
        .order_by(*order)
        .offset(max(offset, 0)).limit(min(limit, 5000))
    ).all()
    return {"total": total, "items": serialize_list_rows(ctx.db, rows)}


@documents_router.get("/{document_id}")
def get_document(document_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    doc = ctx.db.scalar(select(Document).where(Document.id == document_id, Document.workspace_id == ctx.workspace.id))
    if not doc:
        raise HTTPException(404, "Post not found")
    source = ctx.db.get(Source, doc.source_id) if doc.source_id else None
    if is_locked(doc):
        # Listed, not indexed: there is no text to show until the workspace upgrades.
        plan = effective_plan(ctx.db, ctx.workspace)
        return {**serialize_document(doc, source), "lines": [f"# {doc.title}"],
                "preview": True, "limit": plan.indexed_posts}
    lines: list[str] = []
    if doc.path:
        corpus = Corpus(ctx.workspace.id)
        try:
            if not corpus.exists(doc.path):
                corpus.sync()
            lines = corpus.read_lines(doc.path)
        except CorpusError:
            lines = []
    if not lines:
        lines = [f"# {doc.title}", "", *(doc.clean_text or "").splitlines()]
    return {**serialize_document(doc, source), "lines": lines}


@documents_router.delete("/{document_id}")
def delete_document(document_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    doc = ctx.db.scalar(select(Document).where(Document.id == document_id, Document.workspace_id == ctx.workspace.id))
    if not doc:
        raise HTTPException(404, "Post not found")
    remove_documents(ctx, [doc])
    ctx.db.commit()
    return {"ok": True}

"""The suggested templates in the Create report dialog: written by the AI from each post's stored ideas and topics, kept by a hash of
what it read, prepared in the background as soon as ideas are extracted, and served at once whenever the dialog opens."""

import hashlib
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.llm import run
from app.llm.provider import suggest_templates_lm
from app.llm.signatures import SuggestReportTemplates
from app.models import Document, Notebook, ReportTemplateCache
from app.pipeline.generate import ideas_fresh
from app.pipeline.material import max_posts
from app.pipeline.passages import notebook_docs
from app.services.jobs import create_job, pending_job

log = logging.getLogger("notestack")

SUGGEST_ITEMS = 4  # sources the AI reads to suggest templates
SUMMARY_IDEAS = 3  # a post's stored ideas shown to the AI
SUMMARY_CHARS = 350  # most characters of one post's summary
WARM_NOTEBOOKS = 30  # notebooks prepared per run (the most recently changed)
KEEP_PER_WORKSPACE = 10  # stored sets kept per workspace; the oldest go


def summary(d: Document) -> str:
    """A post as the AI sees it when suggesting templates: its title, its topics and the key ideas already extracted from it (the
    ones the Mind Constellation and the topic map are built from), a few hundred characters at most."""
    meta = d.metadata_json or {}
    ideas = [f"{i['label'].strip()}: {(i.get('note') or '').strip()}" for i in meta.get("ideas") or [] if (i.get("label") or "").strip()]
    tags = [t["name"] for t in meta.get("topics") or [] if t.get("name")][:3]
    head = d.title + (f"\nTopics: {', '.join(tags)}" if tags else "")
    return (head + "\n" + "\n".join(f"- {x}" for x in ideas[:SUMMARY_IDEAS]))[:SUMMARY_CHARS]


def stable_order(docs: list[Document]) -> list[Document]:
    """The posts in an order that belongs to the posts, not to the selection: the same posts come first whenever they are picked.
    The templates are read from the first few, so ticking or unticking any other post gives the same input, the same key, and the
    templates kept for it (the ones prepared in the background for the whole notebook) are served at once, not written again."""
    return sorted(docs, key=lambda d: hashlib.sha256(str(d.id).encode()).hexdigest())


def suggestion_items(material: dict[str, str], docs: list[Document]) -> list[str]:
    """What the AI reads: each post's stored summary when it has one (else the start of the post, as `material` holds it), or for
    chats their first exchange. At most SUGGEST_ITEMS, from the posts that come first in stable_order."""
    if not docs:
        return list(material.values())[:SUGGEST_ITEMS]
    out = []
    for d in stable_order(docs):
        item = summary(d) if ideas_fresh(d) else material.get(str(d.id))
        if item:
            out.append(item)
        if len(out) == SUGGEST_ITEMS:
            break
    return out


def cache_key(items: list[str], topic: str) -> str:
    return hashlib.sha256(("\x1f".join(items) + "\x1e" + (topic or "").strip()).encode()).hexdigest()


def _clean(out: dict) -> list[dict]:
    seen, found = set(), []
    for t in out.get("templates") or []:
        name, prompt = (t.get("name") or "").strip(), (t.get("prompt") or "").strip()
        if not name or not prompt or name.lower() in seen:
            continue
        seen.add(name.lower())
        found.append({"id": f"suggested-{len(found) + 1}", "name": name[:60],
                      "description": (t.get("description") or "").strip()[:200], "prompt": prompt[:1500]})
    return found[:4]


def suggest(db: Session, workspace_id: uuid.UUID, items: list[str], topic: str = "") -> list[dict]:
    """Four templates for these sources: the stored ones when the same sources were seen before, else written now (one AI call) and
    stored. A failed or empty answer is never stored. Never raises."""
    if not items:
        return []
    key = cache_key(items, topic)
    hit = db.scalar(select(ReportTemplateCache).where(ReportTemplateCache.workspace_id == workspace_id, ReportTemplateCache.key == key))
    if hit and hit.templates:
        log.info("report templates: kept set served workspace=%s key=%s", workspace_id, key[:10])
        return hit.templates
    log.info("report templates: no kept set, asking the model workspace=%s key=%s items=%d", workspace_id, key[:10], len(items))
    try:
        out = run.predict(SuggestReportTemplates, db=db, workspace_id=workspace_id, lm=suggest_templates_lm(), items=items,
                          topic=(topic or "").strip() or "(none)")
    except Exception:
        log.warning("template suggestions failed", exc_info=True)
        return []
    templates = _clean(out)
    if templates:
        _store(db, workspace_id, key, templates)
    return templates


def _store(db: Session, workspace_id: uuid.UUID, key: str, templates: list[dict]) -> None:
    try:
        row = db.scalar(select(ReportTemplateCache).where(ReportTemplateCache.workspace_id == workspace_id, ReportTemplateCache.key == key))
        if row:
            row.templates = templates
        else:
            db.add(ReportTemplateCache(workspace_id=workspace_id, key=key, templates=templates))
        db.commit()
    except IntegrityError:  # another request stored the same set first
        db.rollback()
        return
    old = db.scalars(select(ReportTemplateCache).where(ReportTemplateCache.workspace_id == workspace_id)
                     .order_by(ReportTemplateCache.updated_at.desc()).offset(KEEP_PER_WORKSPACE)).all()
    for row in old:
        db.delete(row)
    if old:
        db.commit()


def queue_warmup(db: Session, workspace_id: uuid.UUID) -> None:
    """Have the templates for the workspace's notebooks prepared in the background (once at a time). Called when ideas have been
    extracted and when posts join a notebook, so they are ready before anyone opens the dialog."""
    if settings.llm_api_key and not pending_job(db, workspace_id, "report_templates"):
        create_job(db, workspace_id, "report_templates", {}, max_attempts=2)


def warm_workspace(db: Session, workspace_id: uuid.UUID) -> int:
    """Write and keep the templates of each recently changed notebook for the posts its dialog starts with (the newest ones, as the
    dialog ticks them), skipping a notebook whose posts have mostly no stored ideas yet (they are prepared once the ideas land) and
    any set already stored. Returns how many were written."""
    from app.routers.videos import _excerpt, is_locked  # the dialog's own preview of a post, so the keys match

    written = 0
    for nb in db.scalars(select(Notebook).where(Notebook.workspace_id == workspace_id)
                         .order_by(Notebook.updated_at.desc()).limit(WARM_NOTEBOOKS)):
        docs = [d for d in notebook_docs(db, nb.id) if not is_locked(d)][:max_posts()]
        if not docs or sum(1 for d in docs if ideas_fresh(d)) * 2 < len(docs):
            continue
        docs.sort(key=lambda d: d.published_at or d.created_at, reverse=True)
        each = 800 if len(docs) == 1 else 400
        material = {str(d.id): "\n".join(p for p in (d.title or "", _excerpt(d.clean_text, each)) if p) for d in docs}
        items = suggestion_items(material, docs)
        key = cache_key(items, "")
        if items and not db.scalar(select(ReportTemplateCache.id).where(ReportTemplateCache.workspace_id == workspace_id,
                                                                         ReportTemplateCache.key == key)):
            written += bool(suggest(db, workspace_id, items, ""))
    return written

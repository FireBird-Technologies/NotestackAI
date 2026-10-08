"""Infographics: a short block of text written from posts' stored ideas and/or chats (and the user's own prompt),
poured into a premade space theme. The model writes content only (a few hundred tokens), never the page, which is
what keeps it to seconds and keeps every word spelled as written. The page is shown as HTML; the PNG is drawn by the
Remotion service only when someone downloads it."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.corpus import Corpus
from concurrent.futures import ThreadPoolExecutor

from app.infographics.design import LOOKS, STYLES, build_content, render_design
from app.infographics.image import measure_fit
from app.infographics.render import build_html
from app.infographics.themes import theme_id
from app.llm import run
from app.llm.provider import fast_lm
from app.llm.signatures import DesignInfographic
from app.models import Artifact, Chat, Document, Job, Notebook
from app.pipeline.generate import NothingToDo, extract_ideas, ideas_fresh
from app.pipeline.material import chat_material, max_posts
from app.pipeline.passages import notebook_docs, passages_for, workspace_docs
from app.services.jobs import update_job

IDEAS_BUDGET = 7_000  # characters of stored ideas the model reads
CHAT_BUDGET = 9_000  # characters of chat transcript the model reads


def _ideas_text(db: Session, workspace_id: uuid.UUID, docs: list[Document], job: Job | None) -> list[str]:
    """One block per post from the ideas already stored on it (extracted now for a post that has none)."""
    stale = [str(d.id) for d in docs if not ideas_fresh(d)]
    if stale:
        extract_ideas(db, job, workspace_id, stale)
        for d in docs:
            db.refresh(d)
    share = IDEAS_BUDGET // max(len(docs), 1)
    corpus = Corpus(workspace_id)
    out = []
    for d in docs:
        ideas = (d.metadata_json or {}).get("ideas") if ideas_fresh(d) else None
        if ideas:
            lines = []
            for i in ideas:
                points = "; ".join(str(p) for p in (i.get("details") or [])[:3] if isinstance(p, str))
                lines.append(f"- {i.get('label', '')}: {i.get('note', '')}" + (f" ({points})" if points else ""))
            body = "\n".join(lines)
        else:  # extraction failed for this post: its opening lines
            body = "\n".join(passages_for(corpus, [d], budget_chars=share))
        out.append(f"POST {d.title}\n{body}"[:share])
    return out


def _chat_text(db: Session, workspace_id: uuid.UUID, chat_ids: list[uuid.UUID]) -> tuple[list[Chat], list[str]]:
    chats = list(db.scalars(select(Chat).where(Chat.id.in_(chat_ids), Chat.workspace_id == workspace_id)
                            .order_by(Chat.created_at)))
    share = CHAT_BUDGET // max(len(chats), 1)
    return chats, [t[-share:] for t in chat_material(db, chats)]


def write_content(db: Session, job: Job, artifact: Artifact, params: dict) -> tuple[dict, dict, str]:
    """The clamped content, the source it came from and a title. Raises NothingToDo when there is nothing to draw."""
    ws = artifact.workspace_id
    chat_ids = [uuid.UUID(str(i)) for i in params.get("chat_ids") or []]
    picked = [uuid.UUID(str(i)) for i in params.get("document_ids") or []]
    nb = db.get(Notebook, artifact.notebook_id) if artifact.notebook_id else None
    docs: list[Document] = []
    if picked:
        docs = workspace_docs(db, ws, picked)
    elif not chat_ids and nb:
        docs = notebook_docs(db, nb.id)
    docs = docs[:max_posts()]
    chats, chat_blocks = _chat_text(db, ws, chat_ids) if chat_ids else ([], [])
    if not docs and not chat_blocks:
        raise NothingToDo("Pick at least one post or chat for the infographic.")

    update_job(db, job, progress=0.1, message="Reading the key ideas")
    material = (_ideas_text(db, ws, docs, job) if docs else []) + chat_blocks
    prompt = (params.get("instructions") or "").strip()
    title = docs[0].title if docs else (chats[0].title or "Chat")
    update_job(db, job, progress=0.35, message="Designing the infographic")
    style = params.get("style") if params.get("style") in STYLES else "auto"
    content = None
    for _ in range(2):  # one retry when the model gives too little to draw
        out = run.predict(DesignInfographic, db=db, workspace_id=ws, job=job, title=title, material=material,
                          focus=prompt or "(none)", layout_style=f"{style}: {STYLES[style]}" if style != "auto" else "auto",
                          lm=fast_lm())
        content = build_content(out.get("design") or {})
        if content:
            break
    if not content:
        raise NothingToDo("The material did not give enough to draw. Try other posts or add a prompt.")
    source: dict = {"kind": "mixed" if docs and chat_blocks else "posts" if docs else "chats"}
    if docs:
        source["document_ids"] = [str(d.id) for d in docs]
    if chat_blocks:
        source["chat_ids"] = [str(c.id) for c in chats]
    source["count"] = len(docs) + len(chats if chat_blocks else [])
    return content, source, title


def build_infographic(db: Session, job: Job, artifact: Artifact) -> dict:
    """Write the text and keep it with the theme. The page is built from them whenever it is shown (so it is ready at
    once) and shared by link."""
    params = job.params
    theme = theme_id(params.get("theme"))
    content, source, _title = write_content(db, job, artifact, params)
    update_job(db, job, progress=0.8, message="Fitting it to the page")
    content["fit"] = fit_scales(theme, content)
    artifact.content_json = {**(artifact.content_json or {}), "title": f"Infographic: {content['title']}"[:140],
                             "theme": theme, "prompt": (params.get("instructions") or "").strip(), "source": source,
                             "content": content}
    artifact.storage_key = None
    artifact.status = "ready"
    db.commit()
    return {"artifact_id": str(artifact.id)}


def fit_scales(theme: str, content: dict) -> dict:
    """The scale at which the body fits the page, tall and wide (measured in Chrome once, kept with the content)."""
    look = theme if theme in LOOKS else "midnight"
    with ThreadPoolExecutor(max_workers=2) as pool:
        wide, tall = (pool.submit(measure_fit, render_design(look, content, layout, fit=1.0), layout)
                      for layout in ("landscape", "portrait"))
        return {"landscape": wide.result(), "portrait": tall.result()}


def infographic_html(content: dict, layout: str = "portrait") -> str | None:
    """The page for a finished infographic's stored content and look, tall or wide (None when it has none yet). Older
    infographics (fixed text in a premade theme) still draw in that theme."""
    text = content.get("content")
    if not text:
        return None
    theme = theme_id(content.get("theme"))
    if "body_html" in text:
        return render_design(theme if theme in LOOKS else "midnight", text, layout)
    return build_html(theme, text, layout) if "items" in text else None

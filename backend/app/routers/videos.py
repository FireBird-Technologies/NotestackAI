"""Videos, made by blog2video: the 3-step wizard (Project, Template, Voice), script review, status and delete.
Editing after creation is in video_edit.py; voices, templates and styles have their own routers.

The browser only talks to these routes; the backend calls blog2video with our account's API key, which reaches
every video we ever made. So every route that takes a video first checks it belongs to the current workspace
(b2v_access.owned_video: 404 otherwise), and every create has its template, style and voice checked (check_refs).

A video is an Artifact(type="video") with content_json.provider == "blog2video", so it shows up in the Library and
Studio like everything else, plus a b2v_videos row: the ownership and allowance ledger. Routes take our artifact id.

Videos made through the old partner integration have no b2v_videos row. blog2video answers 404 for them now, so
they are "legacy": we keep showing the preview/video links we stored and refuse edits.
"""

import json
import logging
import re
import uuid
from collections.abc import Callable
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field, ValidationError, model_validator
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.config import settings
from app.llm import run
from app.llm.provider import focus_lm
from app.llm.signatures import VideoFocusAngles
from app.models import Artifact, B2VVideo, Chat, Document, Message, Notebook, Upload
from app.routers.sources import is_locked
from app.services import b2v_access, video_focus, video_limits, video_quota
from app.services import blog2video as b2v
from app.services.artifacts import serialize_artifact
from app.services.plans import Plan, plan_limit_error
from app.services.storage import storage
from app.services.video_quota import sync_video_quota, video_usage

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/videos", tags=["videos"])

MIN_CONTENT = 50
MAX_CONTENT = 100_000
MAX_LINKS = 10
MAX_POSTS = 200  # a notebook's posts, combined into one video (the ingest SCAN_CAP)
MAX_CHATS = 5  # notebook chats, combined into one video (the wizard's cap, as for posts)
MAX_FILES = 5
# Sent ahead of chat transcripts: blog2video only takes content, so this tells its script writer what it is reading.
CHAT_CONTEXT = ("The text below is one or more conversations between a user and an AI assistant. Make the video about "
                "the subject of these conversations: the questions the user asked and the answers and conclusions "
                "reached. Present it "
                "as a clear explainer for a general audience, in your own narration. Do not read it out as a dialogue, "
                "and do not mention the chat, the user or the AI assistant.")
FILE_MAX_BYTES = 5 * 1024 * 1024
FILE_TYPES = {".pdf", ".docx", ".pptx", ".md", ".txt", ".vtt"}
LOGO_MAX_BYTES = 2 * 1024 * 1024
LOGO_TYPES = {"image/png", "image/jpeg", "image/webp", "image/svg+xml"}
LANGUAGES = [("en", "English"), ("es", "Spanish"), ("fr", "French"), ("de", "German"), ("it", "Italian"),
             ("pt", "Portuguese"), ("nl", "Dutch"), ("pl", "Polish"), ("hi", "Hindi"), ("ar", "Arabic"),
             ("ja", "Japanese"), ("ko", "Korean"), ("zh", "Chinese"), ("tr", "Turkish"), ("ru", "Russian"),
             ("id", "Indonesian")]

# blog2video status -> our artifact status
STATUS_MAP = {"failed": "failed", "error": "failed", "awaiting_stock_footage_review": "review",
              "awaiting_script_review": "review", "rendering": "rendering"}
# blog2video's statuses while an edit job runs on a finished video, kept on the artifact as they are so the list and
# the editor can tell them from first generation: regenerating is a template switch (its relayout).
JOB_STATUSES = {"regenerating", "voice_regenerating", "language_regenerating", "script_regenerating"}
# Statuses the video list re-checks with blog2video, in case the work ended while nobody was watching.
BUSY_STATUSES = JOB_STATUSES | {"generating", "rendering"}


def b2v_ready(ctx: Ctx = Depends(get_ctx)) -> None:
    if not b2v.configured():
        raise HTTPException(503, {"code": "video_not_configured", "message": "Video is not set up yet."})
    sync_video_quota(ctx.db, ctx.workspace)


@contextmanager
def upstream():
    """blog2video errors -> our HTTP errors. Problems with our own blog2video account (out of videos, key or plan)
    are not the user's: they get "temporarily unavailable" and ops get an ALERT log line."""
    try:
        yield
    except b2v.Denied:
        raise HTTPException(404, "Not found") from None
    except b2v.NotFound as e:
        raise HTTPException(404, str(e)) from None  # e.g. "Scene not found": the editor reloads
    except (b2v.Busy, b2v.TemplateInUse) as e:
        raise HTTPException(e.status, str(e)) from None
    except b2v.BadRequest as e:
        raise HTTPException(400, str(e)) from None
    except b2v.B2VError as e:
        raise HTTPException(e.status if e.status == 503 else 502, str(e)) from None


ROW_FIELDS = {"video_url", "preview_url", "title"}


def store(ctx: Ctx, a: Artifact, row: B2VVideo | None = None, **fields) -> None:
    """Merge fields into content_json (and status), and the reference fields into the video's row, committing only
    when something changed."""
    if row is not None:
        for key in ROW_FIELDS & fields.keys():
            if fields[key] is not None and getattr(row, key) != fields[key]:
                setattr(row, key, fields[key])
                ctx.db.commit()
    content = dict(a.content_json or {})
    status = fields.pop("status", None)
    changed = {k: v for k, v in fields.items() if v is not None and content.get(k) != v}
    if changed or (status and status != a.status):
        a.content_json = {**content, **changed}
        if status:
            a.status = status
        ctx.db.commit()


def sync_status(ctx: Ctx, a: Artifact, row: B2VVideo, s: dict) -> None:
    raw = str(s.get("status") or "")
    video_quota.record_status(ctx.db, row, "failed" if s.get("error") and raw not in STATUS_MAP else raw)
    if s.get("error") or raw in STATUS_MAP:
        status = STATUS_MAP.get(raw, "failed")
    elif raw in JOB_STATUSES:
        status = raw
    elif s.get("ready") or raw in {"generated", "done"}:
        status = "ready"
    else:
        status = "generating"
    store(ctx, a, row, status=status, b2v_status=raw or None, step=s.get("step"), video_url=s.get("video_url"),
          error=s.get("error"))


# The wizard's options (every field of blog2video's 3 steps)


class VideoOptions(BaseModel):
    # Step 1: Project (script review is always off: blog2video goes straight to the video)
    stock_footage_enabled: bool = True
    aspect_ratio: Literal["landscape", "portrait"] = "landscape"
    video_length: Literal["short", "medium"] = "short"
    logo_upload_id: uuid.UUID | None = None  # a file uploaded through /api/storage/uploads
    logo_position: Literal["bottom_right", "bottom_left", "top_left", "top_right"] = "bottom_right"
    logo_opacity: float = Field(0.9, ge=0.1, le=1.0)
    # Step 2: Template
    template: str = Field("default", max_length=100)
    video_style: str = Field("auto", max_length=40)
    accent_color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    bg_color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    text_color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    # Step 3: Voice
    content_language: str | None = Field(None, max_length=10)  # None = detect from the content
    voice_gender: Literal["female", "male", "none"] = "female"
    voice_accent: str = Field("american", max_length=30)
    custom_voice_id: str | None = Field(None, max_length=100)
    bgm_track_id: str | None = Field(None, max_length=100)
    bgm_volume: float = Field(0.10, ge=0, le=1)

    def payload(self) -> dict:
        """The fields blog2video takes, as it names them."""
        # Only the wizard's own fields: a subclass (VideoCreateIn) adds the source, which is sent separately.
        data = self.model_dump(include=set(VideoOptions.model_fields) - {"logo_upload_id"}, exclude_none=True,
                               mode="json")
        data["script_review_enabled"] = False
        if self.voice_gender == "none":
            data.pop("custom_voice_id", None)
        if not self.bgm_track_id:
            data.pop("bgm_volume", None)
        return data


class FocusIn(BaseModel):
    # A source from the workspace: exactly one of these. document_ids are a notebook's ticked posts, combined into one
    # video; chat_ids are notebook chats, sent as their transcripts (combined too).
    document_id: uuid.UUID | None = None
    document_ids: list[uuid.UUID] | None = Field(None, min_length=1, max_length=MAX_POSTS)
    chat_ids: list[uuid.UUID] | None = Field(None, min_length=1, max_length=MAX_CHATS)
    notebook_id: uuid.UUID | None = None  # names a combined video after its notebook

    @model_validator(mode="after")
    def one_source(self):
        if sum(x is not None for x in (self.document_id, self.document_ids, self.chat_ids)) != 1:
            raise ValueError("Pick one source: a notebook, a post or chats")
        return self


class VideoCreateIn(VideoOptions):
    # Source: exactly one of these (the first three as in FocusIn).
    document_id: uuid.UUID | None = None
    document_ids: list[uuid.UUID] | None = Field(None, min_length=1, max_length=MAX_POSTS)
    chat_ids: list[uuid.UUID] | None = Field(None, min_length=1, max_length=MAX_CHATS)
    url: str | None = Field(None, max_length=2000)
    content: str | None = Field(None, max_length=MAX_CONTENT)
    title: str | None = Field(None, max_length=300)
    notebook_id: uuid.UUID | None = None  # names a combined video after its notebook
    # One of the suggested focus topics (/focus-topics): the video is mainly about it. None = the material as a whole.
    focus: str | None = Field(None, max_length=200)
    focus_detail: str | None = Field(None, max_length=400)  # the topic's description: what the video should cover
    # Or the user's own topic, in their words: followed as far as the material supports it (instead of `focus`).
    focus_prompt: str | None = Field(None, max_length=500)

    @model_validator(mode="after")
    def one_source(self):
        if sum(x is not None for x in (self.document_id, self.document_ids, self.url, self.content, self.chat_ids)) != 1:
            raise ValueError("Pick one source: a notebook, a post, chats, a link or pasted text")
        if self.document_ids and len(self.document_ids) == 1:
            self.document_id, self.document_ids = self.document_ids[0], None
        return self

    @model_validator(mode="after")
    def one_focus(self):
        self.focus_prompt = re.sub(r"\s+", " ", self.focus_prompt or "").strip() or None
        if self.focus_prompt and (self.focus or "").strip():
            raise ValueError("Pick a suggested topic or write your own, not both")
        return self


class VideoBatchIn(VideoOptions):
    urls: list[str] = Field(min_length=1, max_length=MAX_LINKS)


def _not_indexed(count: int) -> HTTPException:
    return HTTPException(400, f"{count} of these posts {'is' if count == 1 else 'are'} not indexed on your plan. "
                              "Untick them or upgrade to index your whole archive.")


def _combined(ctx: Ctx, body: FocusIn | VideoCreateIn, limit: int) -> tuple[str, str]:
    """Several posts as one text, oldest first, each given an equal share so none is cut off entirely."""
    ids = set(body.document_ids or [])
    docs = list(ctx.db.scalars(select(Document).where(Document.id.in_(ids),
                                                      Document.workspace_id == ctx.workspace.id)))
    if len(docs) != len(ids):
        raise HTTPException(404, "Post not found")
    locked = sum(is_locked(d) for d in docs)
    if locked:
        raise _not_indexed(locked)
    docs.sort(key=lambda d: (d.published_at is None, d.published_at.timestamp() if d.published_at else 0))
    share = limit // len(docs)
    text = "\n\n".join(f"# {d.title}\n\n{(d.clean_text or '').strip()}"[:share] for d in docs)
    nb = ctx.db.scalar(select(Notebook).where(Notebook.id == body.notebook_id,
                                              Notebook.workspace_id == ctx.workspace.id)) if body.notebook_id else None
    return (nb.title if nb else f"{docs[0].title} + {len(docs) - 1} more"), text


def _cite_free(text: str) -> str:
    """Citation markers ([1], [2]) point at the notebook's posts, which blog2video never sees."""
    return re.sub(r"\s*\[\d+\]", "", text).strip()


def _load_chats(ctx: Ctx, ids: list[uuid.UUID]) -> list[tuple[Chat, list[Message]]]:
    """This workspace's chats, oldest first, each with its messages in order. 404 if any is not ours."""
    chats = list(ctx.db.scalars(select(Chat).where(Chat.id.in_(set(ids)), Chat.workspace_id == ctx.workspace.id)
                                .order_by(Chat.created_at)))
    if len(chats) != len(set(ids)):
        raise HTTPException(404, "Chat not found")
    msgs = ctx.db.scalars(select(Message).where(Message.chat_id.in_([c.id for c in chats]))
                          .order_by(Message.created_at)).all()
    return [(c, [m for m in msgs if m.chat_id == c.id]) for c in chats]


def _chat_title(chat: Chat, msgs: list[Message]) -> str:
    return chat.title or next((m.content for m in msgs if m.role == "user"), "")[:80] or "Chat"


def _chats(ctx: Ctx, ids: list[uuid.UUID], limit: int) -> tuple[str, str]:
    """Chats' turns as one text, each chat given an equal share. Over its share, a chat's oldest turns go so its
    conclusion stays. Several chats are headed by their titles."""
    loaded = _load_chats(ctx, ids)
    share = limit // len(loaded)
    parts = []
    for chat, msgs in loaded:
        if not any(m.role == "assistant" for m in msgs):
            raise HTTPException(400, f'"{_chat_title(chat, msgs)}" has no answers yet')
        turns = [f"{'User' if m.role == 'user' else 'Assistant'}: {t}" for m in msgs if (t := _cite_free(m.content))]
        head = f"# {_chat_title(chat, msgs)}\n\n" if len(loaded) > 1 else ""
        size = len(head) + sum(len(t) + 2 for t in turns)
        while len(turns) > 1 and size > share:
            size -= len(turns.pop(0)) + 2
        parts.append(head + "\n\n".join(turns))
    first = _chat_title(*loaded[0])
    return (first if len(loaded) == 1 else f"{first} + {len(loaded) - 1} more"), "\n\n".join(parts)


def _doc(ctx: Ctx, document_id: uuid.UUID) -> Document:
    doc = ctx.db.scalar(select(Document).where(Document.id == document_id, Document.workspace_id == ctx.workspace.id))
    if not doc:
        raise HTTPException(404, "Post not found")
    if is_locked(doc):
        raise _not_indexed(1)
    return doc


def _source_text(ctx: Ctx, body: FocusIn | VideoCreateIn, limit: int = MAX_CONTENT) -> tuple[str, str]:
    """A workspace source (posts, a chat, one post) or pasted text as a title and one text."""
    if body.document_ids:
        return _combined(ctx, body, limit)
    if body.chat_ids:
        return _chats(ctx, body.chat_ids, limit)
    if body.document_id:
        doc = _doc(ctx, body.document_id)
        return doc.title, (doc.clean_text or "")[:limit]
    return getattr(body, "title", None) or "", getattr(body, "content", None) or ""


def _instructions(body: VideoCreateIn) -> str:
    """What blog2video's script writer is told ahead of the material: what a chat is, and the focus picked or written
    by the user (worded for the house style's depth). Empty when neither applies."""
    parts = [CHAT_CONTEXT] if body.chat_ids else []
    if prompt := (body.focus_prompt or "").replace('"', "'"):
        depth = {"short": " Make it a brief overview.", "medium": " Make it a deep dive."}
        parts.append(f'The user wants this video to focus on: "{prompt}". Follow it only as far as the material below '
                     "supports it: use what the material says about it and leave the rest out. If the material does "
                     "not cover it, ignore this request and make a general video about the material."
                     + depth.get(b2v_access.house_length(body.video_style), ""))
    elif focus := (body.focus or "").strip():
        detail = re.sub(r"\s+", " ", body.focus_detail or "").strip().rstrip(".")
        cover = f" What to cover: {detail}." if detail else ""
        length = b2v_access.house_length(body.video_style)
        if length == "short":
            parts.append(f'The main focus of this video is one topic only: "{focus}".{cover} Make it an overview of '
                         "that topic: cover just the parts of the material about it, briefly, and leave the rest out.")
        elif length == "medium":
            parts.append(f'The main focus of this video is one topic only: "{focus}".{cover} Make it a deep dive into '
                         "that topic: explore it in depth using the parts of the material about it, and leave the rest "
                         "out.")
        else:
            parts.append(f'The main focus of this video is: "{focus}".{cover} Leave out parts of the material not '
                         "about it.")
    return " ".join(parts)


def _source(ctx: Ctx, body: VideoCreateIn) -> tuple[dict, str]:
    """The blog2video source fields and a title for our artifact."""
    if body.url:
        if not re.match(r"https?://", body.url):
            raise HTTPException(400, "Enter a link that starts with http:// or https://")
        return {"url": body.url}, body.title or body.url
    if body.document_id and not (body.focus or body.focus_prompt):
        doc = _doc(ctx, body.document_id)
        if re.match(r"https?://", doc.url or ""):
            return {"url": doc.url, "title": doc.title[:255]}, doc.title
        # Uploaded files have no public link (upload://name): their text is sent instead (below). So is any post
        # given a focus, which goes in front of the text.
    with upstream():  # the focus wording needs the house styles
        head = _instructions(body)
    title, text = _source_text(ctx, body, MAX_CONTENT - len(head) - 10)
    if body.content is not None and not title.strip():
        raise HTTPException(400, "Give the pasted text a title")
    text = text.strip()
    if len(text) < MIN_CONTENT:
        raise HTTPException(400, f"Add at least {MIN_CONTENT} characters of text")
    content = f"{head}\n\n---\n\n{text}" if head else text
    return {"content": content[:MAX_CONTENT], "title": title[:255]}, title


def _metadata(ctx: Ctx, row: B2VVideo, **extra) -> dict:
    """Sent with every create, and returned by blog2video: ties the video back to us from its side too."""
    return {"workspace_id": str(ctx.workspace.id), "user_id": str(ctx.user.id), "video_ref": str(row.id), **extra}


def _check(ctx: Ctx, options: VideoOptions) -> tuple[dict, Plan]:
    payload = options.payload()
    with upstream():  # checking a template or voice may need blog2video's catalog
        # A house style decides the length, whatever the client sent (before the checks, which gate some lengths).
        if length := b2v_access.house_length(payload.get("video_style")):
            payload["video_length"] = length
        plan = b2v_access.check_refs(ctx, payload)
    return payload, plan


def _logo(ctx: Ctx, upload_id: uuid.UUID | None) -> tuple[str, str, bytes] | None:
    if not upload_id:
        return None
    upload = ctx.db.scalar(select(Upload).where(Upload.id == upload_id, Upload.workspace_id == ctx.workspace.id))
    if not upload or upload.status != "complete" or upload.content_type not in LOGO_TYPES:
        raise HTTPException(400, "The logo must be a PNG, JPG, WebP or SVG.")
    data = storage.get_bytes(upload.key)
    if len(data) > LOGO_MAX_BYTES:
        raise HTTPException(400, "The logo must be under 2 MB.")
    return upload.filename, upload.content_type, data


def _start(ctx: Ctx, plan: Plan, title: str, aspect_ratio: str, template: str, created_via: str,
           call: Callable[[B2VVideo], int], logo: tuple[str, str, bytes] | None = None,
           document_id: uuid.UUID | None = None, source_url: str | None = None) -> Artifact:
    """Reserve one video, record it, ask blog2video for it (call returns its id), refund if that fails."""
    if not video_quota.reserve(ctx.db, ctx.workspace.id):
        usage = video_usage(ctx.db, ctx.workspace)
        raise plan_limit_error(plan, "videos",
                               f"You have made {usage['used']} of {usage['limit']} videos this period.")
    try:
        artifact = Artifact(workspace_id=ctx.workspace.id, type="video", status="generating", document_id=document_id,
                            content_json={"provider": "blog2video", "title": title[:300],
                                          "aspect_ratio": aspect_ratio})
        ctx.db.add(artifact)
        ctx.db.flush()
        row = B2VVideo(workspace_id=ctx.workspace.id, user_id=ctx.user.id, artifact_id=artifact.id,
                       created_via=created_via, template_ref=template, title=title[:300], source_url=source_url,
                       aspect_ratio=aspect_ratio,
                       # Keys are unique across our whole blog2video account, so they start with the workspace id.
                       idempotency_key=f"{ctx.workspace.id}:{uuid.uuid4()}" if created_via == "v1" else None)
        ctx.db.add(row)
        ctx.db.commit()
    except Exception:
        ctx.db.rollback()
        video_quota.unreserve(ctx.db, ctx.workspace.id)
        raise
    try:
        with upstream():
            vid = call(row)
    except HTTPException:
        # Refused, or no answer after every retry: the user gets the video back.
        video_quota.refund(ctx.db, row, "failed")
        ctx.db.delete(artifact)
        ctx.db.commit()
        raise
    row.b2v_video_id, row.status = vid, "queued"
    ctx.db.commit()
    store(ctx, artifact, row, b2v_video_id=vid, b2v_status="queued")
    if logo:
        try:
            b2v.upload_logo(vid, *logo)
        except b2v.B2VError:
            log.warning("logo upload failed for video artifact %s", artifact.id)  # the video is made without it
    return artifact


@router.post("", status_code=201)
def create_video(body: VideoCreateIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    """From a link, pasted text or one of the workspace's posts: POST /api/v1/videos, which starts generating."""
    source, title = _source(ctx, body)
    payload, plan = _check(ctx, body)
    logo = _logo(ctx, body.logo_upload_id)

    def call(row: B2VVideo) -> int:
        # Retried with the same key on no answer: blog2video returns the same video, charged once.
        created = b2v.create_video({**source, **payload, "external_user_id": str(ctx.workspace.id),
                                    "metadata": _metadata(ctx, row, artifact_id=str(row.artifact_id),
                                                          document_id=str(body.document_id) if body.document_id
                                                          else None,
                                                          document_ids=[str(d) for d in body.document_ids or []]
                                                          or None,
                                                          chat_ids=[str(c) for c in body.chat_ids or []] or None)},
                                   row.idempotency_key)
        return int(created["video_id"])

    a = _start(ctx, plan, title, body.aspect_ratio, body.template, "v1", call, logo, body.document_id,
               source_url=source.get("url"))
    return serialize_artifact(a)


def _excerpt(text: str | None, limit: int) -> str:
    """The start of a text, cut on a word boundary."""
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0] + "..."


def _focus_material(ctx: Ctx, body: FocusIn) -> tuple[dict[str, str], list[Document]]:
    """What the focus suggestions read, per post or chat (by id): each post's title and the start of its text, or a
    chat's title and first exchange. A little text, so a vague title or an untitled chat still says what it is about.
    Also the posts themselves (none for chats). Checked like a create (another workspace's source 404s, locked posts
    400)."""
    if body.chat_ids:
        loaded = _load_chats(ctx, body.chat_ids)
        answer_len = 600 if len(loaded) == 1 else 300
        material = {}
        for chat, msgs in loaded:
            question = next((m.content for m in msgs if m.role == "user"), "")
            answer = next((m.content for m in msgs if m.role == "assistant"), "")
            parts = [chat.title or "", _excerpt(question, 300), _excerpt(_cite_free(answer), answer_len)]
            if item := "\n".join(p for p in parts if p):
                material[str(chat.id)] = item
        return material, []
    ids = set(body.document_ids or [body.document_id])
    docs = list(ctx.db.scalars(select(Document).where(Document.id.in_(ids),
                                                      Document.workspace_id == ctx.workspace.id)))
    if len(docs) != len(ids):
        raise HTTPException(404, "Post not found")
    if locked := sum(is_locked(d) for d in docs):
        raise _not_indexed(locked)
    docs.sort(key=lambda d: d.published_at or d.created_at, reverse=True)
    each = 800 if len(docs) == 1 else 400
    items = {str(d.id): "\n".join(p for p in (d.title or "", _excerpt(d.clean_text, each)) if p) for d in docs}
    return {k: v for k, v in items.items() if v}, docs


@router.post("/focus-topics")
def focus_topics(body: FocusIn, ctx: Ctx = Depends(get_ctx)):
    """Up to three topics a video from this source could focus on: the topics the workspace already has for it,
    shown as they are (untagged posts are tagged on demand; a chat's are the cited posts' topics). The AI writes them
    only when there are none. Asked for and shown on the wizard's step 1, once the source is chosen."""
    material, docs = _focus_material(ctx, body)
    if not material:
        return {"topics": []}
    ws = ctx.workspace.id
    if body.chat_ids:
        cited, docs = video_focus.chat_citations(ctx.db, ws, body.chat_ids)
        sources = {chat: cited.get(chat, {}) for chat in material}
    else:
        sources = {str(d.id): {d.id: 1.0} for d in docs}
    video_focus.ensure_tags(ctx.db, ws, docs)
    if cards := video_focus.pick_cards(video_focus.build_pool(ctx.db, ws, sources, docs)):
        return {"topics": [{"title": c.name, "description": c.summary} for c in cards]}
    items = list(material.values())[:FOCUS_ITEMS]
    topics: list[dict] = []
    # One retry when the answer has fewer than 3 usable topics (a placeholder for every title, repeats).
    for retry in (False, True):
        out = run.predict(VideoFocusAngles, db=ctx.db, workspace_id=ws, lm=focus_lm(retry), items=items,
                          candidate_tags=[], avoid_titles=[])
        _add_topics(topics, out.get("topics"))
        if len(topics) >= 3:
            break
    return {"topics": topics[:3]}


FOCUS_ITEMS = 5  # posts or chats the AI reads when there are no topics to show
FOCUS_PLACEHOLDERS = {"title", "topic", "description", "summary", "name", "angle", "focus"}


def _add_topics(topics: list[dict], raw) -> None:
    """Add the model's usable topics to `topics` (as {title, description}): a real title, not seen before."""
    for t in raw or []:
        if not isinstance(t, dict):
            continue
        title = str(t.get("topic") or t.get("title") or "").strip().strip(".").strip()[:120]
        description = re.sub(r"\s+", " ", str(t.get("summary") or t.get("description") or "")).strip()[:300]
        if not title or title.lower() in FOCUS_PLACEHOLDERS:
            continue
        if title.lower() not in {x["title"].lower() for x in topics}:
            topics.append({"title": title, "description": description})


@router.post("/batch", status_code=201)
def create_videos(body: VideoBatchIn, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    """Multi-link: one video per link, each charged and keyed on its own. Background music is single-video only."""
    urls = [u.strip() for u in body.urls if re.match(r"https?://\S+", u.strip())]
    if not urls:
        raise HTTPException(400, "Enter at least one link that starts with http:// or https://")
    options = body.model_copy(update={"bgm_track_id": None})
    payload, plan = _check(ctx, options)
    logo = _logo(ctx, body.logo_upload_id)
    made: list[dict] = []
    for url in urls:
        def call(row: B2VVideo, url=url) -> int:
            created = b2v.create_video({"url": url, **payload, "external_user_id": str(ctx.workspace.id),
                                        "metadata": _metadata(ctx, row, artifact_id=str(row.artifact_id))},
                                       row.idempotency_key)
            return int(created["video_id"])

        try:
            made.append(serialize_artifact(_start(ctx, plan, url, body.aspect_ratio, body.template, "v1", call,
                                                  logo, source_url=url)))
        except HTTPException as e:
            if not made:
                raise
            # Keep what was made; say where it stopped (usually the allowance ran out).
            detail = e.detail if isinstance(e.detail, str) else (e.detail or {}).get("message")
            made.append({"error": detail, "url": url})
            break
    return made


@router.post("/upload", status_code=201)
async def create_from_files(files: list[UploadFile] = File(...), options: str = Form("{}"),
                            ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    """From up to 5 documents (pdf, docx, pptx, md, txt, vtt; 5 MB each): blog2video parses them itself.
    `options` is the wizard's VideoOptions as JSON."""
    try:
        opts = VideoOptions.model_validate(json.loads(options or "{}"))
    except (ValueError, ValidationError) as e:
        raise HTTPException(422, str(e)[:500]) from None
    if not files or len(files) > MAX_FILES:
        raise HTTPException(400, f"Add 1 to {MAX_FILES} files.")
    parts: list[tuple[str, bytes, str]] = []
    for f in files:
        name = f.filename or "document"
        if not any(name.lower().endswith(ext) for ext in FILE_TYPES):
            raise HTTPException(400, f"{name}: use PDF, DOCX, PPTX, MD, TXT or VTT.")
        data = await f.read(FILE_MAX_BYTES + 1)
        if len(data) > FILE_MAX_BYTES:
            raise HTTPException(400, f"{name} is over 5 MB.")
        parts.append((name, data, f.content_type or "application/octet-stream"))
    payload, plan = _check(ctx, opts)
    logo = _logo(ctx, opts.logo_upload_id)
    title = parts[0][0].rsplit(".", 1)[0] if len(parts) == 1 else f"{len(parts)} documents"
    form = {k: (str(v).lower() if isinstance(v, bool) else str(v)) for k, v in payload.items()}

    def call(row: B2VVideo) -> int:
        project = b2v.upload_project({**form, "name": title[:255]}, parts)
        pid = int(project["id"])
        try:
            b2v.generate(pid)
        except b2v.B2VError:
            try:
                b2v.delete_project(pid)
            except b2v.B2VError:
                log.warning("could not remove blog2video project %s after generate failed", pid)
            raise
        return pid

    a = _start(ctx, plan, title, opts.aspect_ratio, opts.template, "upload", call, logo)
    return serialize_artifact(a)


# Read


@router.get("/config")
def video_config(ctx: Ctx = Depends(get_ctx)):
    return {"configured": b2v.configured(), **video_limits.report(ctx.db, ctx.workspace)}


@router.get("/quota")
def quota(ctx: Ctx = Depends(get_ctx)):
    return video_usage(ctx.db, ctx.workspace)


def _with_posters(t: dict) -> dict:
    """Poster images for the template picker. Built-in templates have baked posters on blog2video's web app (a few
    have none; the picker then shows the template's colors)."""
    if t.get("preview_image_url") and not t.get("preview_url"):
        return {**t, "preview_url": t["preview_image_url"]}
    if t.get("preview_url") or not t.get("id"):
        return t
    base = f"{settings.b2v_app_url.rstrip('/')}/template-posters/{t['id']}"
    return {**t, "preview_url": f"{base}.webp", "preview_portrait_url": f"{base}-portrait.webp"}


@router.get("/catalog")
def catalog(ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    """What the wizard offers this workspace: built-in templates, its own ready custom templates,
    built-in and its own styles, music, languages. Nothing another workspace made."""
    with upstream():
        builtin = b2v.builtin_templates()
        mine = [{"id": f"custom_{t.b2v_template_id}", "name": t.name, "custom": True}
                for t in b2v_access.my_templates(ctx, ready_only=True)]
        styles = b2v_access.visible_styles(ctx)
        music = b2v.music_tracks()
    return {"templates": [_with_posters(t) for t in builtin if isinstance(t, dict)],
            "my_templates": mine, "video_styles": styles,
            "music": music, "languages": [{"code": c, "name": n} for c, n in LANGUAGES]}


def _restore_missing_artifacts(ctx: Ctx) -> None:
    """A video whose Library item is gone but which was never deleted (b2v_videos is the record) gets its item back,
    rebuilt from the row. E.g. items removed by the Library's delete before it also removed the blog2video video."""
    orphans = ctx.db.scalars(select(B2VVideo).where(
        B2VVideo.workspace_id == ctx.workspace.id, B2VVideo.artifact_id.is_(None),
        B2VVideo.b2v_video_id.is_not(None), B2VVideo.status != "deleted",
        B2VVideo.quota_state != "refunded")).all()
    for row in orphans:
        status = ("ready" if row.status in video_quota.FINISHED else
                  "failed" if row.status in video_quota.FAILED else
                  row.status if row.status in JOB_STATUSES else STATUS_MAP.get(row.status, "generating"))
        a = Artifact(workspace_id=ctx.workspace.id, type="video", status=status,
                     content_json={k: v for k, v in {
                         "provider": "blog2video", "b2v_video_id": row.b2v_video_id, "b2v_status": row.status,
                         "title": row.title or "Video", "aspect_ratio": row.aspect_ratio,
                         "preview_url": row.preview_url, "video_url": row.video_url}.items() if v is not None})
        ctx.db.add(a)
        ctx.db.flush()
        row.artifact_id = a.id
    if orphans:
        ctx.db.commit()


def _needs_title(row: B2VVideo) -> bool:
    return not row.title or row.title == row.source_url or bool(re.match(r"https?://", row.title))


def _set_title(ctx: Ctx, row: B2VVideo, a: Artifact | None, name: str | None) -> None:
    """blog2video names a video after reading its source; until then we only had the link."""
    name = (name or "").strip()[:300]
    if not name or re.match(r"https?://", name) or row.title == name:
        return
    row.title = name
    if a is not None:
        a.content_json = {**(a.content_json or {}), "title": name}
    ctx.db.commit()


def _refresh_titles(ctx: Ctx, pairs: list[tuple[Artifact, B2VVideo]]) -> None:
    """Real titles for videos still titled by their link, from blog2video's video list (one call)."""
    todo = {row.b2v_video_id: (a, row) for a, row in pairs
            if row.created_via == "v1" and row.b2v_video_id and _needs_title(row)}
    if not todo or not b2v.configured():
        return
    try:
        listed = b2v.request("GET", "/api/v1/videos", params={"external_user_id": str(ctx.workspace.id), "limit": 100})
    except b2v.B2VError as e:
        log.warning("could not refresh video titles: %s", e)
        return
    for item in (listed or {}).get("items") or []:
        if item.get("video_id") in todo:
            a, row = todo[item["video_id"]]
            _set_title(ctx, row, a, item.get("name"))


@router.get("")
def list_videos(ctx: Ctx = Depends(get_ctx), limit: int = 30, offset: int = 0):
    """The workspace's videos, newest first, with what the list rows show: title, status, source, scenes, date."""
    _restore_missing_artifacts(ctx)
    arts = [a for a in ctx.db.scalars(
        select(Artifact).where(Artifact.workspace_id == ctx.workspace.id, Artifact.type == "video")
        .order_by(Artifact.created_at.desc()).limit(min(limit, 100)).offset(offset)
    ).all() if (a.content_json or {}).get("provider") == "blog2video"]
    rows = {r.artifact_id: r for r in ctx.db.scalars(
        select(B2VVideo).where(B2VVideo.artifact_id.in_([a.id for a in arts])))} if arts else {}
    _refresh_titles(ctx, [(a, rows[a.id]) for a in arts if a.id in rows])
    _refresh_busy(ctx, [(a, rows[a.id]) for a in arts if a.id in rows])
    out = []
    for a in arts:
        row, content = rows.get(a.id), a.content_json or {}
        out.append({**serialize_artifact(a), "source_url": row.source_url if row else None,
                    "scenes": content.get("scenes"), "b2v_status": (row.status if row else content.get("b2v_status"))})
    return out


def _refresh_busy(ctx: Ctx, pairs: list[tuple[Artifact, B2VVideo]], limit: int = 10) -> None:
    """Ask blog2video about videos still generating, rendering or in an edit job, so one that finished (or failed)
    while nobody had it open shows its real state. A few per page; a blog2video hiccup leaves the stored status."""
    busy = [(a, r) for a, r in pairs if a.status in BUSY_STATUSES and r.b2v_video_id is not None][:limit]
    for a, row in busy:
        try:
            sync_status(ctx, a, row, b2v.status(row.b2v_video_id, row.created_via))
        except b2v.B2VError as e:
            log.info("status refresh for video %s skipped: %s", row.b2v_video_id, e)


def _legacy(a: Artifact) -> dict:
    content = a.content_json or {}
    return {"legacy": True, "status": content.get("b2v_status"), "ready": bool(content.get("video_url")),
            "video_url": content.get("video_url"), "preview_url": content.get("preview_url"),
            "artifact_status": a.status, "artifact": serialize_artifact(a)}


@router.get("/{artifact_id}/status")
def video_status(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    a, vid, row = b2v_access.owned_video(ctx, artifact_id)
    if row is None:
        return _legacy(a)
    try:
        with upstream():
            s = b2v.status(vid, row.created_via)
    except HTTPException as e:
        if e.status_code != 404:
            raise
        s = {"status": "failed", "error": "The video service lost this video."}
    sync_status(ctx, a, row, s)
    return {**s, "video_id": vid, "artifact_status": a.status}


def preview_url(ctx: Ctx, a: Artifact, vid: int, row: B2VVideo | None = None) -> str | None:
    """The public live-preview link (no key needed, safe for the browser). Minted once and kept."""
    url = (row.preview_url if row else None) or (a.content_json or {}).get("preview_url")
    if url:
        return url
    try:
        url = (b2v.preview_token(vid) or {}).get("preview_url")
    except b2v.B2VError as e:
        log.warning("preview token for video %s failed: %s", vid, e)
        return None
    store(ctx, a, row, preview_url=url)
    return url


def _media_url(project_id: int, asset: dict | None, subdir: str, filename: str) -> str:
    if asset and asset.get("r2_url"):
        return asset["r2_url"]
    return f"{settings.b2v_api_base_url.rstrip('/')}/media/projects/{project_id}/{subdir}/{filename}"


def _enrich(project: dict) -> dict:
    """What the scene rows show, worked out once here: each scene's audio and image links (blog2video only gives
    file names), its layout and font sizes, and totals for the preview caption."""
    pid = project.get("id")
    assets = [a for a in project.get("assets") or [] if not a.get("excluded")]
    latest: dict[tuple[str, str], dict] = {}
    for a in sorted(assets, key=lambda a: a.get("id") or 0):  # a regenerated file is a newer asset, same name
        latest[(a.get("asset_type"), a.get("filename"))] = a
    total, images = 0.0, 0
    scenes = []
    for sc in sorted(project.get("scenes") or [], key=lambda s: s.get("order") or 0):
        try:
            code = json.loads(sc.get("remotion_code") or "{}")
        except ValueError:
            code = {}
        custom = str(project.get("template") or "").startswith("custom_")
        props = (code.get("layoutConfig") if custom else code.get("layoutProps")) or {}
        audio = None
        if sc.get("voiceover_path"):
            name = re.split(r"[/\\]", sc["voiceover_path"])[-1]
            asset = latest.get(("audio", name))
            audio = _media_url(pid, asset, "audio", name) + (f"?v={asset['id']}" if asset else "")
        pics = []
        # Stills sit in assignedImage(s); a stock clip in assignedVideo(s). Both fill the scene's visual slot.
        for key in ("assignedImage", "assignedImages", "image", "images", "assignedVideo", "assignedVideos"):
            vals = props.get(key)
            clip = key.startswith("assignedVideo")
            for name in ([vals] if isinstance(vals, str) else vals if isinstance(vals, list) else []):
                if isinstance(name, str) and name and not name.startswith("http"):
                    first, second = ("video", "image") if clip else ("image", "video")
                    asset = latest.get((first, name)) or latest.get((second, name))
                    kind = asset.get("asset_type") if asset else first
                    pics.append({"filename": name, "asset_id": asset.get("id") if asset else None, "kind": kind,
                                 "url": _media_url(pid, asset, "videos" if kind == "video" else "images", name)})
        images += len(pics)
        total += float(sc.get("duration_seconds") or 0) + float(sc.get("extra_hold_seconds") or 0)
        scenes.append({**sc, "audio_url": audio, "images": pics,
                       "layout": code.get("layout") or sc.get("preferred_layout"),
                       "title_font_size": props.get("titleFontSize"),
                       "desc_font_size": props.get("descriptionFontSize")})
    return {**project, "scenes": scenes,
            "summary": {"scenes": len(scenes), "duration_seconds": round(total),
                        "images": sum(1 for a in assets if a.get("asset_type") == "image") or images,
                        "clips": sum(1 for a in assets if a.get("asset_type") == "video")}}


@router.get("/{artifact_id}")
def get_video(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    a, vid, row = b2v_access.owned_video(ctx, artifact_id)
    if row is None:
        return _legacy(a)
    with upstream():
        project = b2v.get_project(vid)
    if row is not None:
        _set_title(ctx, row, a, project.get("name"))
    store(ctx, a, row, video_url=project.get("r2_video_url"), scenes=len(project.get("scenes") or []) or None)
    return {"video_id": vid, "status": project.get("status"), "project": _enrich(project),
            "preview_url": preview_url(ctx, a, vid, row), "video_url": project.get("r2_video_url"),
            "artifact": serialize_artifact(a)}


@router.delete("/{artifact_id}")
def delete_video(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx)):
    """Removes it from Notestack and from blog2video."""
    a, _, _ = b2v_access.owned_video(ctx, artifact_id)
    remove_video(ctx, a)
    return {"ok": True}


def remove_video(ctx: Ctx, a: Artifact) -> None:
    """Delete the video on blog2video, then the artifact. The b2v_videos row stays as the record that it was made
    (status "deleted"): a lifetime allowance (Free) must not get a video back because one was deleted."""
    row = ctx.db.scalar(select(B2VVideo).where(B2VVideo.artifact_id == a.id, B2VVideo.workspace_id == ctx.workspace.id))
    if row is not None and row.b2v_video_id is not None and b2v.configured():
        try:
            b2v.delete_project(row.b2v_video_id)
        except b2v.NotFound:
            pass
        except b2v.B2VError as e:
            raise HTTPException(502, str(e)) from None
    if row is not None:
        row.status, row.artifact_id = "deleted", None
    ctx.db.delete(a)
    ctx.db.commit()


# Script review (status awaiting_script_review): read, rewrite with AI, approve


class DraftScene(BaseModel):
    id: int
    title: str = Field(max_length=255)
    display_text: str | None = Field(None, max_length=3000)
    narration_text: str = Field(max_length=6000)


class ReviewPreviewIn(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    display_text: str = Field(min_length=1, max_length=3000)
    narration_text: str = Field("", max_length=6000)
    draft_scenes: list[DraftScene] = Field(max_length=200)
    revision: int = Field(0, ge=0)


class ReviewApproveScene(DraftScene):
    preferred_layout: str | None = Field(None, max_length=100)
    source_fingerprint: str | None = Field(None, max_length=200)
    accepted_ai_instructions: list[str] = Field(default_factory=list, max_length=10)


class ReviewApproveIn(BaseModel):
    scenes: list[ReviewApproveScene] = Field(max_length=200)


@router.get("/{artifact_id}/script")
def get_script(artifact_id: uuid.UUID, ctx: Ctx = Depends(get_ctx), _: None = Depends(b2v_ready)):
    _, vid, _ = b2v_access.video_or_404(ctx, artifact_id)
    with upstream():
        project = b2v.get_project(vid)
    scenes = sorted(project.get("scenes") or [], key=lambda s: s.get("order", 0))
    return {"status": project.get("status"), "scenes": [
        {k: s.get(k) for k in ("id", "order", "title", "display_text", "narration_text", "preferred_layout")}
        for s in scenes]}


@router.post("/{artifact_id}/script/scenes/{scene_id}/narration-preview")
def narration_preview(artifact_id: uuid.UUID, scene_id: int, body: ReviewPreviewIn, ctx: Ctx = Depends(get_ctx),
                      _: None = Depends(b2v_ready)):
    """Rewrite one scene's narration to match its edited title and text."""
    _, vid, _ = b2v_access.video_or_404(ctx, artifact_id)
    with upstream():
        return b2v.project_call("POST", vid, f"script-review/scenes/{scene_id}/narration-preview",
                                json=body.model_dump(), timeout=60)


@router.post("/{artifact_id}/script/approve")
def approve_script(artifact_id: uuid.UUID, body: ReviewApproveIn, ctx: Ctx = Depends(get_ctx),
                   _: None = Depends(b2v_ready)):
    a, vid, _ = b2v_access.video_or_404(ctx, artifact_id)
    with upstream():
        result = b2v.project_call("POST", vid, "script-review/approve", json=body.model_dump(), timeout=60)
    store(ctx, a, status="generating")
    return result

"""Help bot (bottom right widget). Answers how to questions from the help corpus only, never from a writer's own
notebooks or posts (see support/scope.py). Streams over SSE.

POST /api/support/chat/stream          events: token, answer_done, done, error
GET  /api/support/conversations/latest restore the chat after a refresh
POST /api/support/escalate             "talk to a human" / feature request form, emailed to the team
"""

import json
import logging
import re
import time
import uuid
from collections import defaultdict, deque
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.auth import Ctx, get_ctx
from app.config import settings
from app.llm.postprocess import strip_em_dashes
from app.models import SupportConversation, SupportMessage
from app.models.base import utcnow
from app.services.email import email_service
from app.services.plans import effective_plan
from app.support import escalation as esc
from app.support import llm, memory, prompts, scope
from app.support.llm import LLMError
from app.support.retriever import get_retriever

log = logging.getLogger("notestack.support")
router = APIRouter(prefix="/api/support", tags=["support"])

MAX_ESCALATIONS = 3
DOC_BUDGET_CHARS = 3500
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_hits: dict[uuid.UUID, deque[float]] = defaultdict(deque)  # per process; enough to stop a runaway client


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    page_path: str | None = Field(default=None, max_length=300)
    conversation_id: uuid.UUID | None = None


class EscalateIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    concern: str = Field(min_length=1, max_length=4000)
    reason: str | None = Field(default=None, max_length=32)
    page_path: str | None = Field(default=None, max_length=300)
    conversation_id: uuid.UUID | None = None


def _rate_limit(user_id: uuid.UUID) -> None:
    now, window = time.monotonic(), _hits[user_id]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= settings.support_messages_per_minute:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "You are sending messages quickly. Try again in a minute.")
    window.append(now)


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _excerpt(body: str, query: str, budget: int = DOC_BUDGET_CHARS) -> str:
    """Whole doc when it fits, otherwise the sections that share the most words with the question."""
    if len(body) <= budget:
        return body
    words = set(re.findall(r"[a-z0-9]+", query.lower()))
    sections = re.split(r"(?m)^(?=#{1,3}\s)", body)
    ranked = sorted(range(len(sections)), key=lambda i: -len(words & set(re.findall(r"[a-z0-9]+", sections[i].lower()))))
    keep, used = set(), 0
    for i in ranked:
        if used + len(sections[i]) > budget and keep:
            continue
        keep.add(i)
        used += len(sections[i])
    return "".join(sections[i] for i in sorted(keep))[:budget]


def _docs_block(scored, query: str) -> str:
    if not scored:
        return "(no matching documents)"
    return "\n\n".join(f"--- id: {s.doc.id}\ntitle: {s.doc.title}\n{_excerpt(s.doc.body, query)}" for s in scored)


def _owned(ctx: Ctx, conversation_id: uuid.UUID) -> SupportConversation:
    conv = ctx.db.get(SupportConversation, conversation_id)
    if not conv or conv.user_id != ctx.user.id:
        raise HTTPException(404, "Conversation not found")
    return conv


def _message_out(m: SupportMessage) -> dict:
    return {"id": str(m.id), "role": m.role, "content": m.content, "page_path": m.page_path,
            "cited_docs": m.cited_docs or [], "created_at": m.created_at.isoformat()}


@router.post("/chat/stream")
async def chat_stream(body: ChatIn, ctx: Ctx = Depends(get_ctx)) -> StreamingResponse:
    if not settings.support_enabled:
        raise HTTPException(404, "Help chat is off")
    _rate_limit(ctx.user.id)
    db, message = ctx.db, body.message.strip()
    page = scope.scrub_path(body.page_path)  # ids never reach the prompt, the database or the logs
    conv = _owned(ctx, body.conversation_id) if body.conversation_id else None
    if conv is None:
        conv = SupportConversation(user_id=ctx.user.id, title=message[:120], summary="", session_state={})
        db.add(conv)
        db.flush()
    conv_id = conv.id
    plan = effective_plan(db, ctx.workspace).id

    recent = memory.recent_messages(db, conv_id)
    question_reason = esc.classify_question(message)
    out_of_scope = scope.about_user_data(message)
    short_circuit = esc.should_short_circuit(question_reason) and not out_of_scope

    scored, messages = [], []
    if not out_of_scope and not short_circuit:
        scored = get_retriever().retrieve(
            message, history=memory.user_texts(recent), page_path=page, last_cited=memory.last_cited(recent)
        )
        system = prompts.ANSWER_PROMPT.format(
            docs=_docs_block(scored, message), user_context=memory.state_block(conv.session_state or {}),
            summary=conv.summary or "(none)",
        )
        messages = [{"role": "system", "content": system}]
        messages += [{"role": m.role, "content": m.content} for m in recent]
        messages.append({"role": "user", "content": f"[on {page}]\n{message}" if page else message})

    async def generate() -> AsyncIterator[str]:
        answer, escalate_reason, meta = "", None, llm.Meta()
        if out_of_scope:
            answer, broken = scope.out_of_scope_reply(message)
            escalate_reason = esc.Reason.HUMAN if broken else None
            yield _sse("token", answer)
        elif short_circuit:
            drafted = ""
            try:  # buffered, not streamed: the line is checked before the writer sees it
                async for tok in llm.stream_answer(
                    [{"role": "system", "content": esc.handoff_prompt(question_reason)}, {"role": "user", "content": message}]
                ):
                    drafted += tok
            except LLMError:
                drafted = ""
            drafted = strip_em_dashes(drafted.strip())
            answer = drafted if drafted and esc.handoff_line_is_safe(drafted) else esc.short_circuit_reply(question_reason, len(recent))
            escalate_reason = question_reason
            yield _sse("token", answer)
        else:
            try:
                async for tok in llm.stream_answer(messages):
                    answer += tok
                    yield _sse("token", strip_em_dashes(tok))
            except LLMError:
                yield _sse("error", "The help assistant is unavailable right now. Please try again.")
                return
            answer = strip_em_dashes(answer.strip()) or "Sorry, I could not form an answer."
        yield _sse("answer_done", {"conversation_id": str(conv_id)})

        if not out_of_scope and not short_circuit:
            meta_system = prompts.META_PROMPT.format(
                doc_ids="\n".join(f"- {s.doc.id}: {s.doc.title}" for s in scored) or "(none)"
            )
            try:
                meta = await llm.complete_meta(
                    [{"role": "system", "content": meta_system}, {"role": "user", "content": message},
                     {"role": "assistant", "content": answer}]
                )
            except LLMError:
                meta = llm.Meta()  # the regex nets below still decide escalation
            escalate_reason = (
                (question_reason if question_reason is esc.Reason.FEATURE else None)
                or esc.classify_answer(answer)
                or (esc.Reason.HUMAN if meta.escalate else None)
            )

        valid = {s.doc.id for s in scored}
        citations = [c for c in meta.citations if c in valid]

        db.add(SupportMessage(conversation_id=conv_id, role="user", content=message, page_path=page))
        db.add(SupportMessage(conversation_id=conv_id, role="assistant", content=answer, page_path=page,
                              cited_docs=citations))
        conv.session_state = memory.update_state(conv.session_state or {}, page_path=page, cited=citations, plan=plan)
        db.commit()
        yield _sse("done", {"conversation_id": str(conv_id), "citations": citations,
                            "escalate": bool(escalate_reason),
                            "escalate_reason": escalate_reason.value if escalate_reason else None})

        # After `done`, so the extra call never delays the writer: fold older turns into the rolling summary.
        total = len(db.scalars(select(SupportMessage.id).where(SupportMessage.conversation_id == conv_id)).all())
        if total >= memory.SUMMARIZE_AT:
            fold = memory.to_fold(db, conv_id, recent)
            if fold:
                transcript = "\n".join(f"{m.role.upper()}: {m.content}" for m in fold)
                try:
                    conv.summary = strip_em_dashes(await llm.complete_text(
                        [{"role": "system", "content": prompts.SUMMARY_PROMPT},
                         {"role": "user", "content": f"Previous summary: {conv.summary or '(none)'}\n\nNew turns:\n{transcript}"}],
                        max_tokens=500))[:1200]
                    db.commit()
                except LLMError:
                    log.info("summary update skipped")

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/conversations/latest")
def latest(ctx: Ctx = Depends(get_ctx)):
    conv = ctx.db.scalar(
        select(SupportConversation).where(SupportConversation.user_id == ctx.user.id)
        .order_by(SupportConversation.updated_at.desc()).limit(1)
    )
    if not conv:
        return {"conversation_id": None, "messages": []}
    msgs = ctx.db.scalars(
        select(SupportMessage).where(SupportMessage.conversation_id == conv.id).order_by(SupportMessage.created_at).limit(60)
    ).all()
    return {"conversation_id": str(conv.id), "messages": [_message_out(m) for m in msgs]}


@router.post("/escalate", status_code=status.HTTP_202_ACCEPTED)
def escalate(body: EscalateIn, ctx: Ctx = Depends(get_ctx)):
    from_email = body.email.strip()
    if not _EMAIL.match(from_email):
        raise HTTPException(422, "Please enter a valid email address.")
    concern = body.concern.strip()
    if not concern:
        raise HTTPException(422, "Please describe what you need.")
    transcript: list[tuple[str, str]] = []
    if body.conversation_id:
        conv = _owned(ctx, body.conversation_id)
        if conv.escalation_count >= MAX_ESCALATIONS:
            raise HTTPException(429, "You have already sent this a few times. We will be in touch shortly.")
        rows = ctx.db.scalars(
            select(SupportMessage).where(SupportMessage.conversation_id == conv.id)
            .order_by(SupportMessage.created_at.desc()).limit(6)
        ).all()
        transcript = [(m.role, m.content[:500]) for m in reversed(rows)]
        conv.escalation_count += 1
        conv.updated_at = utcnow()
        ctx.db.commit()
    sent = email_service.send_support_escalation(
        from_email=from_email, name=ctx.user.name, plan=effective_plan(ctx.db, ctx.workspace).id,
        reason=body.reason or "human", concern=concern, page=scope.scrub_path(body.page_path), transcript=transcript,
    )
    if not sent:
        raise HTTPException(502, "We could not send that right now. Please try again.")
    return {"ok": True}

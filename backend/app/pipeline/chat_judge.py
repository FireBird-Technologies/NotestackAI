"""The chat judge: scores a sample of notebook-chat answers in the worker, after they were sent, and records the
scores on the message (recall_json["judge"]) and on its Langfuse trace.

- An answer gets `relevance` (does it answer what was asked) and `faithfulness` (is every claim in the passages it
  cites), each 1 to 5.
- A refusal ("could not find support", or the model saying the posts do not cover it) gets `false_refusal`: a wide
  keyword search over the notebook plus the full post list go to the judge, which says whether the notebook did hold
  the answer. This is the score for "it failed although the notebook covers it".

Queued by the chat router (should_judge in app/routers/notebooks.py) for CHAT_JUDGE_SAMPLE_RATE of answers."""

import logging
import uuid

import dspy
from sqlalchemy import select
from sqlalchemy.orm import Session, load_only

from app.corpus import Corpus
from app.llm.provider import fast_lm
from app.models import Chat, Document, Message, NotebookDocument
from app.observability import langfuse_client as lf
from app.pipeline.prefetch import prefetch

log = logging.getLogger(__name__)

WIDE_TOP_K = 20
WIDE_PER_POST = 3
TITLES_SHOWN = 300
REFUSAL_OUTCOMES = {"writer_uncovered", "refused_no_cites", "cites_dropped"}


class JudgeAnswer(dspy.Signature):
    """Grade an answer from a research assistant that must answer only from a writer's own posts.
    relevance: 5 = answers exactly what was asked, 3 = partly or vaguely, 1 = about something else.
    faithfulness: 5 = every factual claim is stated in the cited passages, 3 = some claims are not in them,
    1 = mostly unsupported or contradicted. Judge only against the cited passages, not your own knowledge."""

    question: str = dspy.InputField()
    answer: str = dspy.InputField()
    cited_passages: str = dspy.InputField()
    relevance: int = dspy.OutputField(desc="1 to 5")
    faithfulness: int = dspy.OutputField(desc="1 to 5")
    reason: str = dspy.OutputField(desc="One sentence: the main problem, or 'fine'")


class JudgeRefusal(dspy.Signature):
    """A research assistant told a writer that their notebook does not cover their question. Decide whether that
    was wrong: do the passages below, or a post whose title clearly matches the question, hold the answer? Answer
    true only when the material really answers the question, not when it is merely on a nearby subject."""

    question: str = dspy.InputField()
    post_titles: str = dspy.InputField(desc="Every post in the notebook")
    passages: str = dspy.InputField(desc="The best passages a wide keyword search found, with their paths")
    evidence_existed: bool = dspy.OutputField()
    best_path: str = dspy.OutputField(desc="The post path that answers it, or empty")
    reason: str = dspy.OutputField(desc="One sentence")


def _question_for(db: Session, msg: Message) -> str:
    return db.scalar(select(Message.content).where(Message.chat_id == msg.chat_id, Message.role == "user",
                                                   Message.created_at <= msg.created_at)
                     .order_by(Message.created_at.desc()).limit(1)) or ""


def _clamp(value, low: int = 1, high: int = 5) -> int:
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return low


def judge_message(db: Session, message_id: uuid.UUID) -> dict:
    msg = db.get(Message, message_id)
    if msg is None or msg.role != "assistant":
        return {"skipped": "message gone"}
    chat = db.get(Chat, msg.chat_id)
    recall = dict(msg.recall_json or {})
    outcome = recall.get("outcome", "")
    question = _question_for(db, msg)
    if not question or chat is None:
        return {"skipped": "no question"}
    result: dict
    with dspy.context(lm=fast_lm()):
        if outcome in REFUSAL_OUTCOMES:
            result = _judge_refusal(db, chat, question)
        else:
            quotes = "\n\n".join(f"[{c.marker}] {c.path} lines {c.line_start}-{c.line_end}\n{c.span or ''}"
                                 for c in sorted(msg.citations, key=lambda c: c.marker)) or "(no citations)"
            pred = dspy.Predict(JudgeAnswer)(question=question, answer=msg.content, cited_passages=quotes)
            result = {"relevance": _clamp(pred.relevance), "faithfulness": _clamp(pred.faithfulness),
                      "reason": (pred.reason or "").strip()[:300]}
    trace_id = recall.get("trace_id")
    for name in ("relevance", "faithfulness"):
        if name in result:
            lf.score(trace_id, name, float(result[name]), comment=result.get("reason") or None,
                     score_id=f"{msg.id}-{name}")
    if "evidence_existed" in result:
        lf.score(trace_id, "false_refusal", 1.0 if result["evidence_existed"] else 0.0, data_type="BOOLEAN",
                 comment=result.get("reason") or None, score_id=f"{msg.id}-false_refusal")
    lf.flush()
    msg.recall_json = {**recall, "judge": result}
    db.commit()
    return result


def _judge_refusal(db: Session, chat: Chat, question: str) -> dict:
    docs = db.scalars(select(Document).join(NotebookDocument, NotebookDocument.document_id == Document.id)
                      .where(NotebookDocument.notebook_id == chat.notebook_id, Document.path.is_not(None))
                      .options(load_only(Document.id, Document.path, Document.title))).all()
    allowed = {d.path: d.title for d in docs}
    if not allowed:
        return {"evidence_existed": False, "best_path": "", "reason": "the notebook has no posts"}
    corpus = Corpus(chat.workspace_id)
    manifest = corpus.sync(tuple(allowed))
    found = prefetch(corpus, allowed, manifest, question, WIDE_TOP_K, WIDE_PER_POST)
    titles = "\n".join(f"{path} | {title}" for path, title in list(allowed.items())[:TITLES_SHOWN])
    pred = dspy.Predict(JudgeRefusal)(question=question, post_titles=titles, passages=found.text)
    return {"evidence_existed": bool(pred.evidence_existed), "best_path": (pred.best_path or "").strip()[:300],
            "reason": (pred.reason or "").strip()[:300], "wide_search_passages": len(found.passages)}

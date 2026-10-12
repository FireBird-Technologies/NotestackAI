"""Learning what to remember: after a chat message, decide whether the writer said something lasting
and update their standing notes. Runs in the worker, off the answer's critical path.

Cost control: greetings never get here, Jev (when configured) answers a cheap yes/no first, and only a
"maybe" pays for the extraction call. The extractor reads the writer's own message only, never post text,
so nothing inside a post can plant a note."""

import logging
import uuid

from sqlalchemy.orm import Session

from app.llm import run
from app.llm.provider import fast_lm
from app.llm.signatures import UpdateMemory
from app.models import Job
from app.services import jev, memory

log = logging.getLogger(__name__)

# Jev only decides whether the extractor is worth a call. A wrong "no" loses a note for good, while a wrong "yes"
# costs one cheap call, so the gate is tuned to skip only when it is very sure. The wording below (a lasting fact can
# sit inside a request) and the skip threshold were chosen from the labeled messages in tests/evals/test_memory_gate.py.
# Before changing either, run the live test in that file and keep it green.
JEV_REMEMBER = {
    "yes": {
        "what": "Anywhere in the message, even inside a question or a task, the writer says something lasting about "
                "themselves: their job or role, who they write for, how they want answers written, a project or goal "
                "they are working on, or a term they use in a special way",
        "examples": ["As a food blogger, summarize my posts about baking",
                     "Please be brief. What did I write about hiring?",
                     "I teach high school physics, so find posts that would suit students",
                     "I'm a consultant preparing a report on onboarding, draft an outline from my notes"],
    },
    "no": {
        "what": "The message only asks a question or gives a task about the posts, and says nothing lasting about "
                "the writer themselves",
        "examples": ["What did I write about pricing?", "Summarize my post on habits", "Thanks, that helps",
                     "Write a script to rename files"],
    },
}
JEV_REMEMBER_QUESTION = ("Does this message from a writer state something lasting that a research assistant "
                         "should remember for every future chat?")
MEMORY_SKIP_CONFIDENCE = 0.8  # skip the extractor only when Jev says "no" at least this firmly


def worth_remembering(message: str) -> bool:
    """False only when Jev says "no" with confidence of MEMORY_SKIP_CONFIDENCE or more. If Jev is off, unsure or
    fails, the LLM decides."""
    if not jev.configured():
        log.info("NOTES GATE  Jev is not configured, so the extraction model decides (no skip)")
        return True
    try:
        answer = jev.decide({"message": message}, {"remember": {
            "instructions": JEV_REMEMBER_QUESTION,
            "criteria": JEV_REMEMBER,
        }})["remember"]
    except jev.JevError as exc:
        log.warning("Jev memory gate failed, asking the LLM", exc_info=True)
        log.info("NOTES GATE  Jev failed (%s), so the extraction model decides (no skip)", exc)
        return True
    skip = answer.choice == "no" and answer.confidence >= MEMORY_SKIP_CONFIDENCE
    log.info("NOTES GATE  Jev says %r, confidence %.2f [%s]  ->  %s", answer.choice, answer.confidence,
             "  ".join(f"{k} {v:.2f}" for k, v in sorted(answer.probabilities.items(), key=lambda kv: -kv[1])),
             f"SKIP the extraction model (a firm 'no' is >= {MEMORY_SKIP_CONFIDENCE})" if skip
             else f"RUN the extraction model (only a 'no' at >= {MEMORY_SKIP_CONFIDENCE} skips)")
    return not skip


def learn_from_message(db: Session, job: Job, workspace_id: uuid.UUID, message: str) -> dict:
    if not worth_remembering(message):
        return {"saved": [], "skipped": "nothing lasting"}
    out = run.predict(UpdateMemory, db=db, workspace_id=workspace_id, job=job, lm=fast_lm(),
                      message=message[:2000], saved_notes=memory.profile_text(memory.list_facts(db, workspace_id)))
    proposed = out.get("operations") or []
    saved = memory.apply_operations(db, workspace_id, proposed)
    log.info("NOTES EXTRACT  model proposed %d change(s): %s  ->  applied %d: %s", len(proposed),
             ", ".join(f"{o.get('op')} {o.get('key')}" for o in proposed) or "none",
             len(saved), ", ".join(f"{c['op']} {c['key']}" for c in saved) or "none")
    return {"saved": saved}

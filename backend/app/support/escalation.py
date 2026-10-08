"""When to offer the "talk to a human" / feature request form instead of (or after) a docs answer.

The metadata LLM call is the main judge; these regexes are the deterministic backstop for terse phrasings and for the
case where that call fails. The must-NOT-fire side matters most: over escalating interrupts a good answer."""

import re
from enum import Enum


class Reason(str, Enum):
    HUMAN = "human"
    REFUND = "refund"
    FEATURE = "feature"


_HUMAN = re.compile(
    r"""(?ix)
    \b(?:human|live\s+(?:agent|support|chat)|customer\s+(?:support|service)|representative|real\s+person)\b
    | \brep\b
    | \bsupport\s+(?:ticket|team|staff|agent)\b
    | \btalk\s+to\s+(?:a|an|someone|somebody|the\s+team|your\s+team)\b
    | \bspeak\s+(?:to|with)\b
    | \b(?:further|more)\s+assistance\b
    | \bneed\s+(?:further\s+|more\s+)?(?:help|assistance)\b
    | \b(?:connect|put)\s+me\s+(?:with|to|in\s+touch)\b
    | \b(?:contact|reach|email|message)\s+(?:the\s+|your\s+|our\s+)?(?:support|team|sales|someone|somebody)\b
    | \bget\s+me\s+(?:support|help|someone|a\s+person)\b
    | \bhuman+\b | \brepresent(?:i|a)tive\b
    """
)
_REFUND = re.compile(
    r"(?ix) \brefun\w*\b | \bchargeback\b | \bmoney\s+back\b | \bbilling\s+dispute\b"
    r" | \bcancel\s+(?:my\s+)?(?:charge|payment)\b"
)
_FRUSTRATION = re.compile(
    r"(?ix) \bcan.?t\s+help\b | \bcannot\s+help\b | \buseless\b | \bgive\s+up\b | \bnot\s+helpful\b"
    r" | \bwaste\s+of\s+(?:time|money)\b | \bfed\s+up\b"
)
# A request verb, never a capability question: "what formats do you support" must stay quiet.
_FEATURE = re.compile(
    r"""(?ix)
    \b(?:add|build|implement|introduce)\s+(?:a\s+|an\s+)?(?:feature|integration)\b
    | \b(?:add|build|implement)\s+support\s+for\b
    | \bfeature\s+request\b | \brequest\s+a\s+feature\b | \bon\s+the\s+roadmap\b
    | \bwill\s+you\s+(?:ever\s+)?(?:add|support|offer|have)\b
    | \bany\s+plans?\s+to\b | \bdo\s+you\s+(?:ever\s+)?plan\s+to\b | \bplease\s+add\b
    | \bwould\s+be\s+great\s+if\s+you\s+(?:supported|added)\b
    """
)
_BARE_ASK = re.compile(r"^\s*(?:support|help)\s*[!.?]*\s*$", re.I)
_HANDOFF_REQUEST = re.compile(
    r"(?ix)\b(?:pass|send|forward|route|hand)\b[^.?!]{0,40}"
    r"\b(?:to\s+|t\s+)?(?:the\s+|your\s+|our\s+)?(?:team|support|human|person|someone)\b"
)
_AFFIRMATIVE = re.compile(
    r"(?ix)^\s*(?:yes|yeah|yep|sure|okay|ok|please|do\s+it|go\s+ahead|that(?:'s|\s+is)\s+fine)"
    r"(?:\s+please)?[\s!.]*$"
)

# The bot offering the team in its own answer ("I can pass this to our team").
_ANSWER_OFFERS_TEAM = re.compile(
    r"(?i)\b(?:pass|send|forward|route|hand)\b[^.?!]{0,30}\b(?:team|human|person|someone)\b|\bour\s+team\b"
)


def classify_question(message: str) -> Reason | None:
    if _REFUND.search(message):
        return Reason.REFUND
    if (_HUMAN.search(message) or _HANDOFF_REQUEST.search(message)
            or _BARE_ASK.match(message) or _FRUSTRATION.search(message)):
        return Reason.HUMAN
    if _FEATURE.search(message):
        return Reason.FEATURE
    return None


def accepts_previous_handoff(message: str, previous_assistant: str | None) -> bool:
    """A short yes after the bot offers the team is a handoff request, not a new greeting."""
    return bool(previous_assistant and _AFFIRMATIVE.match(message) and _ANSWER_OFFERS_TEAM.search(previous_assistant))


def should_short_circuit(reason: Reason | None) -> bool:
    """Refund and human requests skip the docs entirely: answering them from docs just stalls the writer."""
    return reason in (Reason.HUMAN, Reason.REFUND)


def classify_answer(answer: str) -> Reason | None:
    return Reason.HUMAN if _ANSWER_OFFERS_TEAM.search(answer) else None


# Claims the bot cannot back up: nothing is sent until the writer submits the form.
_FALSE_ACTION = re.compile(
    r"(?i)\b(?:i(?:'ve|\s+have|\s+will|'ll)?\s+"
    r"(?:sent|forwarded|passed|escalated|opened|created|notified|contacted|connected))\b"
    r"|\b(?:you(?:'re|\s+are)\s+(?:now\s+)?connected)\b|\bticket\s+(?:has\s+been|is)\b"
)


def handoff_line_is_safe(line: str) -> bool:
    return not _FALSE_ACTION.search(line)


_CANNED = {
    Reason.HUMAN: [
        "Happy to get you to our team. Fill in the form below and we will email you back.",
        "Sure, our team can take it from here. Send them a note with the form below.",
    ],
    Reason.REFUND: [
        "Refunds are handled by our team. Use the form below and they will email you back.",
        "I can't change billing myself, but our team can. Send them a note with the form below.",
    ],
}


def short_circuit_reply(reason: Reason, seed: int = 0) -> str:
    options = _CANNED.get(reason, _CANNED[Reason.HUMAN])
    return options[seed % len(options)]


def handoff_prompt(reason: Reason) -> str:
    topic = "a refund or billing problem" if reason is Reason.REFUND else "talking to a person"
    return (
        f"You are the help assistant for Notestack. The writer is asking about {topic}. Reply in one or two "
        "short, warm sentences that respond to what they said, and tell them to use the form below to reach "
        "the team. Never say you have sent, forwarded, opened or escalated anything, and never say they are "
        "connected to someone: nothing is sent until they submit the form. Do not use em dashes. "
        "Do not answer the underlying question."
    )

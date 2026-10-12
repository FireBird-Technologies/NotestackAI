"""Scope gate: the help bot explains how Notestack works. It never reads or discusses a writer's own notebooks,
posts, sources, files or generated work (the chat inside a notebook does that, with citations).

This runs before any model call, so the rule does not depend on the model behaving."""

import re

_ID_SEGMENT = re.compile(
    r"/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d+)(?=/|$)", re.I
)


def scrub_path(path: str | None) -> str | None:
    """Keep only the route shape: no query string, no ids. /app/notebooks/<uuid> -> /app/notebooks/:id"""
    if not path:
        return None
    path = path.split("?", 1)[0].split("#", 1)[0][:200]
    if not path.startswith("/"):
        return None
    return _ID_SEGMENT.sub("/:id", path)


# "How do I ..." style questions are product help even when they mention "my notebook".
_HOWTO = re.compile(
    r"^\s*(?:hi|hello|hey|please|ok|okay)?[\s,!.]*(?:how\s+(?:do|can|could|should|to|does|would)\b|i(?:\s+(?:really|just))?\s+(?:want|need|wanna|would\s+like|'d\s+like)\s+to\b|make\s+me\b|where\s+(?:do|can|is|are)\b|"
    r"can\s+(?:i|you|notestack)\b|could\s+(?:i|you)\b|is\s+it\s+possible\b|which\s+plan\b|what\s+(?:does|is\s+a|is\s+the)\b|"
    r"(?:can|could|will|would|do|does|are|is)\s+(?:people|anyone|anybody|others|someone|they|readers?|visitors?)\b)",
    re.I,
)
_MINE = (
    r"(?:notebooks?|posts?|articles?|sources?|archive|documents?|newsletters?|blog|videos?|audio|podcasts?|"
    r"reports?|quiz(?:zes)?|flashcards?|infographics?|mind\s*(?:map|constellation)s?|launch\s*kits?|drafts?|files?|chats?|conversations?|topics?|quotes?|summar(?:y|ies)|writing|content|stuff|data)"
)
_ABOUT_MY_DATA = re.compile(
    rf"""(?ix)
    \bmy\s+(?:[\w'-]+\s+){{0,3}}{_MINE}\b
    | \b(?:what|which|show|list|find|tell)\b[^.?!]{{0,40}}\b(?:i|we)\s+(?:have\s+)?(?:wrote|written|said|posted|published|uploaded|added)\b
    | \b(?:what|which|show|list|find|tell)\b[^.?!]{{0,40}}\b{_MINE}\b[^.?!]{{0,20}}\b(?:i|we)\s+have\b
    | \bhow\s+many\b[^.?!]{{0,40}}\b(?:do\s+i|have\s+i|did\s+i|i\s+have)\b
    | \b(?:summari[sz]e|analy[sz]e|review|compare|search)\b[^.?!]{{0,30}}\b(?:my|this|the)\s+(?:\w+\s+)?{_MINE}\b
    | \bwhat(?:'s|\s+is)\s+in\s+(?:my|this|the)\s+{_MINE}\b
    | \bwhat\s+did\s+i\s+(?:write|say|post|publish)\b
    | \bwhat\s+(?:did|have|were)\s+we\s+(?:talk|chat|discuss|speak|cover|say)\w*\b
    | \bwhat\s+(?:we|i)\s+(?:talked|chatted|discussed|spoke|covered)\b
    | \b(?:earlier|previous|last|past|old|other)\s+(?:chat|conversation|discussion|thread)s?\b
    | \bour\s+(?:chat|conversation|discussion|thread)s?\b
    | \b(?:recap|remind\s+me|repeat)\b[^.?!]{{0,40}}\b(?:chat|conversation|discussion|said|discussed)\b
    """
)
# A question about what the plans include ("How many Launch Kits do I get on each plan?") is product help, not about the
# writer's own content, unless it also asks what they have made or hold.
_PLAN_WORDS = re.compile(r"(?i)\b(?:plans?|tiers?|pricing|prices?|free|writer|studio|allowance|limits?|upgrade|subscription)\b")
_OWN_STATE = re.compile(r"(?i)\b(?:i\s+have|have\s+i|did\s+i|i\s+(?:wrote|made|created|used|posted|published))\b")
_OWN_CONTENT = re.compile(
    rf"(?i)\bmy\s+(?:[\w'-]+\s+){{0,3}}{_MINE}\b|\b(?:the|this)\s+(?:notebook|chat|conversation)\b|\b(?:in|from)\s+(?:our|my|this)\s+(?:chat|conversation|notebook)\b"
)
# Words that mean something went wrong with their work; the reply also offers the human form.
_BROKEN = re.compile(
    r"(?i)\b(?:fail\w*|slow|forever|too\s+long|taking\s+(?:so\s+|way\s+)?long|hang\w*"
    r"|never\s+(?:finish|load|appear)\w*|error|broken|stuck|crash\w*|not\s+working|won'?t|doesn'?t\s+work|missing|lost)\b"
)

OUT_OF_SCOPE_REPLY = (
    "I can help with how Notestack works, but I can't see your notebooks, posts, files or account, so I can't answer "
    "questions about your own content. For questions about what you wrote, open the notebook and ask in its chat. "
    "Answers there cite your exact lines."
)
OUT_OF_SCOPE_BROKEN_SUFFIX = " If something looks broken, I can pass it to our team."


def about_user_data(message: str) -> bool:
    """True when the message asks about the writer's own content or account state rather than how to do something."""
    text = message.strip()
    if _HOWTO.match(text) and not re.search(r"(?i)\b(?:i|we)\s+(?:wrote|said|posted|published)\b", text):
        return False
    if _PLAN_WORDS.search(text) and not _OWN_STATE.search(text) and not _OWN_CONTENT.search(text):
        return False
    return bool(_ABOUT_MY_DATA.search(text))


def out_of_scope_reply(message: str) -> tuple[str, bool]:
    """(reply, offer_human_form)"""
    broken = bool(_BROKEN.search(message))
    return OUT_OF_SCOPE_REPLY + (OUT_OF_SCOPE_BROKEN_SUFFIX if broken else ""), broken


# Any kind of price reduction. The bot has no information on these, so it never answers or guesses; the writer is
# pointed to the team instead (a fixed reply, no model call, so it cannot invent a discount or confirm one).
_DISCOUNT = re.compile(
    r"""(?ix)
    \b(?:discounts?|discounted|coupons?|promo(?:tions?|\s*codes?)?|voucher|vouchers|cheaper|price\s+(?:drop|cut|match)|
    reduced\s+(?:price|rate)|special\s+(?:price|pricing|rate|offer)|special\s+deals?|(?:any|a|good|best)\s+deals?|
    on\s+sale|sales?\s+(?:price|event)|black\s+friday|cyber\s+monday|lifetime\s+deal|appsumo|
    (?:student|educator|teacher|nonprofit|non-profit|ngo|startup|academic)\s+(?:plan|pricing|price|rate|discount)s?|
    (?:\d+\s*%|percent)\s+off|money\s+off|save\s+(?:money|on)|bundle|bulk|volume\s+pricing|negotiat\w*)\b
    """
)
DISCOUNT_REPLY = (
    "I'm sorry, I don't have any information about discounts or special pricing. "
    "If you'd like to ask about it, use the form below and our team will email you back."
)


def asks_for_discount(message: str) -> bool:
    return bool(_DISCOUNT.search(message))

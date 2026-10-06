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
    r"^\s*(?:hi|hello|hey|please|ok|okay)?[\s,!.]*(?:how\s+(?:do|can|could|should|to|does|would)\b|where\s+(?:do|can|is|are)\b|"
    r"can\s+(?:i|you|notestack)\b|could\s+(?:i|you)\b|is\s+it\s+possible\b|which\s+plan\b|what\s+(?:does|is\s+a|is\s+the)\b)",
    re.I,
)
_MINE = (
    r"(?:notebooks?|posts?|articles?|sources?|archive|documents?|newsletters?|blog|videos?|audio|podcasts?|"
    r"launch\s*kits?|drafts?|files?|chats?|conversations?|topics?|quotes?|summar(?:y|ies)|writing|content|stuff|data)"
)
_ABOUT_MY_DATA = re.compile(
    rf"""(?ix)
    \bmy\s+(?:[\w'-]+\s+){{0,3}}{_MINE}\b
    | \b(?:what|which|show|list|find|tell)\b[^.?!]{{0,40}}\b(?:i|we)\s+(?:wrote|written|said|posted|published|have|uploaded|added)\b
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
# Words that mean something went wrong with their work; the reply also offers the human form.
_BROKEN = re.compile(r"(?i)\b(?:fail\w*|error|broken|stuck|crash\w*|not\s+working|won'?t|doesn'?t\s+work|missing|lost)\b")

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
    return bool(_ABOUT_MY_DATA.search(text))


def out_of_scope_reply(message: str) -> tuple[str, bool]:
    """(reply, offer_human_form)"""
    broken = bool(_BROKEN.search(message))
    return OUT_OF_SCOPE_REPLY + (OUT_OF_SCOPE_BROKEN_SUFFIX if broken else ""), broken

"""Keep internal notebook bookkeeping out of names shown to writers."""

import re

_INTERNAL_TAG = re.compile(r"\s*\([0-9a-f]{6}\)\s*$", re.IGNORECASE)
def visible_notebook_title(title: str) -> str:
    """Remove the old six-character selection key from a writer-facing title."""
    return _INTERNAL_TAG.sub("", title.strip()).strip()

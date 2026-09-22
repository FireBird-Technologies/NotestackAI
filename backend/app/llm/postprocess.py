"""Last pass on every generated string. Non-negotiable: no em dashes in generated copy."""

import re

_SPACED_DASH = re.compile(r"\s*[—―]\s*")
_EN_DASH_SPACED = re.compile(r"\s+–\s+")


def strip_em_dashes(text: str) -> str:
    text = _SPACED_DASH.sub(", ", text)
    text = _EN_DASH_SPACED.sub(", ", text)
    return text.replace(",,", ",").replace(" ,", ",")


def clean_output(value):
    """Recursively clean strings inside dicts/lists/pydantic dumps."""
    if isinstance(value, str):
        return strip_em_dashes(value)
    if isinstance(value, list):
        return [clean_output(v) for v in value]
    if isinstance(value, dict):
        return {k: clean_output(v) for k, v in value.items()}
    return value

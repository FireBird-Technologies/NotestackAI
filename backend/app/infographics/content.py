"""What an infographic says: a short, length-limited block of text the premade themes pour into their layout.
Model output is never trusted for layout, so every field is stripped of markup and clamped here."""

import re

from pydantic import BaseModel

WIDTH, HEIGHT = 1600, 2260

# Characters per field: the themes are drawn so the longest allowed text still fits its box.
LIMITS = {"title": 60, "subtitle": 110, "label": 34, "item_name": 22, "item_text": 120, "step_name": 14,
          "step_text": 78, "rule": 80, "note": 90}
ITEMS = (3, 5)
STEPS = (4, 8)
NOTES = 3


class Entry(BaseModel):
    name: str
    text: str


class InfographicContent(BaseModel):
    title: str
    subtitle: str
    items_label: str
    items: list[Entry]
    steps_label: str
    steps: list[Entry]
    rule: str
    notes: list[str]


_TAGS = re.compile(r"<[^>]*>")
_SPACE = re.compile(r"\s+")


def _clip(text: object, limit: int) -> str:
    """Plain text of at most `limit` characters, cut at a word with an ellipsis when it was longer."""
    s = _SPACE.sub(" ", _TAGS.sub(" ", str(text or ""))).replace("—", ",").replace("–", "-").strip()
    if len(s) <= limit:
        return s
    cut = s[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:.-") or s[: limit - 1]
    return cut + "…"


def _entries(raw: object, name_limit: int, text_limit: int, count: tuple[int, int]) -> list[dict]:
    out = []
    for e in (raw if isinstance(raw, list) else []):
        e = e if isinstance(e, dict) else getattr(e, "__dict__", {})
        name, text = _clip(e.get("name"), name_limit), _clip(e.get("text"), text_limit)
        if name and text:
            out.append({"name": name, "text": text})
    return out[: count[1]] if len(out) >= count[0] else []


def clamp(raw: dict) -> dict | None:
    """The content in the shape the themes draw, or None when there is too little to draw (too few items or steps)."""
    if hasattr(raw, "model_dump"):
        raw = raw.model_dump()
    items = _entries(raw.get("items"), LIMITS["item_name"], LIMITS["item_text"], ITEMS)
    steps = _entries(raw.get("steps"), LIMITS["step_name"], LIMITS["step_text"], STEPS)
    title = _clip(raw.get("title"), LIMITS["title"])
    if not items or not steps or not title:
        return None
    notes = [n for n in (_clip(n, LIMITS["note"]) for n in raw.get("notes") or []) if n][:NOTES]
    return {"title": title, "subtitle": _clip(raw.get("subtitle"), LIMITS["subtitle"]),
            "items_label": _clip(raw.get("items_label"), LIMITS["label"]) or "Key ideas",
            "items": items,
            "steps_label": _clip(raw.get("steps_label"), LIMITS["label"]) or "How it works",
            "steps": steps, "rule": _clip(raw.get("rule"), LIMITS["rule"]), "notes": notes}


SAMPLE = {
    "title": "From Prompt to Production Agent",
    "subtitle": "Five engineering layers plus an eight step production request flow",
    "items_label": "The five layers",
    "items": [
        {"name": "Prompt", "text": "Optimizes wording, examples, and format in a single request."},
        {"name": "Context", "text": "Curates docs, history, tools, and memory before each model call."},
        {"name": "Harness", "text": "Scaffolding around the model: tools, verification, and guardrails."},
        {"name": "Loop", "text": "Runs reason, act and observe cycles until a stop condition is met."},
        {"name": "Graph", "text": "Maps multi-agent systems as explicit nodes and edges."},
    ],
    "steps_label": "Every request goes through",
    "steps": [
        {"name": "Auth", "text": "Middleware checks identity, rate limits, and input guards."},
        {"name": "Cache", "text": "Semantic cache returns answers for equivalent questions."},
        {"name": "Safety", "text": "Scrub PII and detect prompt injection attacks."},
        {"name": "Memory", "text": "Load session history with summarized context."},
        {"name": "Retrieve", "text": "Fetch relevant docs and split complex queries."},
        {"name": "Answer", "text": "Execute sub-queries in parallel with branching models."},
        {"name": "Validate", "text": "Check output quality metrics before responding."},
        {"name": "Save", "text": "Store results and log one full trace."},
    ],
    "rule": "Most tasks only need the bottom layers; avoid complex graphs without cause.",
    "notes": ["Each layer builds on the one below it.", "Cache and middleware run outside the graph.",
              "Every request should produce a single end-to-end trace."],
}

# The longest text each field allows, with the most items and steps: what every theme must fit.
STRESS = {
    "title": "W" * 4 + " Quarterly Review of Everything We Learned Here", "subtitle": "Long words here " * 7,
    "items_label": "The five very long layers", "steps_label": "Every request goes through",
    "items": [{"name": "Wide Name Here Now", "text": "Words that go on and on " * 6}] * 5,
    "steps": [{"name": "Validators", "text": "Words that go on and on " * 5}] * 8,
    "rule": "A very long rule that keeps going and going " * 3, "notes": ["A long note that keeps on going " * 4] * 3,
}

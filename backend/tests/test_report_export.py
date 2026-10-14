"""A report's PDF (downloaded, or posted to LinkedIn) is its text only: the embedded artifacts are left out."""

from app.models import Artifact
from app.services.report_export import report_pdf_html

BLOCKS = [
    {"id": "b1", "type": "prose", "text": "## Why price high\n\nReaders value the work [1].\n\n- Tiers anchor the middle"},
    {"id": "b2", "type": "callout", "title": "Note", "text": "Raise prices slowly."},
    {"id": "b3", "type": "key_terms", "title": "Terms", "terms": [{"term": "Anchor", "definition": "A price to compare to"}]},
    {"id": "b4", "type": "timeline", "title": "History",
     "events": [{"when": "2024", "title": "First tier", "detail": "Launched at five dollars"}]},
    {"id": "b5", "type": "table", "title": "Plans", "headers": ["Plan", "Price"], "rows": [["Pro", "$10"]]},
    {"id": "b6", "type": "mind_map", "title": "Map", "root": {"id": "r", "label": "STAR LABEL", "note": "", "children": []}},
    {"id": "b7", "type": "flashcards", "title": "Cards", "cards": [{"front": "CARD FRONT", "back": "CARD BACK"}]},
    {"id": "b8", "type": "quiz", "title": "Quiz", "questions": [{"question": "QUIZ QUESTION", "options": ["a", "b"]}]},
    {"id": "b9", "type": "infographic", "title": "Infographic", "artifact_id": None},
]


def test_the_pdf_keeps_the_text_and_leaves_out_embedded_artifacts():
    page = report_pdf_html(Artifact(type="report", status="ready", content_json={"title": "Pricing", "blocks": BLOCKS}))
    for kept in ("Why price high", "Readers value the work", "Tiers anchor the middle", "Raise prices slowly.",
                 "Anchor", "A price to compare to", "First tier", "Launched at five dollars", "Pro", "$10"):
        assert kept in page, kept
    for gone in ("STAR LABEL", "CARD FRONT", "CARD BACK", "QUIZ QUESTION", "<h2>Cards</h2>", "<h2>Quiz</h2>",
                 "<h2>Map</h2>", "<h2>Infographic</h2>", "[1]"):
        assert gone not in page, gone

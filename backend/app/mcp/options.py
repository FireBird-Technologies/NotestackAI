"""The settings the writer can choose for each kind of thing Notestack makes, as a small form the options widget draws.
The choices mirror the Notestack app: the same difficulty, counts, report templates, infographic looks and deck formats.
Each field's `key` is the argument name of the matching generate_* tool, so the widget's answer can be passed straight on."""

from app.mcp.common import template_preview

COUNT = {"key": "count", "label": "How many", "type": "chips", "default": "standard",
         "options": [{"value": "fewer", "label": "Fewer"}, {"value": "standard", "label": "Standard"}, {"value": "more", "label": "More"}]}
DIFFICULTY = {"key": "difficulty", "label": "Difficulty", "type": "chips", "default": "medium",
              "options": [{"value": "easy", "label": "Easy"}, {"value": "medium", "label": "Medium"}, {"value": "hard", "label": "Hard"}]}
TOPIC = {"key": "topic", "label": "Focus on a topic (optional)", "type": "text", "placeholder": "e.g. pricing"}
INSTRUCTIONS = {"key": "instructions", "label": "Anything to emphasise (optional)", "type": "text", "placeholder": "e.g. keep it short"}

KINDS = {
    "quiz": ("Set up your quiz", "generate_quiz", [
        COUNT, DIFFICULTY,
        {"key": "question_types", "label": "Question types", "type": "multi", "default": ["multiple_choice", "multiple_select", "fill_blank", "short_answer"],
         "options": [{"value": "multiple_choice", "label": "Multiple choice"}, {"value": "multiple_select", "label": "Multiple select"},
                     {"value": "fill_blank", "label": "Fill in the blank"}, {"value": "short_answer", "label": "Short answer"}]},
        TOPIC]),
    "flashcards": ("Set up your flashcards", "generate_flashcards", [COUNT, DIFFICULTY, TOPIC]),
    "mind_map": ("Set up your Mind Constellation", "generate_mind_map", [
        {"key": "focus", "label": "Centre it on (optional)", "type": "text", "placeholder": "e.g. the main argument"}]),
    "infographic": ("Set up your infographic", "generate_infographic", [
        {"key": "theme", "label": "Look", "type": "cards", "default": "midnight",
         "options": [{"value": "midnight", "label": "Midnight", "hint": "Black and blue, white type"},
                     {"value": "paper", "label": "Orbit", "hint": "White, black type, blue orbits and stars"}]},
        {"key": "ig_style", "label": "Layout", "type": "cards", "default": "auto",
         "options": [{"value": "auto", "label": "Auto", "hint": "Let the AI choose"}, {"value": "flowchart", "label": "Flow chart", "hint": "Steps joined by arrows"},
                     {"value": "timeline", "label": "Timeline", "hint": "What happens, in order"}, {"value": "compare", "label": "Comparison", "hint": "Two sides side by side"},
                     {"value": "hierarchy", "label": "Hierarchy", "hint": "A whole and its parts"}, {"value": "overview", "label": "Overview", "hint": "Key ideas and numbers"}]},
        INSTRUCTIONS]),
    "slide_deck": ("Set up your slide deck", "generate_slide_deck", [
        {"key": "deck_format", "label": "Format", "type": "cards", "default": "detailed",
         "options": [{"value": "detailed", "label": "Detailed", "hint": "Readable on its own"}, {"value": "presenter", "label": "Presenter", "hint": "Shown behind a speaker"}]},
        {"key": "deck_length", "label": "Length", "type": "chips", "default": "default",
         "options": [{"value": "short", "label": "Short"}, {"value": "default", "label": "Default"}, {"value": "long", "label": "Long"}]},
        {"key": "theme", "label": "Theme", "type": "cards", "default": "dark-space",
         "options": [{"value": "dark-space", "label": "Night stellar", "hint": "Dark sky"}, {"value": "light-space", "label": "Moon light", "hint": "White sky"}]},
        INSTRUCTIONS]),
    "audio_overview": ("Set up your audio overview", "generate_audio_overview", [
        {"key": "format", "label": "Format", "type": "cards", "default": "deep_dive",
         "options": [{"value": "deep_dive", "label": "Deep dive", "hint": "A thorough discussion"}, {"value": "brief", "label": "Brief", "hint": "The key points, fast"},
                     {"value": "critique", "label": "Critique", "hint": "What works and what does not"}, {"value": "debate", "label": "Debate", "hint": "Two hosts disagree"}]},
        {"key": "hosts", "label": "Hosts", "type": "chips", "default": 2, "options": [{"value": 1, "label": "1 host"}, {"value": 2, "label": "2 hosts"}]},
        {"key": "minutes", "label": "Length", "type": "chips", "default": 6,
         "options": [{"value": 3, "label": "3 min"}, {"value": 6, "label": "6 min"}, {"value": 10, "label": "10 min"}, {"value": 15, "label": "15 min"}]},
        INSTRUCTIONS]),
}


def report_fields(templates: dict) -> list[dict]:
    """A report: written or interactive, which template, and anything to emphasise. Templates come from the app itself."""
    cards = [{"value": "", "label": "No template", "hint": "A general report from the posts"}]
    cards += [{"value": str(t["id"]), "label": str(t["name"])[:60], "hint": str(t.get("description") or "")[:140]}
              for t in templates.get("templates", []) if isinstance(t, dict) and t.get("id")]
    return [{"key": "report_format", "label": "Format", "type": "cards", "default": "document",
             "options": [{"value": "document", "label": "Document", "hint": "Written sections"},
                         {"value": "interactive", "label": "Interactive", "hint": "With embedded visuals and a quiz"}]},
            {"key": "template_id", "label": "Template", "type": "cards", "default": "", "options": cards},
            INSTRUCTIONS]


def video_fields(catalog: dict, voices: dict | None = None) -> list[dict]:
    """A video: the video maker's real templates (with posters) and styles, shape, length, narration and language."""
    templates = []
    for t in catalog.get("templates", []):
        if not isinstance(t, dict) or not t.get("id"):
            continue
        fallback = t.get("preview_url")
        img = template_preview(t["id"], fallback)
        card = {"value": str(t["id"]), "label": str(t.get("name") or t["id"])[:60], "img": img}
        if fallback and fallback != img:
            card["fallback_img"] = fallback
        templates.append(card)
        if len(templates) == 40:
            break
    templates += [{"value": str(t["id"]), "label": str(t["name"])[:60]} for t in catalog.get("my_templates", [])
                  if isinstance(t, dict) and t.get("id") and t.get("name")][:10]
    styles = [{"value": "", "label": "Automatic"}] + [{"value": str(s["id"]), "label": str(s.get("name") or s["id"])[:60]}
                                                     for s in catalog.get("video_styles", []) if isinstance(s, dict) and s.get("id")][:20]
    langs = [{"value": "", "label": "Same as the posts"}] + [{"value": l["code"], "label": l["name"]}
                                                            for l in catalog.get("languages", []) if isinstance(l, dict)]
    saved = [{"value": str(v["voice_id"]), "label": str(v.get("name") or "Voice")[:60],
              "sub": " • ".join(x for x in (v.get("gender"), v.get("accent")) if x), "preview": v.get("preview_url"),
              "gender": v.get("gender") if v.get("gender") in ("female", "male") else None,
              "accent": v.get("accent") if v.get("accent") in ("american", "british") else None}
             for v in (voices or {}).get("saved", []) if isinstance(v, dict) and v.get("voice_id")][:30]
    fields = []
    if templates:
        fields.append({"key": "template", "label": "Template", "type": "cards", "default": templates[0]["value"], "options": templates})
    if len(styles) > 1:
        fields.append({"key": "video_style", "label": "Style", "type": "chips", "default": "", "options": styles})
    narration = ([{"key": "voice", "label": "Voice: play to preview", "type": "voices", "default": saved[0]["value"],
                   "none_label": "No voiceover", "options": saved}] if saved else
                 [{"key": "voice_gender", "label": "Narration", "type": "chips", "default": "female",
                   "options": [{"value": "female", "label": "Female voice"}, {"value": "male", "label": "Male voice"},
                               {"value": "none", "label": "No narration"}]}])
    return fields + [
        {"key": "aspect_ratio", "label": "Shape", "type": "chips", "default": "landscape",
         "options": [{"value": "landscape", "label": "Landscape (16:9)"}, {"value": "portrait", "label": "Portrait (9:16)"}]},
        {"key": "video_length", "label": "Length", "type": "chips", "default": "short",
         "options": [{"value": "short", "label": "Short"}, {"value": "medium", "label": "Medium"}]},
        *narration,
        {"key": "content_language", "label": "Language", "type": "select", "default": "", "options": langs}]


def form(kind: str, templates: dict | None = None, voices: dict | None = None) -> dict:
    if kind == "video":
        title, tool, fields = "Set up your video", "generate_video", video_fields(templates or {}, voices)
    elif kind == "report":
        title, tool, fields = "Set up your report", "generate_report", report_fields(templates or {})
    else:
        title, tool, fields = KINDS[kind]
    return {"kind": "generation_options", "make": kind, "title": title, "tool": tool, "fields": fields}

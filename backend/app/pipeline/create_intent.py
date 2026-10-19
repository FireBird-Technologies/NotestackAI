"""Making something from the chat: "create a 10 minute audio overview on pricing" opens the audio overview settings
with Long (about 12 min) and the focus filled in, for the writer to check and press Generate.

One cheap call (ParseCreateRequest on the triage LLM) copies out what was asked for in the writer's own terms; snap()
then turns each value into an option the dialog really offers (the nearest length, a known theme), dropping anything it
cannot place so the dialog's default applies. The reply is built here from the snapped settings, never written by the
model, so it can only say what the dialog will show. The option lists mirror the frontend dialogs
(components/AudioOverview.tsx, SlideDeck.tsx, Infographic.tsx, Quiz.tsx, Flashcards.tsx, ReportDialog.tsx, MindMap.tsx
and pages/VideoCreate.tsx)."""

import logging
import re

import dspy

from app.llm.postprocess import strip_em_dashes
from app.llm.provider import track_usage, triage_lm
from app.llm.signatures import ParseCreateRequest
from app.services import blog2video as b2v

log = logging.getLogger(__name__)

ARTIFACTS = ("audio_overview", "slide_deck", "video", "report", "infographic", "quiz", "flashcards", "mind_map")
NAMES = {"audio_overview": "audio overview", "slide_deck": "slide deck", "video": "video", "report": "report",
         "infographic": "infographic", "quiz": "quiz", "flashcards": "flashcards", "mind_map": "Mind Constellation"}

# components/SourceFocusFields.tsx LANGUAGES
LANGUAGES = ["English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Polish", "Hindi", "Arabic",
             "Japanese", "Korean", "Chinese", "Turkish", "Russian", "Indonesian"]

# The video wizard's content_language codes (routers/videos.py LANGUAGES, the same languages in the same order)
VIDEO_LANGUAGE_CODES = dict(zip(LANGUAGES, ["en", "es", "fr", "de", "it", "pt", "nl", "pl", "hi", "ar", "ja", "ko",
                                            "zh", "tr", "ru", "id"], strict=True))
# The wizard's house styles: each sets the video's length (services/b2v_access.py HOUSE_STYLES)
VIDEO_STYLES = {"overview": "Overview (usually under a minute)", "deep_dive": "Deep dive (usually 1 to 2 minutes)"}

AUDIO_MINUTES = {3: "Short", 6: "Default", 12: "Long"}
AUDIO_BY_LENGTH = {"short": 3, "default": 6, "long": 12}
AUDIO_STYLES = {"deep_dive": "Deep Dive", "brief": "Brief", "critique": "Critique", "debate": "Debate"}
# Slide counts each deck length makes (components/SlideDeck.tsx LENGTHS): the middle of each range is what is compared.
DECK_LENGTHS = {"short": (6, 8, "Short"), "default": (9, 11, "Default"), "long": (12, 16, "Long")}
DECK_FORMATS = {"detailed": "Detailed deck", "presenter": "Presenter slides"}
SLIDE_THEMES = {"dark-space": "Night stellar", "light-space": "Moon light"}
INFOGRAPHIC_THEMES = {"midnight": "Midnight", "paper": "Orbit"}
INFOGRAPHIC_STYLES = {"flowchart": "Flow chart", "timeline": "Timeline", "compare": "Comparison",
                      "hierarchy": "Hierarchy", "overview": "Overview"}
LEVELS = {"easy": "Easy", "medium": "Medium", "hard": "Hard"}
QUESTION_TYPES = {"multiple_choice": "Multiple Choice", "fill_blank": "Fill in the Blank",
                  "short_answer": "Short Answer"}
REPORT_TEMPLATES = {"briefing": "Briefing Doc", "study_guide": "Study Guide", "blog_post": "Blog Post"}

_DARK = re.compile(r"dark|night|black|stellar|space|midnight|blue", re.IGNORECASE)
_LIGHT = re.compile(r"light|moon|white|paper|orbit|bright", re.IGNORECASE)
_STYLE_WORDS = {
    "deep_dive": r"deep|dive|conversation|discussion|explainer", "brief": r"brief|bite.?sized", "critique": r"critiq|review|feedback",
    "debate": r"debate|argue|versus|\bvs\b", "flowchart": r"flow|process|steps", "timeline": r"timeline|chronolog|history",
    "compare": r"compar|side by side|versus|\bvs\b", "hierarchy": r"hierarch|tree|parts", "overview": r"overview|key ideas|numbers",
    "presenter": r"present|speaker|talk", "detailed": r"detail|reading|email", "interactive": r"interactive",
    "study_guide": r"study", "blog_post": r"blog|article", "briefing": r"brief",
}
_TYPE_WORDS = {"multiple_choice": r"multiple|choice|mcq", "fill_blank": r"fill|blank", "short_answer": r"short|open|written"}


_POINTS_BACK = re.compile(r"\b(this|that|it|these|those|above|same|what you (just )?said)\b", re.IGNORECASE)
_WORD = re.compile(r"[a-z0-9]{2,}")
_STOP = {"the", "of", "on", "my", "and", "for", "in", "to", "an", "about", "from", "with", "me", "posts", "post"}


def _from_message(value: str, message: str) -> bool:
    """A topic (or other ask) the message itself says, or points back at the conversation for. The model sometimes
    carries the last subject of the chat over into a plain "make a slide deck", which is about the whole notebook."""
    if not value or _POINTS_BACK.search(message):
        return True
    said = set(_WORD.findall(message.lower())) - _STOP
    return any(w in said for w in _WORD.findall(value.lower()))


def _number(value: str) -> float | None:
    m = re.search(r"\d+(\.\d+)?", value or "")
    return float(m.group()) if m else None


def _word(value: str, choices) -> str | None:
    """The first choice whose words the value matches (exact ids first), or None."""
    v = (value or "").strip().lower().replace(" ", "_").replace("-", "_")
    if not v:
        return None
    for c in choices:
        if v == c:
            return c
    for c in choices:
        if re.search(_STYLE_WORDS.get(c, re.escape(c)), value, re.IGNORECASE):
            return c
    return None


def _length_word(raw: dict) -> str | None:
    """short, default or long from the length the writer gave in words (none from a bare number)."""
    v = f"{raw.get('length') or ''}".lower()
    if re.search(r"short|quick|brief|bite|small|tiny", v):
        return "short"
    if re.search(r"long|depth|detail|full|extend|big", v):
        return "long"
    if re.search(r"default|normal|medium|standard|regular", v):
        return "default"
    return None


def _video_template(value: str) -> dict | None:
    """The built-in template the writer named: the exact name, then the name's words, then its description. None
    when nothing fits (the wizard can still match one of the workspace's own templates by name)."""
    want = (value or "").strip().lower()
    want = re.sub(r"\b(template|style|look|theme|format)s?\b", "", want).strip()
    if not want:
        return None
    try:
        templates = [t for t in b2v.builtin_templates() if isinstance(t, dict) and t.get("id")]
    except Exception:  # the catalog unreachable: no template, the wizard keeps its own
        log.warning("Video templates unavailable for the chat's create request", exc_info=True)
        return None
    words = set(_WORD.findall(want)) - _STOP
    if not words:
        return None
    name = lambda t: str(t.get("name") or t.get("id")).lower()  # noqa: E731
    for t in templates:
        if name(t) == want or str(t["id"]).lower() == want.replace(" ", "_"):
            return t
    for t in templates:
        if words <= set(_WORD.findall(name(t))) | {str(t["id"]).lower()}:
            return t
    for t in templates:
        if words & set(_WORD.findall(name(t))):
            return t
    for t in templates:
        if words <= set(_WORD.findall(str(t.get("description") or "").lower())):
            return t
    return None


def _theme(value: str, dark: str, light: str) -> str | None:
    if not (value or "").strip():
        return None
    if _LIGHT.search(value):
        return light
    if _DARK.search(value):
        return dark
    return None


def _language(value: str) -> str | None:
    v = (value or "").strip().lower()
    return next((lang for lang in LANGUAGES if lang.lower() == v), None)


def _focus(raw: dict) -> str:
    """What it should be about and anything else asked for, as one line for a focus or prompt box."""
    topic, extra = (raw.get("topic") or "").strip(), (raw.get("requests") or "").strip()
    if topic and extra:
        return f"Focus on {topic}. {extra}"
    return topic or extra


def snap(artifact: str, raw: dict) -> dict:
    """The settings the dialog will open with: each one an option it offers, nothing it cannot place."""
    out: dict = {}
    style, lang = raw.get("style") or "", _language(raw.get("language") or "")
    topic, focus = (raw.get("topic") or "").strip(), _focus(raw)
    length = _length_word(raw)
    if artifact == "audio_overview":
        minutes = _number(raw.get("minutes") or "")
        if minutes is not None:
            out["minutes"] = str(min(AUDIO_MINUTES, key=lambda m: (abs(m - minutes), m)))
        elif length:
            out["minutes"] = str(AUDIO_BY_LENGTH[length])
        hosts = _number(raw.get("hosts") or "")
        if hosts in (1, 2):
            out["hosts"] = str(int(hosts))
        if picked := _word(style, AUDIO_STYLES):
            out["style"] = picked
            if picked == "debate":
                out["hosts"] = "2"  # a debate needs two hosts (the dialog moves a one host debate to Deep Dive)
        if lang:
            out["language"] = lang
        if focus:
            out["focus"] = focus
    elif artifact == "slide_deck":
        count = _number(raw.get("slide_count") or "")
        if count is not None:
            out["length"] = min(DECK_LENGTHS, key=lambda k: abs((DECK_LENGTHS[k][0] + DECK_LENGTHS[k][1]) / 2 - count))
        elif length:
            out["length"] = length
        if picked := _word(style, DECK_FORMATS):
            out["format"] = picked
        if picked := _theme(raw.get("theme") or "", "dark-space", "light-space"):
            out["theme"] = picked
        if lang:
            out["language"] = lang
        if focus:
            out["prompt"] = focus
    elif artifact == "infographic":
        if picked := _word(style, INFOGRAPHIC_STYLES):
            out["style"] = picked
        if picked := _theme(raw.get("theme") or "", "midnight", "paper"):
            out["theme"] = picked
        if focus:
            out["prompt"] = focus
    elif artifact in ("quiz", "flashcards"):
        if picked := _word(raw.get("difficulty") or "", LEVELS) or _level_word(raw.get("difficulty") or ""):
            out["level"] = picked
        if artifact == "quiz":
            asked = [t for t in QUESTION_TYPES
                     if re.search(_TYPE_WORDS[t], raw.get("question_types") or "", re.IGNORECASE)
                     or t in (raw.get("question_types") or "")]
            if asked:
                out["types"] = asked
        if focus:
            out["focus"] = focus
    elif artifact == "report":
        if re.search(_STYLE_WORDS["interactive"], style, re.IGNORECASE):
            out["format"] = "interactive"
        elif picked := _word(style, REPORT_TEMPLATES):
            out["format"], out["template"] = "document", picked
        if topic:
            out["about"] = topic
        if (extra := (raw.get("requests") or "").strip()):
            out["instructions"] = extra
    elif artifact == "mind_map":
        if focus:
            out["focus"] = focus
    elif artifact == "video":
        # The style sets the length (there is no length picker): short is Overview, long is Deep dive
        minutes = _number(raw.get("minutes") or "")
        if minutes is not None:
            out["video_style"] = "overview" if minutes <= 1 else "deep_dive"
        elif length in ("short", "long"):
            out["video_style"] = "overview" if length == "short" else "deep_dive"
        elif re.search(r"deep|dive|explainer|in.?depth", style, re.IGNORECASE):
            out["video_style"] = "deep_dive"
        elif re.search(r"overview|summary|quick", style, re.IGNORECASE):
            out["video_style"] = "overview"
        if (asked := (raw.get("template") or "").strip()):
            if picked := _video_template(asked):
                out["template"] = str(picked["id"])
            out["template_name"] = asked  # the wizard can still find one of the workspace's own templates by it
        orientation = (raw.get("orientation") or "").lower()
        # "Shorts" (YouTube) is vertical; a "short video" is about length
        if re.search(r"portrait|vertical|tiktok|reel|shorts|story|9:16", orientation):
            out["aspect_ratio"] = "portrait"
        elif re.search(r"landscape|wide|horizontal|youtube|16:9", orientation):
            out["aspect_ratio"] = "landscape"
        voice = (raw.get("voice") or "").lower()
        if re.search(r"\bnone\b|\bno\b|without|silent|music only|mute", voice):
            out["voice_gender"] = "none"
        else:
            if re.search(r"\bmale|\bman\b|\bmen\b", voice) and not re.search(r"female|woman", voice):
                out["voice_gender"] = "male"
            elif re.search(r"female|woman", voice):
                out["voice_gender"] = "female"
            if re.search(r"brit|english accent|\buk\b", voice):
                out["voice_accent"] = "british"
            elif re.search(r"americ|\bus\b|\busa\b", voice):
                out["voice_accent"] = "american"
        if lang:
            out["content_language"] = VIDEO_LANGUAGE_CODES[lang]
        if focus:
            out["focus"] = focus
    return out


def _level_word(value: str) -> str | None:
    v = value.lower()
    if re.search(r"difficult|tough|advanced|challeng", v):
        return "hard"
    if re.search(r"simple|beginner|basic", v):
        return "easy"
    if re.search(r"normal|moderate|intermediate", v):
        return "medium"
    return None


def reply_text(artifact: str, settings: dict, raw: dict) -> str:
    """What the chat says: the dialog that opens and every setting it was given, with the closest match explained."""
    bits: list[str] = []
    if artifact == "audio_overview":
        if "minutes" in settings:
            m = int(settings["minutes"])
            asked = _number(raw.get("minutes") or "")
            near = "" if asked is None or asked == m else f", the closest to the {asked:g} you asked for"
            bits.append(f"{AUDIO_MINUTES[m]} (about {m} min{near})")
        if "style" in settings:
            bits.append(AUDIO_STYLES[settings["style"]])
        if settings.get("style") == "debate" and _number(raw.get("hosts") or "") == 1:
            bits.append("2 hosts (a debate needs two)")
        elif "hosts" in settings:
            bits.append("1 host" if settings["hosts"] == "1" else "2 hosts")
    elif artifact == "slide_deck":
        if "length" in settings:
            lo, hi, label = DECK_LENGTHS[settings["length"]]
            asked = _number(raw.get("slide_count") or "")
            near = "" if asked is None or lo <= asked <= hi else f", the closest to the {asked:g} you asked for"
            bits.append(f"{label} ({lo} to {hi} slides{near})")
        if "format" in settings:
            bits.append(DECK_FORMATS[settings["format"]])
        if "theme" in settings:
            bits.append(f"{SLIDE_THEMES[settings['theme']]} style")
    elif artifact == "infographic":
        if "style" in settings:
            bits.append(f"{INFOGRAPHIC_STYLES[settings['style']]} layout")
        if "theme" in settings:
            bits.append(f"{INFOGRAPHIC_THEMES[settings['theme']]} look")
    elif artifact in ("quiz", "flashcards"):
        if "level" in settings:
            bits.append(LEVELS[settings["level"]])
        if settings.get("types"):
            bits.append(", ".join(QUESTION_TYPES[t] for t in settings["types"]))
    elif artifact == "report":
        if settings.get("format") == "interactive":
            bits.append("Interactive")
        elif "template" in settings:
            bits.append(REPORT_TEMPLATES[settings["template"]])
    elif artifact == "video":
        if "video_style" in settings:
            bits.append(VIDEO_STYLES[settings["video_style"]])
        if "template" in settings:
            picked = _video_template(raw.get("template") or "")
            bits.append(f"{(picked or {}).get('name') or settings['template']} template")
        if "aspect_ratio" in settings:
            bits.append("vertical" if settings["aspect_ratio"] == "portrait" else "landscape")
        if settings.get("voice_gender") == "none":
            bits.append("no voiceover")
        elif "voice_gender" in settings or "voice_accent" in settings:
            who = " ".join(x for x in (settings.get("voice_accent", "").replace("british", "British")
                                       .replace("american", "American"), settings.get("voice_gender", "")) if x)
            bits.append(f"{who} voice")
    if settings.get("language"):
        bits.append(f"in {settings['language']}")
    elif settings.get("content_language"):
        bits.append(f"in {next(n for n, c in VIDEO_LANGUAGE_CODES.items() if c == settings['content_language'])}")
    about = (raw.get("topic") or "").strip()
    if about:
        bits.append(f"about {about}")
    name = NAMES[artifact]
    said = f": {', '.join(bits)}" if bits else ""
    return strip_em_dashes(f"Opening the {name} settings{said}. Check them and press Generate.")


def parse_create(message: str, conversation: str) -> tuple[dict | None, str, int, int]:
    """(action, reply, prompt tokens, completion tokens). action is {"artifact", "settings"}, or None when the model
    could not tell what to make (the caller then answers with the app help instead)."""
    lm = triage_lm()
    with track_usage(lm) as usage, dspy.context(lm=lm):
        pred = dspy.Predict(ParseCreateRequest)(conversation=conversation, message=message)
    artifact = pred.artifact if pred.artifact in ARTIFACTS else None
    if not artifact:
        return None, "", usage.prompt_tokens, usage.completion_tokens
    raw = {k: str(getattr(pred, k, "") or "").strip() for k in
           ("minutes", "length", "slide_count", "hosts", "style", "difficulty", "question_types", "theme",
            "orientation", "voice", "template", "language", "topic", "requests")}
    raw = {k: ("" if v.lower() in ("none", "null", "n/a", "-") else v) for k, v in raw.items()}
    for k in ("topic", "requests"):
        if not _from_message(raw[k], message):
            raw[k] = ""
    settings = snap(artifact, raw)
    log.info("Create request %r -> %s %s (asked %s)", message[:120], artifact, settings, raw)
    return ({"artifact": artifact, "settings": settings}, reply_text(artifact, settings, raw),
            usage.prompt_tokens, usage.completion_tokens)

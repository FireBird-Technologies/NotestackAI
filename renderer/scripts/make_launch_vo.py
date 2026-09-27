"""Narration for the launch trailer (Nora Vale, Mission Control). Writes public/launch-vo/*.mp3 + durations.json.

Run from backend/ (uses its ElevenLabs client and .env), then run make_launch_music.py:
    cd backend && PYTHONPATH=. .venv/Scripts/python ../renderer/scripts/make_launch_vo.py
"""

import json
import uuid
from pathlib import Path

from app.services import tts

OUT = Path(__file__).resolve().parents[1] / "public" / "launch-vo"
OUT.mkdir(parents=True, exist_ok=True)

LINES = {
    "intro": "Every writer carries a universe of ideas. Most of it... still uncharted.",
    "launch": "So we built a ship. Let's go exploring.",
    "sources": "First stop: your sources. Any blog, newsletter, website, or markdown file, pulled into orbit.",
    "research": "Ask your archive anything. Every answer is traced to the exact lines you wrote.",
    "map": "Chart the constellations in your thinking. See what's rising, and what has gone dark.",
    "voice": "Teach it your voice, so everything it makes still sounds like you.",
    "audio": "Turn any notebook into a two host audio overview.",
    "video": "Shorts, explainers, audiograms and quote cards, all rendered from your own words.",
    "launchkit": "One post becomes a thread, a LinkedIn post, notes, an SEO pack and a carousel.",
    "launchpad": "Schedule everything, and post straight to X, LinkedIn and Bluesky.",
    "resurface": "And your best old posts? We bring them back into orbit.",
    "outro": "Notestack A.I. The galaxies of your untapped potential. Coming soon.",
}

voice_id = next(v["voice_id"] for v in tts.list_voices() if v["name"].startswith("Nora Vale"))
# A touch more energy than the landing demo: this one is a trailer.
vs = tts.VoiceSettings(stability=0.5, similarity_boost=0.8, style=0.35, speed=0.95)
ws = uuid.UUID(int=0)
keys = list(LINES)
durations = {}
for i, key in enumerate(keys):
    prev_text = LINES[keys[i - 1]] if i else None
    next_text = LINES[keys[i + 1]] if i + 1 < len(keys) else None
    clip = tts.synthesize(ws, LINES[key], voice_id, vs, prev_text, next_text)
    (OUT / f"{key}.mp3").write_bytes(clip)
    durations[key] = round(tts.mp3_seconds(clip), 2)
(OUT / "durations.json").write_text(json.dumps(durations, indent=2))
print(json.dumps(durations))

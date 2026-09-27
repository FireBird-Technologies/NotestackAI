"""Narration for the launch trailer (Nora Vale, Mission Control). Writes public/launch-vo/*.mp3 + durations.json.

The screens show what each feature does; the voice carries what it feels like to use it.

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
    "intro": "You have written more than you remember. Whole worlds of ideas... still uncharted.",
    "launch": "Take a breath. We're going exploring.",
    "sources": "Watch years of your writing drift back into view. Nothing lost. Nothing forgotten.",
    "research": "Ask a question, and hear your own best thinking answer back.",
    "map": "See the shape of your mind. The ideas you keep coming home to, and the ones still waiting.",
    "voice": "Everything it makes sounds like you. On your best day.",
    "audio": "Hear your ideas come alive, as a conversation.",
    "video": "Watch your words move, glow, and find new eyes.",
    "launchkit": "One post. A whole week of posts. And never a blank page.",
    "launchpad": "Press schedule, and feel the weight lift off.",
    "resurface": "And the gems you forgot you wrote? They find their way back to you.",
    "outro": "Notestack A.I. The galaxies of your untapped potential. Coming soon.",
}

voice_id = next(v["voice_id"] for v in tts.list_voices() if v["name"].startswith("Nora Vale"))
# Warm and unhurried: this is about a feeling, not a feature list.
vs = tts.VoiceSettings(stability=0.5, similarity_boost=0.8, style=0.4, speed=0.93)
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

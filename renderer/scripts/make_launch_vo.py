"""Narration for the launch trailer (Nora Vale, Mission Control). Writes public/launch-vo/*.mp3 + durations.json.

The voice never explains the product. It only says how the journey feels: exploring, excited, mesmerized.

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
    "intro": "There's a feeling you get at the edge of something vast. Curious. A little breathless.",
    "launch": "Hold on. Here we go.",
    "sources": "Everything you've ever made, glowing back at you. Like seeing Earth from orbit for the first time.",
    "research": "That spark, when a thought you'd forgotten lights up again.",
    "map": "You drift through your own ideas... and you can't look away.",
    "voice": "It feels like you. Only braver.",
    "audio": "Lean back. Let it wash over you.",
    "video": "Color. Motion. Wonder. You'll want to watch it twice.",
    "launchkit": "Your heart races a little. The good kind of nervous.",
    "launchpad": "Three, two, one... and you're flying.",
    "resurface": "And then, out of the dark, an old favorite shines again.",
    "outro": "Notestack A.I. Come explore the galaxies of your untapped potential. Coming soon.",
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

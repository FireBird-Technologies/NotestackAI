"""Narration for the landing page demo (Nora Vale, Mission Control). Writes public/demo-vo/*.mp3 + durations.json.

The screens show the product; the voice says what it feels like. Then copy the printed durations
into VO_SECONDS in src/compositions/LandingDemo.tsx (and lengthen a scene if its line no longer fits).
make_demo_music.py writes the 47.5 s score; rerun it with a larger TOTAL if the demo grows past that.

    cd backend && PYTHONPATH=. .venv/Scripts/python ../renderer/scripts/make_demo_vo.py
"""

import json
import uuid
from pathlib import Path

from app.services import tts

OUT = Path(__file__).resolve().parents[1] / "public" / "demo-vo"
OUT.mkdir(parents=True, exist_ok=True)

LINES = {
    "warp": "Captain's log. Your knowledge... is now in orbit.",
    "paste": "Just point us at your writing. Any blog, any site, any folder of notes. Then sit back.",
    "orbit": "Watch years of work come home. Every idea you've had, finally within reach.",
    "research": "Ask, and hear your own best thinking answer back. With proof.",
    "audio": "Hear your ideas as a conversation. Like meeting your work for the first time.",
    "launchkit": "No more blank page. Next week's posts are already here, and they sound like you.",
    "launchpad": "Press schedule, and feel the weight lift off.",
    "outro": "Notestack. Clear skies ahead.",
}

voice_id = next(v["voice_id"] for v in tts.list_voices() if v["name"].startswith("Nora Vale"))
vs = tts.VoiceSettings(stability=0.55, similarity_boost=0.8, style=0.3, speed=0.93)
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

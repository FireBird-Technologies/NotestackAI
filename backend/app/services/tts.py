"""ElevenLabs text to speech, cached in storage by (script, voice, settings)."""

import base64
import json

import httpx

from app.config import settings
from app.services.storage import keys, storage

API = "https://api.elevenlabs.io/v1"
OUTPUT = "mp3_44100_128"
BITRATE = 128_000

PREMADE = [
    {"voice_id": "21m00Tcm4TlvDq8ikWAM", "name": "Rachel", "category": "premade"},
    {"voice_id": "pNInz6obpgDQGcFMaJgB", "name": "Adam", "category": "premade"},
    {"voice_id": "EXAVITQu4vr4xnSDxMaL", "name": "Bella", "category": "premade"},
    {"voice_id": "ErXwobaYiN019PkySvjV", "name": "Antoni", "category": "premade"},
    {"voice_id": "AZnzlk1XvdvUeBnXmlld", "name": "Domi", "category": "premade"},
    {"voice_id": "TxGEqnHWrfWFTfGW9XjX", "name": "Josh", "category": "premade"},
]


class TTSError(RuntimeError):
    pass


def _headers() -> dict:
    if not settings.elevenlabs_api_key:
        raise TTSError("ELEVENLABS_API_KEY is not set")
    return {"xi-api-key": settings.elevenlabs_api_key}


def mp3_seconds(data: bytes) -> float:
    return len(data) * 8 / BITRATE


def _voice_settings() -> dict:
    return {"stability": 0.45, "similarity_boost": 0.8, "style": 0.2, "use_speaker_boost": True}


def _cache_key(workspace_id, text: str, voice_id: str, variant: str) -> str:
    return keys.tts_cache(workspace_id, text, voice_id,
                          json.dumps(_voice_settings(), sort_keys=True) + settings.elevenlabs_model + variant)


def synthesize(workspace_id, text: str, voice_id: str) -> bytes:
    key = _cache_key(workspace_id, text, voice_id, OUTPUT)
    if storage.exists(key):
        return storage.get_bytes(key)
    body = {"text": text, "model_id": settings.elevenlabs_model, "voice_settings": _voice_settings()}
    resp = httpx.post(f"{API}/text-to-speech/{voice_id}", params={"output_format": OUTPUT},
                      headers=_headers(), json=body, timeout=120)
    if resp.status_code >= 400:
        raise TTSError(f"ElevenLabs {resp.status_code}: {resp.text[:300]}")
    storage.put_bytes(key, resp.content, "audio/mpeg")
    return resp.content


def synthesize_with_timestamps(workspace_id, text: str, voice_id: str) -> tuple[bytes, list[dict]]:
    """Audio plus word timings [{text, startMs, endMs}] for captions."""
    key = _cache_key(workspace_id, text, voice_id, "timestamps") + ".json"
    if storage.exists(key):
        data = json.loads(storage.get_bytes(key))
    else:
        body = {"text": text, "model_id": settings.elevenlabs_model, "voice_settings": _voice_settings()}
        resp = httpx.post(f"{API}/text-to-speech/{voice_id}/with-timestamps", params={"output_format": OUTPUT},
                          headers=_headers(), json=body, timeout=120)
        if resp.status_code >= 400:
            raise TTSError(f"ElevenLabs {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        storage.put_bytes(key, json.dumps(data).encode(), "application/json")
    audio = base64.b64decode(data["audio_base64"])
    return audio, words_from_alignment(data.get("alignment") or {})


def words_from_alignment(alignment: dict) -> list[dict]:
    chars = alignment.get("characters") or []
    starts = alignment.get("character_start_times_seconds") or []
    ends = alignment.get("character_end_times_seconds") or []
    words: list[dict] = []
    current, start, last_end = "", 0.0, 0.0
    for ch, s, e in zip(chars, starts, ends, strict=False):
        if ch.isspace():
            if current:
                words.append({"text": current, "startMs": int(start * 1000), "endMs": int(last_end * 1000)})
            current = ""
            continue
        if not current:
            start = s
        current += ch
        last_end = e
    if current:
        words.append({"text": current, "startMs": int(start * 1000), "endMs": int(last_end * 1000)})
    return words


def list_voices() -> list[dict]:
    if not settings.elevenlabs_api_key:
        return PREMADE
    try:
        resp = httpx.get(f"{API}/voices", headers=_headers(), timeout=20)
        resp.raise_for_status()
    except httpx.HTTPError:
        return PREMADE
    return [
        {"voice_id": v["voice_id"], "name": v["name"], "category": v.get("category"),
         "preview_url": v.get("preview_url")}
        for v in resp.json().get("voices", [])
    ]


def clone_voice(name: str, sample: bytes, filename: str, content_type: str) -> str:
    resp = httpx.post(f"{API}/voices/add", headers=_headers(), timeout=120,
                      data={"name": name, "description": "Notestack consented voice clone"},
                      files={"files": (filename, sample, content_type)})
    if resp.status_code >= 400:
        raise TTSError(f"ElevenLabs {resp.status_code}: {resp.text[:300]}")
    return resp.json()["voice_id"]


def delete_voice(voice_id: str) -> None:
    httpx.delete(f"{API}/voices/{voice_id}", headers=_headers(), timeout=30)

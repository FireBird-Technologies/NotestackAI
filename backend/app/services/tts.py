"""ElevenLabs: speech generation, voices (premade, Voice Library, consented clones), cached in storage.

Generation
- `synthesize` renders one line. Lines of a conversation pass the neighbouring text
  (previous_text / next_text) so intonation flows across cuts, and are cached by
  (text, voice, model, settings, context) so re-renders cost nothing.
- 429 and 5xx responses retry with backoff; a long script renders in parallel (`synthesize_many`).

Voices
- premade voices and Voice Library ("shared") voices are licensed by ElevenLabs for commercial use on
  paid ElevenLabs plans; library voices are added to the account before use.
- cloning is Instant Voice Cloning from one or more consented samples, with background noise removal.
"""

import base64
import json
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import httpx

from app.config import settings
from app.services.storage import keys, storage

API = "https://api.elevenlabs.io/v1"
OUTPUT = "mp3_44100_128"
BITRATE = 128_000
MODELS = {
    "eleven_multilingual_v2": "Multilingual v2 (most natural, default)",
    "eleven_turbo_v2_5": "Turbo v2.5 (fast, half the cost)",
    "eleven_flash_v2_5": "Flash v2.5 (fastest, cheapest)",
}

PREMADE = [  # current ElevenLabs default voices, shown when the account list cannot be fetched
    {"voice_id": "EXAVITQu4vr4xnSDxMaL", "name": "Sarah", "category": "premade"},
    {"voice_id": "JBFqnCBsd6RMkjVDRZzb", "name": "George", "category": "premade"},
    {"voice_id": "CwhRBWXzGAHq8TQ4Fs17", "name": "Roger", "category": "premade"},
    {"voice_id": "cgSgspJ2msm6clMCkdW9", "name": "Jessica", "category": "premade"},
    {"voice_id": "nPczCjzI2devNBz1zQrb", "name": "Brian", "category": "premade"},
    {"voice_id": "IKne3meq5aSn9XLyUdCD", "name": "Charlie", "category": "premade"},
]


@dataclass(frozen=True)
class VoiceSettings:
    stability: float = 0.45
    similarity_boost: float = 0.8
    style: float = 0.2
    speed: float = 1.0
    use_speaker_boost: bool = True

    @classmethod
    def from_dict(cls, data: dict | None) -> "VoiceSettings":
        data = data or {}

        def clamp(key: str, lo: float, hi: float) -> float:
            try:
                return max(lo, min(hi, float(data.get(key, getattr(cls, key)))))
            except (TypeError, ValueError):
                return getattr(cls, key)

        return cls(stability=clamp("stability", 0, 1), similarity_boost=clamp("similarity_boost", 0, 1),
                   style=clamp("style", 0, 1), speed=clamp("speed", 0.7, 1.2),
                   use_speaker_boost=bool(data.get("use_speaker_boost", True)))

    def body(self) -> dict:
        return {"stability": self.stability, "similarity_boost": self.similarity_boost, "style": self.style,
                "speed": self.speed, "use_speaker_boost": self.use_speaker_boost}


class TTSError(RuntimeError):
    pass


def _headers() -> dict:
    if not settings.elevenlabs_api_key:
        raise TTSError("ELEVENLABS_API_KEY is not set")
    return {"xi-api-key": settings.elevenlabs_api_key}


def _request(method: str, path: str, *, attempts: int = 4, **kwargs) -> httpx.Response:
    """ElevenLabs call with retries for rate limits and transient errors."""
    delay = 1.5
    for attempt in range(attempts):
        try:
            resp = httpx.request(method, f"{API}{path}", headers=_headers(), timeout=kwargs.pop("timeout", 120),
                                 **kwargs)
        except httpx.TransportError as exc:
            if attempt == attempts - 1:
                raise TTSError(f"ElevenLabs unreachable: {exc}") from exc
            time.sleep(delay)
            delay *= 2
            continue
        if resp.status_code == 429 or resp.status_code >= 500:
            if attempt == attempts - 1:
                break
            time.sleep(float(resp.headers.get("retry-after") or delay))
            delay *= 2
            continue
        if resp.status_code >= 400:
            raise TTSError(_explain(resp))
        return resp
    raise TTSError(_explain(resp))


def _explain(resp: httpx.Response) -> str:
    try:
        detail = resp.json().get("detail")
        message = detail.get("message") if isinstance(detail, dict) else detail
    except ValueError:
        message = resp.text[:300]
    if resp.status_code == 401:
        return "ElevenLabs rejected the API key."
    if resp.status_code == 429:
        return "ElevenLabs is rate limiting or the character quota is used up."
    return f"ElevenLabs {resp.status_code}: {message}"


def mp3_seconds(data: bytes) -> float:
    return len(data) * 8 / BITRATE


def model_id() -> str:
    return settings.elevenlabs_model if settings.elevenlabs_model in MODELS else "eleven_multilingual_v2"


def _cache_key(workspace_id, text: str, voice_id: str, vs: VoiceSettings, variant: str) -> str:
    return keys.tts_cache(workspace_id, text, voice_id, json.dumps(vs.body(), sort_keys=True) + model_id() + variant)


def synthesize(workspace_id, text: str, voice_id: str, voice_settings: VoiceSettings | None = None,
               previous_text: str | None = None, next_text: str | None = None) -> bytes:
    vs = voice_settings or VoiceSettings()
    context = f"|{(previous_text or '')[-300:]}|{(next_text or '')[:300]}"
    key = _cache_key(workspace_id, text, voice_id, vs, OUTPUT + context)
    if storage.exists(key):
        return storage.get_bytes(key)
    body: dict = {"text": text, "model_id": model_id(), "voice_settings": vs.body()}
    if previous_text:
        body["previous_text"] = previous_text[-300:]
    if next_text:
        body["next_text"] = next_text[:300]
    resp = _request("POST", f"/text-to-speech/{voice_id}", params={"output_format": OUTPUT}, json=body)
    storage.put_bytes(key, resp.content, "audio/mpeg")
    return resp.content


@dataclass
class Line:
    text: str
    voice_id: str
    settings: VoiceSettings


def synthesize_many(workspace_id, lines: list[Line], on_done: Callable[[int], None] | None = None,
                    workers: int = 4) -> list[bytes]:
    """Render a whole script in parallel, in order. Each line hears its neighbours for natural flow."""
    def render(i: int) -> bytes:
        line = lines[i]
        prev_text = lines[i - 1].text if i > 0 else None
        next_text = lines[i + 1].text if i + 1 < len(lines) else None
        return synthesize(workspace_id, line.text, line.voice_id, line.settings, prev_text, next_text)

    out: list[bytes | None] = [None] * len(lines)
    done = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(render, i): i for i in range(len(lines))}
        for fut, i in futures.items():
            out[i] = fut.result()
            done += 1
            if on_done:
                on_done(done)
    return [b or b"" for b in out]


def synthesize_with_timestamps(workspace_id, text: str, voice_id: str,
                               voice_settings: VoiceSettings | None = None) -> tuple[bytes, list[dict]]:
    """Audio plus word timings [{text, startMs, endMs}] for captions."""
    vs = voice_settings or VoiceSettings()
    key = _cache_key(workspace_id, text, voice_id, vs, "timestamps") + ".json"
    if storage.exists(key):
        data = json.loads(storage.get_bytes(key))
    else:
        body = {"text": text, "model_id": model_id(), "voice_settings": vs.body()}
        data = _request("POST", f"/text-to-speech/{voice_id}/with-timestamps", params={"output_format": OUTPUT},
                        json=body).json()
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


# Voices


def _voice(v: dict) -> dict:
    labels = v.get("labels") or {}
    return {
        "voice_id": v["voice_id"],
        "name": v.get("name") or "Voice",
        "category": v.get("category"),
        "preview_url": v.get("preview_url"),
        "description": v.get("description") or labels.get("description"),
        "labels": {k: labels[k] for k in ("accent", "age", "gender", "use_case", "descriptive") if labels.get(k)},
    }


def list_voices() -> list[dict]:
    """Voices on the account: premade, added library voices, clones."""
    if not settings.elevenlabs_api_key:
        return PREMADE
    try:
        data = _request("GET", "/voices", attempts=2, timeout=20).json()
    except TTSError:
        return PREMADE
    return [_voice(v) for v in data.get("voices", [])]


def search_library(*, search: str = "", gender: str = "", age: str = "", accent: str = "", language: str = "",
                   use_case: str = "", page: int = 0, page_size: int = 24) -> dict:
    """ElevenLabs Voice Library: community voices licensed for commercial use on paid ElevenLabs plans."""
    params = {"page_size": page_size, "page": page, "sort": "trending"}
    for k, v in {"search": search, "gender": gender, "age": age, "accent": accent, "language": language,
                 "use_cases": use_case}.items():
        if v:
            params[k] = v
    data = _request("GET", "/shared-voices", params=params, attempts=2, timeout=20).json()
    voices = [
        {
            "public_owner_id": v["public_owner_id"],
            "voice_id": v["voice_id"],
            "name": v.get("name"),
            "description": v.get("description"),
            "preview_url": v.get("preview_url"),
            "gender": v.get("gender"),
            "age": v.get("age"),
            "accent": v.get("accent"),
            "language": v.get("language"),
            "use_case": v.get("use_case"),
            "descriptive": v.get("descriptive"),
            "category": v.get("category"),
            "cloned_by_count": v.get("cloned_by_count"),
            "free_users_allowed": v.get("free_users_allowed", True),
            "notice_period": v.get("notice_period"),
        }
        for v in data.get("voices", [])
    ]
    return {"voices": voices, "has_more": bool(data.get("has_more"))}


def add_library_voice(public_owner_id: str, voice_id: str, name: str) -> str:
    resp = _request("POST", f"/voices/add/{public_owner_id}/{voice_id}", json={"new_name": name[:100]},
                    attempts=2, timeout=30)
    return resp.json()["voice_id"]


def clone_voice(name: str, samples: list[tuple[str, bytes, str]], *, remove_background_noise: bool = True,
                description: str = "") -> str:
    """Instant Voice Clone from one or more (filename, bytes, content_type) samples."""
    files = [("files", (fn, data, ct)) for fn, data, ct in samples]
    resp = _request("POST", "/voices/add", attempts=2, timeout=180, files=files, data={
        "name": name[:100],
        "description": description or "Notestack consented voice clone",
        "remove_background_noise": "true" if remove_background_noise else "false",
        "labels": json.dumps({"source": "notestack"}),
    })
    return resp.json()["voice_id"]


def delete_voice(voice_id: str) -> None:
    _request("DELETE", f"/voices/{voice_id}", attempts=2, timeout=30)


def subscription() -> dict:
    """Character quota, so the UI can warn before a long render."""
    try:
        data = _request("GET", "/user/subscription", attempts=1, timeout=15).json()
    except TTSError:
        return {}
    return {"tier": data.get("tier"), "character_count": data.get("character_count"),
            "character_limit": data.get("character_limit"),
            "can_use_instant_voice_cloning": data.get("can_use_instant_voice_cloning"),
            "voice_slots_used": data.get("voice_slots_used"), "voice_limit": data.get("voice_limit")}

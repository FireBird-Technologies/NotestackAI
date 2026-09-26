"""Audio overviews (two hosts, ElevenLabs), videos and stills (Remotion renderer)."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.corpus import Corpus
from app.llm import run
from app.llm.signatures import PickQuotes, PodcastScript, VideoStoryboard
from app.models import Artifact, Document, Job, Source, User, VoiceProfile, Workspace
from app.pipeline.generate import NothingToDo
from app.pipeline.passages import notebook_docs, passages_for, tools_for, verify_refs
from app.services import tts
from app.services.jobs import record_usage, update_job
from app.services.renderer import PermanentJobError, brand_props, request_render
from app.services.storage import keys, storage

SCENE_TYPES = {"title", "section", "pull_quote", "number", "outro"}
VIDEO_STYLES = {
    "short": ("ShortVertical", "9:16"),
    "explainer": ("ExplainerLong", "16:9"),
}


def artifact_docs(db: Session, artifact: Artifact) -> list[Document]:
    if artifact.document_id:
        doc = db.get(Document, artifact.document_id)
        return [doc] if doc and doc.path else []
    if artifact.notebook_id:
        return notebook_docs(db, artifact.notebook_id)
    return []


def host_voices(db: Session, workspace_id: uuid.UUID) -> tuple[str, str]:
    vp = db.scalar(select(VoiceProfile).where(VoiceProfile.workspace_id == workspace_id))
    voices = (vp.host_voices if vp else None) or {}
    return voices.get("host_a") or settings.elevenlabs_voice_a, voices.get("host_b") or settings.elevenlabs_voice_b


def host_settings(db: Session, workspace_id: uuid.UUID) -> dict[str, tts.VoiceSettings]:
    """Per host delivery settings (stability, similarity, style, speed) saved on the Voice page."""
    vp = db.scalar(select(VoiceProfile).where(VoiceProfile.workspace_id == workspace_id))
    saved = ((vp.host_voices if vp else None) or {}).get("settings") or {}
    return {h: tts.VoiceSettings.from_dict(saved.get(h)) for h in ("host_a", "host_b")}


def _require_tts() -> None:
    if not settings.elevenlabs_api_key:
        raise PermanentJobError("Audio needs ELEVENLABS_API_KEY in .env")


# Audio overview


def audio_overview(db: Session, job: Job, artifact: Artifact) -> dict:
    _require_tts()
    params = job.params
    docs = artifact_docs(db, artifact)
    if not docs:
        raise NothingToDo("Add posts before making an audio overview.")
    corpus = Corpus(artifact.workspace_id)
    update_job(db, job, progress=0.05, message=f"Reading {len(docs)} posts")
    passages = passages_for(corpus, docs, budget_chars=90_000)
    update_job(db, job, progress=0.15, message="Writing the conversation")
    out = run.predict(PodcastScript, db=db, workspace_id=artifact.workspace_id, job=job, passages=passages,
                      format=params.get("format", "deep_dive"), target_minutes=int(params.get("minutes", 6)))
    lines = [ln for ln in (out.get("lines") or []) if (ln.get("text") or "").strip()]
    if not lines:
        raise RuntimeError("The script came back empty")
    tools = tools_for(corpus, docs)
    voice_a, voice_b = host_voices(db, artifact.workspace_id)
    delivery = host_settings(db, artifact.workspace_id)
    script = [
        tts.Line(text=ln["text"], voice_id=voice_b if ln.get("speaker") == "host_b" else voice_a,
                 settings=delivery["host_b" if ln.get("speaker") == "host_b" else "host_a"])
        for ln in lines
    ]
    update_job(db, job, progress=0.2, message=f"Recording {len(script)} lines")

    def progress(done: int) -> None:
        if done % 3 == 0 or done == len(script):
            update_job(db, job, progress=0.2 + 0.75 * done / len(script),
                       message=f"Recorded {done} of {len(script)} lines")

    clips = tts.synthesize_many(artifact.workspace_id, script, on_done=progress)
    audio = bytearray()
    segments = []
    t = 0.0
    for line, clip in zip(lines, clips, strict=True):
        seconds = tts.mp3_seconds(clip)
        segments.append({"speaker": line.get("speaker", "host_a"), "text": line["text"],
                         "start": round(t, 2), "end": round(t + seconds, 2),
                         "sources": verify_refs(tools, line.get("sources") or [])})
        audio += clip
        t += seconds
    key = keys.artifact(artifact.workspace_id, artifact.id, "audio", "mp3")
    storage.put_bytes(key, bytes(audio), "audio/mpeg")
    artifact.storage_key = key
    artifact.status = "ready"
    artifact.content_json = {
        **(artifact.content_json or {}),
        "format": params.get("format", "deep_dive"),
        "duration_s": round(t, 1),
        "segments": segments,
        "voices": {"host_a": voice_a, "host_b": voice_b},
    }
    db.commit()
    record_usage(db, workspace_id=artifact.workspace_id, kind="tts", provider="elevenlabs",
                 quantity=round(t, 1), unit="seconds", job=job)
    return {"artifact_id": str(artifact.id), "duration_s": round(t, 1)}


# Video


def _clamp(value, lo: float, hi: float) -> float:
    try:
        return max(lo, min(hi, float(value)))
    except (TypeError, ValueError):
        return lo


def make_video(db: Session, job: Job, artifact: Artifact) -> None:
    style = job.params.get("style", "short")
    if style == "audiogram":
        return make_audiogram(db, job, artifact)
    composition, aspect = VIDEO_STYLES[style]
    docs = artifact_docs(db, artifact)
    if not docs:
        raise NothingToDo("Add posts before making a video.")
    corpus = Corpus(artifact.workspace_id)
    workspace = db.get(Workspace, artifact.workspace_id)
    update_job(db, job, progress=0.05, message="Storyboarding")
    passages = passages_for(corpus, docs, budget_chars=60_000)
    out = run.predict(VideoStoryboard, db=db, workspace_id=artifact.workspace_id, job=job,
                      passages=passages, aspect=aspect)
    scenes = [s for s in (out.get("scenes") or []) if (s.get("on_screen_text") or "").strip()]
    if not scenes:
        raise RuntimeError("The storyboard came back empty")
    max_scenes = 8 if style == "short" else 14
    scenes = scenes[:max_scenes]

    captions: list[dict] = []
    audio = bytearray()
    cursor = 0.0
    voice_a, _ = host_voices(db, artifact.workspace_id)
    narrator = host_settings(db, artifact.workspace_id)["host_a"]
    out_scenes = []
    for i, s in enumerate(scenes):
        narration = (s.get("narration") or "").strip()
        duration = _clamp(s.get("duration_hint_s"), 2.0, 20.0)
        if narration and settings.elevenlabs_api_key:
            update_job(db, job, progress=0.15 + 0.5 * i / len(scenes), message=f"Narrating scene {i + 1}")
            clip, words = tts.synthesize_with_timestamps(artifact.workspace_id, narration, voice_a, narrator)
            seconds = tts.mp3_seconds(clip)
            # Pad with silence so each clip starts exactly when its scene does.
            audio += _silence(cursor - tts.mp3_seconds(bytes(audio)))
            offset = int(cursor * 1000)
            captions += [{**w, "startMs": w["startMs"] + offset, "endMs": w["endMs"] + offset} for w in words]
            audio += clip
            duration = max(duration, seconds + 0.3)
        cursor += duration
        scene_type = s.get("type") if s.get("type") in SCENE_TYPES else "section"
        out_scenes.append({"type": scene_type, "onScreenText": s["on_screen_text"][:300],
                           "narration": narration, "durationS": round(_clamp(duration, 0.5, 60), 2)})

    props: dict = {"scenes": out_scenes, "captions": captions, "brand": brand_props(workspace)}
    title = docs[0].title if len(docs) == 1 else (artifact.content_json or {}).get("title", "Notestack")
    if composition == "ShortVertical":
        hook = next((sc["onScreenText"] for sc in out_scenes if sc["type"] == "title"), title)
        props["hook"] = hook[:120]
    else:
        props["title"] = title[:140]
    if audio:
        key = keys.artifact(artifact.workspace_id, artifact.id, "narration", "mp3")
        storage.put_bytes(key, bytes(audio), "audio/mpeg")
        props["audioUrl"] = storage.presign_get(key, ttl=6 * 3600)
    artifact.content_json = {**(artifact.content_json or {}), "style": style, "composition": composition,
                             "scenes": out_scenes, "duration_s": round(cursor, 1)}
    artifact.status = "rendering"
    db.commit()
    update_job(db, job, progress=0.7, message="Handing off to the renderer")
    request_render(job, artifact, composition, props)
    record_usage(db, workspace_id=artifact.workspace_id, kind="video", provider="remotion",
                 quantity=round(cursor, 1), unit="seconds", job=job)


_SILENT_FRAME = None


def _silence(seconds: float) -> bytes:
    """MPEG1 Layer III 128 kbps 44.1 kHz silent frames (417 bytes, ~26 ms each)."""
    global _SILENT_FRAME
    if _SILENT_FRAME is None:
        _SILENT_FRAME = bytes([0xFF, 0xFB, 0x90, 0x64]) + bytes(413)
    frames = int(seconds / 0.026122)
    return _SILENT_FRAME * max(frames, 0)


def make_audiogram(db: Session, job: Job, artifact: Artifact) -> None:
    source = db.get(Artifact, uuid.UUID(job.params["audio_artifact_id"]))
    if not source or source.type != "audio_overview" or not source.storage_key:
        raise PermanentJobError("Pick a finished audio overview for the audiogram.")
    workspace = db.get(Workspace, artifact.workspace_id)
    content = source.content_json or {}
    duration = float(content.get("duration_s") or 30)
    segments = [{"speaker": s["speaker"], "text": s["text"], "startMs": int(s["start"] * 1000),
                 "endMs": int(s["end"] * 1000)} for s in content.get("segments", [])]
    props = {"title": (content.get("title") or "Audio overview")[:140],
             "audioUrl": storage.presign_get(source.storage_key, ttl=6 * 3600),
             "durationS": round(min(duration, 600), 2), "segments": segments, "brand": brand_props(workspace)}
    artifact.content_json = {**(artifact.content_json or {}), "style": "audiogram", "composition": "AudiogramSquare",
                             "audio_artifact_id": str(source.id), "duration_s": props["durationS"]}
    artifact.status = "rendering"
    db.commit()
    update_job(db, job, progress=0.1, message="Handing off to the renderer")
    request_render(job, artifact, "AudiogramSquare", props)
    record_usage(db, workspace_id=artifact.workspace_id, kind="video", provider="remotion",
                 quantity=props["durationS"], unit="seconds", job=job)


# Stills


def author_line(db: Session, workspace_id: uuid.UUID) -> str:
    ws = db.get(Workspace, workspace_id)
    owner = db.get(User, ws.owner_id) if ws else None
    return (ws.brand_json or {}).get("name") or (owner.name if owner and owner.name else "") or "Notestack"


def make_quote_card(db: Session, job: Job, artifact: Artifact) -> None:
    content = artifact.content_json or {}
    workspace = db.get(Workspace, artifact.workspace_id)
    if not content.get("quote"):
        docs = artifact_docs(db, artifact)
        if not docs:
            raise NothingToDo("Pick a post or notebook for the quote card.")
        corpus = Corpus(artifact.workspace_id)
        out = run.predict(PickQuotes, db=db, workspace_id=artifact.workspace_id, job=job,
                          passages=passages_for(corpus, docs, budget_chars=40_000), n=3)
        tools = tools_for(corpus, docs)
        for pick in out.get("quotes") or []:
            refs = verify_refs(tools, [pick.get("source") or {}])
            if refs and pick.get("quote"):
                content = {**content, "quote": pick["quote"][:380], "source": refs[0]}
                break
        else:
            raise RuntimeError("No verifiable quote found")
    source = content.get("source") or {}
    doc = db.scalar(select(Document).where(Document.workspace_id == artifact.workspace_id,
                                           Document.path == source.get("path")))
    publication = None
    if doc and doc.source_id:
        src = db.get(Source, doc.source_id)
        publication = src.title if src else None
    props = {"quote": content["quote"][:380], "author": author_line(db, artifact.workspace_id),
             "brand": brand_props(workspace)}
    if publication or (doc and doc.title):
        props["publication"] = (publication or doc.title)[:120]
    artifact.content_json = {**content, "composition": "QuoteCard"}
    artifact.status = "rendering"
    db.commit()
    request_render(job, artifact, "QuoteCard", props)


def render_carousel(db: Session, job: Job, artifact: Artifact) -> None:
    slides = (artifact.content_json or {}).get("slides") or []
    if not slides:
        raise PermanentJobError("This carousel has no slides.")
    workspace = db.get(Workspace, artifact.workspace_id)
    brand = brand_props(workspace)
    stills = [{"heading": s.get("heading", "")[:120], "body": s.get("body", "")[:500], "index": i + 1,
               "total": len(slides), "brand": brand} for i, s in enumerate(slides)]
    artifact.status = "rendering"
    db.commit()
    request_render(job, artifact, "CarouselSlide", stills=stills)

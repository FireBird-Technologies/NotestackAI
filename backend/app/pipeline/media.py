"""Audio overviews (one or two hosts, ElevenLabs), audiograms and stills (Remotion renderer)."""

import re
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.corpus import Corpus
from app.llm import run
from app.llm.signatures import PickQuotes, WriteAudioScript
from app.models import Artifact, Document, Job, Source, User, VoiceProfile, Workspace
from app.pipeline.generate import NothingToDo
from app.pipeline.material import load_material
from app.pipeline.passages import notebook_docs, passages_for, tools_for, verify_refs
from app.pipeline.report import SAME_LANGUAGE
from app.services import tts
from app.services.jobs import record_usage, update_job
from app.services.renderer import PermanentJobError, request_render
from app.services.storage import keys, storage


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


STYLES = {
    "deep_dive": "Deep Dive: a lively, curious conversation that unpacks the ideas and connects them to each other",
    "brief": "Brief: a short, bite sized overview that gets the core ideas across quickly",
    "critique": "Critique: an expert review of the material, with honest, constructive feedback on how to improve it",
    "debate": "Debate: two hosts take different sides on the material's main questions and argue them respectfully",
}
WORDS_PER_MINUTE = 150
_MARKUP = re.compile(r"(\*\*|__|`|#{1,6}\s|^\s*[-*•]\s+|\[\d+\])", re.M)


def script_turns(turns: list[dict], hosts: int) -> list[dict]:
    """The model's turns ready to voice: empty ones dropped and markup removed. With two hosts, consecutive turns by
    one host are joined and the speakers then strictly alternate, host A first, so the conversation always goes A, B,
    A, B. With one host, every turn is host A's."""
    clean = []
    for t in turns or []:
        text = re.sub(r"\s+", " ", _MARKUP.sub("", str((t or {}).get("text") or ""))).replace("\u2014", ", ").strip()
        if text:
            clean.append({"speaker": (t or {}).get("speaker") or "host_a", "text": text,
                          "sources": list((t or {}).get("sources") or [])})
    if hosts == 1:
        return [{**t, "speaker": "host_a"} for t in clean]
    merged: list[dict] = []
    for t in clean:
        if merged and merged[-1]["speaker"] == t["speaker"]:
            merged[-1]["text"] += " " + t["text"]
            merged[-1]["sources"] += t["sources"]
        else:
            merged.append(dict(t))
    return [{**t, "speaker": "host_a" if i % 2 == 0 else "host_b"} for i, t in enumerate(merged)]


def audio_overview(db: Session, job: Job, artifact: Artifact) -> dict:
    _require_tts()
    params = dict(job.params)
    if artifact.document_id and not params.get("document_ids") and not params.get("chat_ids"):
        params["document_ids"] = [str(artifact.document_id)]  # made from one post
    fmt = params.get("format") if params.get("format") in STYLES else "deep_dive"
    hosts = 1 if params.get("hosts") == 1 else 2  # older jobs had no choice: two hosts
    minutes = int(params.get("minutes", 6))
    focus = (params.get("instructions") or "").strip()
    material = load_material(db, artifact.workspace_id, artifact.notebook_id, params, job=job, what="audio overview")
    update_job(db, job, progress=0.15, message="Writing the conversation" if hosts == 2 else "Writing the narration")
    out = run.predict(WriteAudioScript, db=db, workspace_id=artifact.workspace_id, job=job, title=material.title,
                      material=material.text, style=STYLES[fmt], hosts=hosts, target_words=minutes * WORDS_PER_MINUTE,
                      focus=focus or "(none)", language=(params.get("language") or "").strip() or SAME_LANGUAGE)
    lines = script_turns(out.get("turns") or [], hosts)
    if not lines:
        raise RuntimeError("The script came back empty")
    default_a, default_b = host_voices(db, artifact.workspace_id)
    voice_a, voice_b = params.get("host_a") or default_a, params.get("host_b") or default_b  # picked when made
    delivery = host_settings(db, artifact.workspace_id)
    script = [
        tts.Line(text=ln["text"], voice_id=voice_b if ln["speaker"] == "host_b" else voice_a,
                 settings=delivery[ln["speaker"]])
        for ln in lines
    ]
    update_job(db, job, progress=0.2, message=f"Recording {len(script)} lines")

    def progress(done: int) -> None:
        if done % 3 == 0 or done == len(script):
            update_job(db, job, progress=0.2 + 0.75 * done / len(script),
                       message=f"Recorded {done} of {len(script)} lines")

    clips = tts.synthesize_many(artifact.workspace_id, script, on_done=progress)
    # Every clip is the same MP3 format (mp3_44100_128), so the clips join into one file in order.
    audio = bytearray()
    segments = []
    t = 0.0
    for line, clip in zip(lines, clips, strict=True):
        seconds = tts.mp3_seconds(clip)
        segments.append({"speaker": line["speaker"], "text": line["text"],
                         "start": round(t, 2), "end": round(t + seconds, 2), "sources": material.refs(line["sources"])})
        audio += clip
        t += seconds
    key = keys.artifact(artifact.workspace_id, artifact.id, "audio", "mp3")
    storage.put_bytes(key, bytes(audio), "audio/mpeg")
    artifact.storage_key = key
    artifact.status = "ready"
    artifact.content_json = {
        **(artifact.content_json or {}),
        "format": fmt,
        "hosts": hosts,
        "focus": focus,
        "language": params.get("language") or "",
        "source": material.source,
        "duration_s": round(t, 1),
        "segments": segments,
        "voices": {"host_a": voice_a, **({"host_b": voice_b} if hosts == 2 else {})},
    }
    db.commit()
    record_usage(db, workspace_id=artifact.workspace_id, kind="tts", provider="elevenlabs",
                 quantity=round(t, 1), unit="seconds", job=job)
    return {"artifact_id": str(artifact.id), "duration_s": round(t, 1)}


# Video: blog2video makes videos now (app/routers/videos.py). The renderer still makes audiograms.


def make_video(db: Session, job: Job, artifact: Artifact) -> None:
    if job.params.get("style") == "audiogram":
        return make_audiogram(db, job, artifact)
    raise PermanentJobError("Videos are now made in the Videos editor.")


def make_audiogram(db: Session, job: Job, artifact: Artifact) -> None:
    source = db.get(Artifact, uuid.UUID(job.params["audio_artifact_id"]))
    if not source or source.type != "audio_overview" or not source.storage_key:
        raise PermanentJobError("Pick a finished audio overview for the audiogram.")
    content = source.content_json or {}
    duration = float(content.get("duration_s") or 30)
    segments = [{"speaker": s["speaker"], "text": s["text"], "startMs": int(s["start"] * 1000),
                 "endMs": int(s["end"] * 1000)} for s in content.get("segments", [])]
    props = {"title": (content.get("title") or "Audio overview")[:140],
             "audioUrl": storage.presign_get(source.storage_key, ttl=6 * 3600),
             "durationS": round(min(duration, 600), 2), "segments": segments }
    artifact.content_json = {**(artifact.content_json or {}), "style": "audiogram", "composition": "AudiogramSquare",
                             "audio_artifact_id": str(source.id), "duration_s": props["durationS"]}
    artifact.status = "rendering"
    db.commit()
    update_job(db, job, progress=0.1, message="Handing off to the renderer")
    request_render(job, artifact, "AudiogramSquare", props)
    record_usage(db, workspace_id=artifact.workspace_id, kind="render", provider="remotion",
                 quantity=props["durationS"], unit="seconds", job=job)


# Stills


def author_line(db: Session, workspace_id: uuid.UUID) -> str:
    ws = db.get(Workspace, workspace_id)
    owner = db.get(User, ws.owner_id) if ws else None
    return (owner.name if owner and owner.name else "") or "Notestack"


def make_quote_card(db: Session, job: Job, artifact: Artifact) -> None:
    content = artifact.content_json or {}
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
    props = {"quote": content["quote"][:380], "author": author_line(db, artifact.workspace_id)}
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
    stills = [{"heading": s.get("heading", "")[:120], "body": s.get("body", "")[:500], "index": i + 1,
               "total": len(slides)} for i, s in enumerate(slides)]
    artifact.status = "rendering"
    db.commit()
    request_render(job, artifact, "CarouselSlide", stills=stills)

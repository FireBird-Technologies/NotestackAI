"""Turn downloaded NotebookLM Audio/Video Overviews into Markdown sources.

KastorFlow shows that NotebookLM's ``gArtLc`` response is the useful index:

* row[0] is the artifact id
* row[1] is the title
* row[2] is the type (1 audio, 3 video)
* row[4] is the status (3 completed)
* row[6][5] contains audio renditions
* row[8] contains video renditions

Those rows contain downloadable media, not a transcript.  This utility runs a
local Whisper CLI over the downloaded MP4/M4A and writes the spoken script as a
Markdown source.  Keeping transcription local also means Google cookies and
NotebookLM session tokens never leave the browser.

Typical use (after downloading an Overview from NotebookLM):

    cd backend
    .venv/bin/python scripts/notebooklm_media_to_markdown.py \
        ~/Downloads/overview.m4a --kind audio_overview --title "Weekly brief"

The ``whisper`` command comes from the optional ``openai-whisper`` package and
requires ffmpeg.  Use ``--whisper-command`` when the executable has another
name.  ``--transcript-json`` accepts an existing Whisper JSON result and is
useful when transcription is performed by a separate worker.

For diagnostics, ``--g-art-lc`` reads either decoded rows, ``{"rows": [...]}``,
or a raw batchexecute response and prints a safe manifest.  Query strings are
removed from displayed URLs because NotebookLM media links are short lived and
may carry signed parameters.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

ArtifactKind = Literal["audio_overview", "video_overview"]


@dataclass(frozen=True)
class MediaArtifact:
    artifact_id: str
    title: str
    kind: ArtifactKind
    media_url: str
    created_at: str | None = None


@dataclass(frozen=True)
class TranscriptSegment:
    start: float
    end: float
    text: str


def _valid_url(value: Any) -> str | None:
    return value if isinstance(value, str) and value.startswith(("https://", "http://")) else None


def _created_at(value: Any) -> str | None:
    if not isinstance(value, list) or not value or not isinstance(value[0], int | float):
        return None
    seconds = float(value[0])
    if seconds > 1e15:
        seconds /= 1_000_000
    elif seconds > 1e12:
        seconds /= 1_000
    elif seconds <= 1e9:
        return None
    if len(value) > 1 and isinstance(value[1], int | float) and seconds < 1e12:
        seconds += float(value[1]) / 1_000_000_000
    try:
        return datetime.fromtimestamp(seconds, tz=UTC).isoformat()
    except (OSError, OverflowError, ValueError):
        return None


def _audio_url(row: list[Any]) -> str | None:
    try:
        renditions = row[6][5]
    except (IndexError, TypeError):
        return None
    fallback = None
    for rendition in renditions if isinstance(renditions, list) else []:
        if not isinstance(rendition, list) or not rendition:
            continue
        url = _valid_url(rendition[0])
        if not url:
            continue
        fallback = fallback or url
        if len(rendition) > 2 and rendition[2] == "audio/mp4":
            return url
    return fallback


def _video_url(row: list[Any]) -> str | None:
    try:
        variants = row[8]
    except IndexError:
        return None
    fallback = None
    best = None
    for renditions in variants if isinstance(variants, list) else []:
        for rendition in renditions if isinstance(renditions, list) else []:
            if not isinstance(rendition, list) or not rendition:
                continue
            url = _valid_url(rendition[0])
            if not url:
                continue
            fallback = fallback or url
            if len(rendition) > 2 and rendition[2] == "video/mp4":
                best = url
                if len(rendition) > 1 and rendition[1] == 4:
                    return url
    return best or fallback


def artifact_from_row(raw: Any) -> MediaArtifact | None:
    """Return one completed audio/video artifact from a decoded gArtLc row."""
    if not isinstance(raw, list) or len(raw) < 5 or raw[4] != 3:
        return None
    artifact_id = raw[0] if isinstance(raw[0], str) else ""
    title = raw[1] if len(raw) > 1 and isinstance(raw[1], str) else ""
    type_code = raw[2] if len(raw) > 2 else None
    if type_code == 1:
        kind: ArtifactKind = "audio_overview"
        media_url = _audio_url(raw)
    elif type_code == 3:
        kind = "video_overview"
        media_url = _video_url(raw)
    else:
        return None
    if not artifact_id or not media_url:
        return None
    created = _created_at(raw[15]) if len(raw) > 15 else None
    return MediaArtifact(artifact_id, title or "NotebookLM overview", kind, media_url, created)


def _decoded_rows(value: Any) -> list[Any]:
    if isinstance(value, dict):
        return value.get("rows", []) if isinstance(value.get("rows"), list) else []
    if not isinstance(value, list):
        return []
    if value and isinstance(value[0], list) and value[0] and isinstance(value[0][0], list):
        return value[0]
    return value


def read_g_art_lc(path: Path) -> list[MediaArtifact]:
    """Read decoded rows or NotebookLM's newline-delimited batchexecute body."""
    text = path.read_text(encoding="utf-8")
    rows: list[Any] = []
    try:
        rows = _decoded_rows(json.loads(text))
    except json.JSONDecodeError:
        stripped = text[4:] if text.startswith(")]}'") else text
        for line in stripped.splitlines():
            try:
                outer = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(outer, list) or not outer or not isinstance(outer[0], list) \
                    or len(outer[0]) < 3 or outer[0][0:2] != ["wrb.fr", "gArtLc"]:
                continue
            inner = json.loads(outer[0][2])
            rows = _decoded_rows(inner)
            break
    return [artifact for row in rows if (artifact := artifact_from_row(row))]


def _timestamp(seconds: float) -> str:
    total = max(0, round(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}" if hours else f"{minutes:02d}:{secs:02d}"


def parse_transcript(payload: dict[str, Any]) -> tuple[str | None, list[TranscriptSegment]]:
    language = payload.get("language") if isinstance(payload.get("language"), str) else None
    segments = []
    for raw in payload.get("segments", []) if isinstance(payload.get("segments"), list) else []:
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text") or "").strip()
        if not text:
            continue
        try:
            start = float(raw.get("start") or 0)
            end = float(raw.get("end") or start)
        except (TypeError, ValueError):
            continue
        segments.append(TranscriptSegment(start, max(start, end), text))
    if not segments and isinstance(payload.get("text"), str) and payload["text"].strip():
        segments.append(TranscriptSegment(0, 0, payload["text"].strip()))
    return language, segments


def _yaml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def render_markdown(
    *,
    title: str,
    kind: ArtifactKind,
    segments: Iterable[TranscriptSegment],
    artifact_id: str = "",
    notebook_id: str = "",
    notebook_title: str = "",
    created_at: str | None = None,
    language: str | None = None,
) -> str:
    """Build a durable, searchable NotebookLM media-script source."""
    type_label = "Audio Overview" if kind == "audio_overview" else "Video Overview"
    frontmatter = [
        "---",
        "type: notebooklm-media-script",
        f"artifact_type: {kind}",
        f"title: {_yaml_string(title)}",
    ]
    if artifact_id:
        frontmatter.append(f"artifact_id: {_yaml_string(artifact_id)}")
    if notebook_id:
        frontmatter.append(f"notebook_id: {_yaml_string(notebook_id)}")
    if notebook_title:
        frontmatter.append(f"notebook_title: {_yaml_string(notebook_title)}")
    if created_at:
        frontmatter.append(f"created_at: {_yaml_string(created_at)}")
    if language:
        frontmatter.append(f"language: {_yaml_string(language)}")
    frontmatter.extend(["transcript_source: speech-to-text", "---", ""])

    body = [
        f"# {title}",
        "",
        f"> Transcript of a NotebookLM {type_label}. This text was recovered from the spoken media and may contain transcription errors.",
        "",
        "## Script",
        "",
    ]
    items = list(segments)
    if not items:
        body.extend(["*(No spoken text was detected.)*", ""])
    else:
        for segment in items:
            body.extend([f"**[{_timestamp(segment.start)}]** {segment.text}", ""])
    return "\n".join(frontmatter + body).rstrip() + "\n"


def safe_filename(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().strip(".")
    return (cleaned[:160] or "NotebookLM overview") + ".md"


def run_whisper(media_path: Path, command: str, model: str, language: str | None) -> dict[str, Any]:
    executable = shutil.which(command)
    if not executable:
        raise RuntimeError(
            f"{command!r} was not found. Install openai-whisper (and ffmpeg), or pass --transcript-json."
        )
    with tempfile.TemporaryDirectory(prefix="notestack-whisper-") as raw_tmp:
        tmp = Path(raw_tmp)
        args = [
            executable,
            str(media_path),
            "--model",
            model,
            "--output_dir",
            str(tmp),
            "--output_format",
            "json",
            "--fp16",
            "False",
        ]
        if language:
            args.extend(["--language", language])
        subprocess.run(args, check=True)
        result = tmp / f"{media_path.stem}.json"
        if not result.is_file():
            found = list(tmp.glob("*.json"))
            if len(found) != 1:
                raise RuntimeError("Whisper finished without producing a JSON transcript.")
            result = found[0]
        return json.loads(result.read_text(encoding="utf-8"))


def _stable_local_id(path: Path, kind: ArtifactKind) -> str:
    identity = f"{kind}\0{path.name}\0{path.stat().st_size}".encode()
    return "local-" + hashlib.sha256(identity).hexdigest()[:24]


def _redact_url(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("media", nargs="?", type=Path, help="downloaded NotebookLM audio/video file")
    parser.add_argument("--kind", choices=("audio_overview", "video_overview"))
    parser.add_argument("--title")
    parser.add_argument("--artifact-id", default="")
    parser.add_argument("--notebook-id", default="")
    parser.add_argument("--notebook-title", default="")
    parser.add_argument("--created-at")
    parser.add_argument("--language")
    parser.add_argument("--model", default="small", help="local Whisper model (default: small)")
    parser.add_argument("--whisper-command", default="whisper")
    parser.add_argument("--transcript-json", type=Path, help="use an existing Whisper JSON response")
    parser.add_argument("--output", type=Path, default=Path("."), help="output directory or .md filename")
    parser.add_argument("--g-art-lc", type=Path, help="inspect a decoded/raw gArtLc response and print media manifest")
    return parser.parse_args()


def main() -> int:
    args = _args()
    if args.g_art_lc:
        safe = [
            {**asdict(item), "media_url": _redact_url(item.media_url)}
            for item in read_g_art_lc(args.g_art_lc)
        ]
        print(json.dumps(safe, ensure_ascii=False, indent=2))
        return 0
    if not args.media or not args.media.is_file():
        print("Pass a downloaded media file, or use --g-art-lc to inspect artifact rows.", file=sys.stderr)
        return 2
    if not args.kind:
        print("--kind is required for a media file.", file=sys.stderr)
        return 2

    payload = (
        json.loads(args.transcript_json.read_text(encoding="utf-8"))
        if args.transcript_json
        else run_whisper(args.media, args.whisper_command, args.model, args.language)
    )
    language, segments = parse_transcript(payload)
    title = args.title or args.media.stem
    artifact_id = args.artifact_id or _stable_local_id(args.media, args.kind)
    markdown = render_markdown(
        title=title,
        kind=args.kind,
        segments=segments,
        artifact_id=artifact_id,
        notebook_id=args.notebook_id,
        notebook_title=args.notebook_title,
        created_at=args.created_at,
        language=language or args.language,
    )
    destination = args.output if args.output.suffix.lower() == ".md" else args.output / safe_filename(title)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(markdown, encoding="utf-8")
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

import json

from scripts.notebooklm_media_to_markdown import (
    TranscriptSegment,
    artifact_from_row,
    parse_transcript,
    read_g_art_lc,
    render_markdown,
    safe_filename,
)


def test_extracts_completed_audio_and_prefers_mp4():
    row = ["audio-1", "A useful conversation", 1, None, 3, None, [None, None, None, None, None, [
        ["https://media.test/fallback.bin", 1, "application/octet-stream"],
        ["https://media.test/audio.mp4?token=secret", 2, "audio/mp4"],
    ]]]
    artifact = artifact_from_row(row)
    assert artifact is not None
    assert artifact.artifact_id == "audio-1"
    assert artifact.kind == "audio_overview"
    assert artifact.media_url.endswith("audio.mp4?token=secret")


def test_extracts_high_quality_completed_video_and_skips_pending():
    row = ["video-1", "A short explainer", 3, None, 3, None, None, None, [
        [["https://media.test/low.mp4", 2, "video/mp4"]],
        [["https://media.test/high.mp4", 4, "video/mp4"]],
    ]]
    artifact = artifact_from_row(row)
    assert artifact is not None
    assert artifact.kind == "video_overview"
    assert artifact.media_url.endswith("high.mp4")
    row[4] = 2
    assert artifact_from_row(row) is None


def test_reads_raw_batchexecute_response(tmp_path):
    row = ["audio-1", "Audio", 1, None, 3, None, [None, None, None, None, None, [
        ["https://media.test/audio.mp4", 2, "audio/mp4"],
    ]]]
    inner = json.dumps([[row]])
    outer = json.dumps([["wrb.fr", "gArtLc", inner]])
    path = tmp_path / "response.txt"
    path.write_text(")]}'\n" + outer + "\n", encoding="utf-8")
    assert read_g_art_lc(path) == [artifact_from_row(row)]


def test_transcript_fallback_and_markdown_metadata():
    language, segments = parse_transcript({"language": "en", "text": "A single recovered script."})
    assert language == "en"
    markdown = render_markdown(
        title="Weekly: Review",
        kind="audio_overview",
        segments=segments,
        artifact_id="artifact-7",
        notebook_id="notebook-2",
        notebook_title="Research",
        language=language,
    )
    assert "type: notebooklm-media-script" in markdown
    assert "artifact_type: audio_overview" in markdown
    assert 'artifact_id: "artifact-7"' in markdown
    assert "## Script" in markdown
    assert "**[00:00]** A single recovered script." in markdown


def test_timestamps_and_safe_filename():
    markdown = render_markdown(
        title="Explainer",
        kind="video_overview",
        segments=[TranscriptSegment(65.4, 70, "Second section")],
    )
    assert "**[01:05]** Second section" in markdown
    assert safe_filename('Bad / title: "x"') == "Bad title x.md"

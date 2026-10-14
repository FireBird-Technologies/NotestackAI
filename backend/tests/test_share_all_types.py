"""Every finished artifact can be shared by a link on NoteStack's own domain, and the public view carries only what is
whitelisted for its type."""

import pytest

from app.models import Artifact, Workspace
from tests.conftest import last_code

SOURCE = {"document_id": "doc-secret", "title": "On Pricing", "line_start": 1, "line_end": 2, "quote": "QUOTED LINE"}

CONTENT = {
    "flashcards": {"title": "Pricing cards", "cards": [{"front": "Why price high?", "back": "Readers value it.",
                                                         "sources": [SOURCE]}]},
    "quiz": {"title": "Pricing quiz", "questions": [{"type": "multiple_choice", "question": "Best price?",
                                                     "options": ["$5", "$10"], "correct": [1],
                                                     "explanation": "Ten dollars doubled the tier.", "sources": [SOURCE]}]},
    "audio_overview": {"title": "Pricing talk", "duration_s": 61.5,
                       "segments": [{"speaker": "A", "text": "Let's talk pricing.", "start": 0, "end": 3,
                                     "sources": [SOURCE]}]},
    "mind_map": {"title": "Pricing map", "root": {"id": "r", "label": "Pricing", "note": "The centre.", "sources": [SOURCE],
                                                  "children": [{"id": "c1", "label": "Tiers", "note": "", "sources": [SOURCE],
                                                                "children": []}]}},
    "video": {"title": "Pricing video", "video_url": "https://cdn.test/v.mp4", "preview_url": "https://b2v.test/p/1",
              "b2v_video_id": 812},
    "mind_map": {"title": "Pricing constellation", "root": {"id": "root", "label": "Pricing", "note": "Overview",
                  "sources": [SOURCE], "children": [{"id": "a", "label": "Value", "note": "Readers value it",
                                                       "sources": [SOURCE], "children": []}]}},
}
KIND = {"flashcards": "flashcards", "quiz": "quiz", "audio_overview": "audio", "video": "video", "mind_map": "mind_map"}


@pytest.fixture()
def auth(client):
    client.post("/api/auth/email/register/start", json={"email": "ada@example.com", "password": "stardust-42"})
    r = client.post("/api/auth/email/register/verify", json={"email": "ada@example.com", "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def make(db, kind: str, status: str = "ready", **extra) -> Artifact:
    ws = db.query(Workspace).one()
    a = Artifact(workspace_id=ws.id, type=kind, status=status, content_json=extra.pop("content", None) or CONTENT[kind], **extra)
    db.add(a)
    db.commit()
    return a


@pytest.mark.parametrize("kind", list(CONTENT))
def test_each_type_can_be_shared_and_shows_only_its_whitelist(client, auth, db_session, kind):
    extra = {"storage_key": "ws/x/audio.mp3"} if kind == "audio_overview" else {}
    a = make(db_session, kind, **extra)
    share = client.post(f"/api/artifacts/{a.id}/share", headers=auth).json()
    assert share["shared"] and "/r/" in share["url"]
    token = share["url"].rsplit("/", 1)[1]
    r = client.get(f"/api/public/s/{token}")  # no auth header
    assert r.status_code == 200 and r.headers["x-robots-tag"].startswith("noindex")
    body, raw = r.json(), r.text
    assert body["kind"] == KIND[kind] and body["title"] == CONTENT[kind]["title"]
    for leak in ("doc-secret", "QUOTED LINE", str(a.id), "b2v_video_id"):
        assert leak not in raw
    if kind == "flashcards":
        assert body["cards"] == [{"front": "Why price high?", "back": "Readers value it."}]
    if kind == "quiz":
        assert body["questions"][0]["correct"] == [1] and body["questions"][0]["sources"] == []
    if kind == "audio_overview":
        assert body["audio_url"] and body["duration"] == 61.5
        assert body["segments"] == [{"speaker": "A", "text": "Let's talk pricing.", "start": 0, "end": 3}]
    if kind == "mind_map":
        assert body["root"]["label"] == "Pricing" and body["root"]["sources"] == []
        assert body["root"]["children"][0]["label"] == "Tiers"
    if kind == "video":
        assert body["video_url"] == "https://cdn.test/v.mp4" and body["preview_url"] == "https://b2v.test/p/1"
    assert client.get(f"/api/public/reports/{token}").json()["kind"] == body["kind"]  # the old address works too
    client.delete(f"/api/artifacts/{a.id}/share", headers=auth)
    assert client.get(f"/api/public/s/{token}").status_code == 404


def test_an_unfinished_artifact_has_a_shareable_preview_that_turns_ready(client, auth, db_session):
    a = make(db_session, "quiz", status="generating")
    share = client.post(f"/api/artifacts/{a.id}/share", headers=auth)
    assert share.status_code == 200
    token = share.json()["url"].rsplit("/", 1)[1]
    pending = client.get(f"/api/public/s/{token}").json()
    assert pending["kind"] == "pending" and pending["artifact_type"] == "quiz"
    a.status = "ready"
    db_session.commit()
    assert client.get(f"/api/public/s/{token}").json()["kind"] == "quiz"


def test_turning_public_links_off_ends_every_type(client, auth, db_session):
    a = make(db_session, "flashcards")
    token = client.post(f"/api/artifacts/{a.id}/share", headers=auth).json()["url"].rsplit("/", 1)[1]
    client.patch("/api/settings", json={"allow_public_links": False}, headers=auth)
    assert client.get(f"/api/public/s/{token}").status_code == 404


def test_a_shared_slide_deck_shows_its_pages_without_notes_or_sources(client, auth, db_session):
    from tests.test_slides import _deck

    a = make(db_session, "slide_deck", content={"title": "Pricing deck", "deck": _deck(), "theme": "light-space", "seed": 3})
    token = client.post(f"/api/artifacts/{a.id}/share", headers=auth).json()["url"].rsplit("/", 1)[1]
    body = client.get(f"/api/public/s/{token}").json()
    assert body["kind"] == "slides" and len(body["pages"]) == 7
    assert "Say points" not in str(body) and "p.md" not in str(body)

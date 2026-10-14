"""A Mind Constellation downloads as a document of its points and their details (not a picture of the map)."""

import pytest

from app.models import Artifact, Workspace
from app.services.mind_map_export import mind_map_pdf_html
from tests.conftest import last_code

SOURCE = {"document_id": "d1", "title": "On Pricing", "line_start": 1, "line_end": 2, "quote": "QUOTED LINE"}
ROOT = {"id": "r", "label": "Pricing strategy", "note": "How the posts think about price.", "sources": [], "children": [
    {"id": "a", "label": "Tiers & anchors", "note": "", "sources": [SOURCE], "children": [
        {"id": "a1", "label": "Three tiers beat two", "note": "The middle one sells.", "sources": [SOURCE, SOURCE],
         "children": [{"id": "a11", "label": "Decoy <pricing>", "note": "A high tier makes the middle look fair.",
                       "sources": [], "children": []}]}]}]}
CONTENT = {"title": "Mind Constellation: Pricing", "root": ROOT, "node_count": 4}


@pytest.fixture()
def auth(client):
    client.post("/api/auth/email/register/start", json={"email": "ada@example.com", "password": "stardust-42"})
    r = client.post("/api/auth/email/register/verify", json={"email": "ada@example.com", "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_the_document_lists_every_point_with_its_details():
    page = mind_map_pdf_html(Artifact(type="mind_map", status="ready", content_json=CONTENT))
    assert "<h1>Pricing strategy</h1>" in page and "How the posts think about price." in page
    assert "<h2>Tiers &amp; anchors</h2>" in page and "<h3>Three tiers beat two</h3>" in page
    assert "<strong>Decoy &lt;pricing&gt;</strong>" in page and "A high tier makes the middle look fair." in page
    assert page.count("From: On Pricing") == 2  # each star names its posts once
    assert "QUOTED LINE" not in page and "<svg" not in page


def test_the_pdf_endpoint(client, auth, db_session, monkeypatch):
    printed = {}

    def fake_chrome(page, args, name):
        printed["page"] = page
        return b"%PDF-1.4 fake", None

    monkeypatch.setattr("app.slides.export._run_chrome", fake_chrome)
    ws = db_session.query(Workspace).one()
    a = Artifact(workspace_id=ws.id, type="mind_map", status="ready", content_json=CONTENT)
    db_session.add(a)
    db_session.commit()
    r = client.get(f"/api/artifacts/{a.id}/mind-map.pdf", headers=auth)
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF") and "Three tiers beat two" in printed["page"]
    assert 'filename="Mind Constellation Pricing.pdf"' in r.headers["content-disposition"]

    pending = Artifact(workspace_id=ws.id, type="mind_map", status="generating", content_json={})
    db_session.add(pending)
    db_session.commit()
    assert client.get(f"/api/artifacts/{pending.id}/mind-map.pdf", headers=auth).status_code == 404

import uuid

from app.llm.postprocess import clean_output, strip_em_dashes
from app.pipeline.ingest import html_to_sections, normalize_feed_url
from app.services.email import make_unsubscribe_token, verify_unsubscribe_token
from app.services.storage import keys, safe_filename, workspace_owns_key


def test_strip_em_dashes():
    assert "—" not in strip_em_dashes("Writing is hard — shipping is harder")
    assert strip_em_dashes("a—b") == "a, b"
    assert clean_output({"x": ["one — two"]}) == {"x": ["one, two"]}
    assert strip_em_dashes("2019-2024") == "2019-2024"


def test_normalize_feed_url():
    assert normalize_feed_url("ada.substack.com") == ("https://ada.substack.com/feed", "substack")
    assert normalize_feed_url("https://ada.substack.com/p/some-post")[0] == "https://ada.substack.com/feed"
    assert normalize_feed_url("https://blog.example.com/rss")[1] == "rss"


def test_html_to_sections():
    html = "<h2>Intro</h2><p>" + "word " * 900 + "</p><p>Subscribe now</p><h2>Two</h2><p>Short.</p>"
    sections = html_to_sections(html)
    assert [h for h, _ in sections] == ["Intro", "Two"]
    assert "Subscribe now" not in str(sections)


def test_storage_keys_are_workspace_scoped():
    ws, other = uuid.uuid4(), uuid.uuid4()
    key = keys.upload(ws, uuid.uuid4(), "../../My Logo (final).png")
    assert workspace_owns_key(ws, key)
    assert not workspace_owns_key(other, key)
    assert not workspace_owns_key(ws, f"ws/{ws}/../{other}/x")
    assert safe_filename("../../My Logo (final).png") == "My-Logo-final-.png"


def test_unsubscribe_token_roundtrip(client):
    uid = str(uuid.uuid4())
    assert verify_unsubscribe_token(make_unsubscribe_token(uid)) == uid
    assert verify_unsubscribe_token(uid + ".forged") is None


def test_plans_endpoint(client):
    body = client.get("/api/billing/plans").json()
    assert body["billing_enabled"] is False
    assert [p["id"] for p in body["plans"]] == ["free", "writer", "studio"]
    assert "—" not in str(body)

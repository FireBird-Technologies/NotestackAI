"""Reports and infographics on the Launchpad: a report goes out as its text when it fits in a post, else as a PDF on
LinkedIn; an infographic goes out as one image."""

import pytest

from app.models import Artifact
from app.services import launchpad
from app.services.social import linkedin, media
from tests.test_social_posting import LI_SCOPES, account, auth, item, reply, schedule, ws  # noqa: F401  (fixtures)


def report(db, ws, paragraphs: int) -> Artifact:
    blocks = [{"id": f"b{i}", "type": "prose", "text": f"## Part {i}\n\nCharging more made readers take it seriously [1]. " * 3}
              for i in range(paragraphs)]
    a = Artifact(workspace_id=ws.id, type="report", status="ready",
                 content_json={"title": "Pricing Brief", "blocks": blocks, "citations": [{"marker": 1}]})
    db.add(a)
    db.commit()
    return a


def infographic(db, ws) -> Artifact:
    a = Artifact(workspace_id=ws.id, type="infographic", status="ready",
                 content_json={"title": "Pricing at a glance", "subtitle": "Two years of numbers"})
    db.add(a)
    db.commit()
    return a


def listed(client, auth, a) -> dict:  # noqa: F811
    return {x["id"]: x for x in client.get("/api/launchpad/postable", headers=auth).json()}[str(a.id)]


def test_a_short_report_also_posts_as_a_branded_pdf(client, auth, ws, db_session, monkeypatch):  # noqa: F811
    short = report(db_session, ws, 1)
    got = listed(client, auth, short)
    assert got["media"] == "document" and got["media_count"] == 1  # always a PDF, however short
    text = got["prefill"]["linkedin"]
    assert text.startswith("Pricing Brief") and "[1]" not in text and "**" not in text

    from app.slides import export

    pages: list[str] = []
    monkeypatch.setattr(export, "_run_chrome", lambda html, args, out: (pages.append(html) or b"%PDF-1.7 fake", ""))
    with media.media_for(short, "linkedin") as files:
        assert [f.kind for f in files] == ["document"]
    # Every page: the logo and name on top, "Made with Notestack AI" at the foot (a table head and foot repeat)
    assert '<thead><tr><td><div class="brand"><img src="data:image/svg+xml;base64,' in pages[0]
    assert "Notestack AI</div>" in pages[0] and "<tfoot><tr><td><div class=\"made\">Made with Notestack AI</div>" in pages[0]
    acct = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    assert schedule(client, auth, "linkedin", acct, content=text, artifact_id=str(short.id)).status_code == 200


def test_a_long_report_posts_to_linkedin_as_a_pdf(client, auth, ws, db_session, monkeypatch):  # noqa: F811
    long = report(db_session, ws, 30)
    got = listed(client, auth, long)
    assert got["media"] == "document" and got["media_count"] == 1
    assert len(got["prefill"]["linkedin"]) < 800  # a short caption: the PDF carries the report

    from app.slides import export

    pages: list[str] = []
    monkeypatch.setattr(export, "_run_chrome", lambda html, args, out: (pages.append(html) or b"%PDF-1.7 fake", ""))
    with media.media_for(long, "linkedin") as files:
        assert [(f.kind, f.filename, f.content_type) for f in files] == [("document", "Pricing Brief.pdf", "application/pdf")]
    assert "<h1>Pricing Brief</h1>" in pages[0] and "[1]" not in pages[0]

    li = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    assert schedule(client, auth, "linkedin", li, content="", artifact_id=str(long.id)).status_code == 200
    xa = account(db_session, ws, "x", scopes="tweet.write media.write")
    r = schedule(client, auth, "x", xa, content="Hi", artifact_id=str(long.id))
    assert r.status_code == 400 and "LinkedIn" in r.json()["detail"]

    calls: list[tuple[str, str, dict]] = []

    def call(method, url, **kw):
        calls.append((method, url, kw))
        if url.endswith("/rest/documents"):
            return reply(200, method, url, {"value": {"uploadUrl": "https://up/doc", "document": "urn:li:document:7"}})
        if url.endswith("/rest/posts"):
            return reply(201, method, url, headers={"x-restli-id": "urn:li:share:9"})
        return reply(201, method, url)

    monkeypatch.setattr(linkedin, "_call", call)
    it = item(db_session, ws, li, minutes=0, content="Read the full brief", artifact_id=long.id)
    launchpad.publish_item(db_session, it)
    assert it.status == "posted", it.error
    put = next(c for c in calls if c[1] == "https://up/doc")
    assert put[2]["content"] == b"%PDF-1.7 fake"
    post = next(c for c in calls if c[1].endswith("/rest/posts"))[2]["json"]
    assert post["content"] == {"media": {"id": "urn:li:document:7", "title": "Pricing Brief"}}


def test_an_infographic_posts_as_one_image(client, auth, ws, db_session, monkeypatch):  # noqa: F811
    art = infographic(db_session, ws)
    got = listed(client, auth, art)
    assert got["media"] == "image" and got["media_count"] == 1
    assert got["prefill"]["linkedin"] == "Pricing at a glance\n\nTwo years of numbers"
    monkeypatch.setattr("app.pipeline.infographic.infographic_html", lambda c, layout="portrait": f"<p>{layout}</p>")
    monkeypatch.setattr("app.infographics.image.render_png", lambda html, layout="portrait": b"\x89PNG" + layout.encode())
    with media.media_for(art, "linkedin") as files:
        assert [(f.kind, f.filename) for f in files] == [("image", "infographic.png")]
        assert files[0].data == b"\x89PNGlandscape"  # the wide version, when there is one


@pytest.mark.parametrize("status", ["generating", "failed"])
def test_unfinished_reports_and_infographics_cannot_be_scheduled(client, auth, ws, db_session, status):  # noqa: F811
    a = report(db_session, ws, 1)
    b = infographic(db_session, ws)
    a.status = b.status = status
    db_session.commit()
    li = account(db_session, ws, "linkedin", scopes=LI_SCOPES)
    for art in (a, b):
        assert schedule(client, auth, "linkedin", li, content="Hi", artifact_id=str(art.id)).status_code == 400


def test_one_item_can_be_looked_up_to_attach(client, auth, ws, db_session):  # noqa: F811
    from app.models import Workspace

    mine = report(db_session, ws, 1)
    got = client.get(f"/api/launchpad/postable/{mine.id}", headers=auth)
    assert got.status_code == 200 and got.json()["id"] == str(mine.id) and got.json()["type"] == "report"
    other = Workspace(name="Other", owner_id=ws.owner_id)
    db_session.add(other)
    db_session.commit()
    theirs = report(db_session, other, 1)
    assert client.get(f"/api/launchpad/postable/{theirs.id}", headers=auth).status_code == 404
    mine.status = "generating"
    db_session.commit()
    assert client.get(f"/api/launchpad/postable/{mine.id}", headers=auth).status_code == 404

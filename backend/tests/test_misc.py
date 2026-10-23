import uuid

from app.config import settings
from app.llm.postprocess import clean_output, strip_em_dashes
from app.pipeline.ingest import html_to_sections, normalize_feed_url
from app.services.email import ConsoleEmailProvider, email_service, make_unsubscribe_token, verify_unsubscribe_token
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


def test_update_email_replies_go_to_team(client):
    uid = str(uuid.uuid4())
    assert email_service.send_blast_email(uid, "reader@example.com", "Ada", "News", "We shipped it.")
    headers = ConsoleEmailProvider.sent[-1].headers
    assert headers is not None
    assert headers["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"
    assert ConsoleEmailProvider.sent[-1].reply_to == settings.alerts_email


def test_plans_endpoint(client):
    body = client.get("/api/billing/plans").json()
    assert body["billing_enabled"] is False
    assert [p["id"] for p in body["plans"]] == ["free", "writer", "studio"]
    assert "—" not in str(body)


def test_update_email_failures_get_one_retry(session_factory, monkeypatch):
    from datetime import UTC, datetime, timedelta

    from app import worker
    from app.models import UpdateEmail, UpdateEmailSend, User

    monkeypatch.setattr(worker, "UPDATE_EMAIL_PACE", 0)
    with session_factory() as db:
        users = [User(email=f"u{i}@example.com", auth_provider="email") for i in range(3)]
        db.add_all(users)
        campaign = UpdateEmail(subject="News", body="We shipped it.", send_hour=datetime.now(UTC).hour, batch_size=10)
        db.add(campaign)
        db.commit()
        campaign_id = campaign.id

    down = {"u1@example.com"}  # this one fails on its first try, then goes through

    def send(uid, to, *rest):
        if to in down:
            down.remove(to)
            return False
        return True

    monkeypatch.setattr(worker.email_service, "send_blast_email", send)
    worker.update_email_batch(session_factory)
    with session_factory() as db:
        campaign = db.get(UpdateEmail, campaign_id)
        assert (campaign.sent_count, campaign.failed_count, campaign.status) == (2, 1, "completed")
        campaign.last_batch_at = datetime.now(UTC) - timedelta(days=1)
        db.commit()

    worker.update_email_batch(session_factory)  # the completed campaign reopens for its one failure
    with session_factory() as db:
        campaign = db.get(UpdateEmail, campaign_id)
        assert (campaign.sent_count, campaign.failed_count, campaign.status) == (3, 0, "completed")
        assert {s.status for s in db.query(UpdateEmailSend)} == {"sent"}


def test_resend_rate_limit_waits_and_retries(monkeypatch):
    import resend

    from app.services import email as email_module

    calls = []

    def send(params):
        calls.append(params)
        if len(calls) < 3:
            raise resend.exceptions.RateLimitError(message="slow down", error_type="rate_limit_exceeded", code=429)
        return {"id": "em_1"}

    monkeypatch.setattr(email_module.time, "sleep", lambda s: None)
    provider = email_module.ResendEmailProvider("re_test")
    monkeypatch.setattr(provider._resend.Emails, "send", send)
    assert provider.send(email_module.OutgoingEmail(to="a@example.com", subject="s", html="", text="t")) == "em_1"
    assert len(calls) == 3


def test_a_server_error_emails_a_plain_text_alert(monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app
    from app.services import error_alerts

    # sent at once (not on a thread), so the test can see it
    monkeypatch.setattr(error_alerts, "_send_later", error_alerts.email_service.send_error_alert)
    monkeypatch.setattr(error_alerts, "_last_sent", {})
    monkeypatch.setattr(error_alerts, "_held_back", {})

    def broken():
        raise KeyError("missing_thing")

    app.add_api_route("/api/_test/broken", broken)
    client = TestClient(app, raise_server_exceptions=False)
    before = len(ConsoleEmailProvider.sent)
    assert client.get("/api/_test/broken?token=secret").status_code == 500
    assert client.get("/api/_test/broken").status_code == 500  # the same error again: held back

    sent = ConsoleEmailProvider.sent[before:]
    assert len(sent) == 1
    alert = sent[0]
    assert alert.to == settings.alerts_email and alert.html == ""
    assert alert.subject == "Failure on Notestack backend: KeyError in GET /api/_test/broken"
    assert "GET /api/_test/broken crashed with KeyError: 'missing_thing', at tests/test_misc.py:" in alert.text
    assert "Where: tests/test_misc.py:" in alert.text and " in broken" in alert.text
    assert "Traceback" in alert.text and "Query keys: token" in alert.text
    assert "secret" not in alert.text

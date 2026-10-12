"""Source links: some are refused, some allowed with a warning (the same rules as blog2video)."""

import httpx
import pytest

from app.models import Job
from app.services.url_policy import (
    BLOCKED_MESSAGE,
    GOOGLE_DRIVE_WARNING,
    MAYBE_UNSCRAPABLE_WARNING,
    PAYWALL_WARNING,
    PUBLIC_SHARE_WARNING,
    SOCIAL_BLOCKED_MESSAGE,
    classify_url,
)
from tests.conftest import last_code


@pytest.mark.parametrize("url, kind, message", [
    ("x.com", "blocked", SOCIAL_BLOCKED_MESSAGE),
    ("https://www.linkedin.com/feed/", "blocked", SOCIAL_BLOCKED_MESSAGE),
    ("instagram.com/explore", "blocked", SOCIAL_BLOCKED_MESSAGE),
    ("https://x.com/u/status/1", "ok", None),
    ("https://www.linkedin.com/posts/ada_pricing-123", "ok", None),
    ("pornhub.com", "blocked", BLOCKED_MESSAGE),
    ("https://www.nytimes.com/2025/01/01/business/pricing.html", "warn", PAYWALL_WARNING),
    ("notnytimes.com/a", "ok", None),
    ("https://chatgpt.com/share/abc", "warn", PUBLIC_SHARE_WARNING),
    ("https://chatgpt.com/", "ok", None),
    ("https://docs.google.com/document/d/abc/edit", "warn", PUBLIC_SHARE_WARNING),
    ("https://drive.google.com/file/d/abc/view", "warn", GOOGLE_DRIVE_WARNING),
    ("https://youtu.be/abc", "warn", MAYBE_UNSCRAPABLE_WARNING),
    ("https://ada.substack.com/p/on-pricing", "ok", None),
    ("", "ok", None),
])
def test_classify_url(url, kind, message):
    got = classify_url(url)
    assert (got.kind, got.message) == (kind, message)


@pytest.fixture()
def auth(client):
    client.post("/api/auth/email/register/start", json={"email": "ada@example.com", "password": "stardust-42"})
    r = client.post("/api/auth/email/register/verify", json={"email": "ada@example.com", "code": last_code()})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def no_fetch(*args, **kwargs):
    raise AssertionError("a blocked link must not be fetched")


@pytest.mark.parametrize("path", ["/api/sources", "/api/sources/url"])
def test_blocked_links_are_refused_before_anything_runs(client, auth, db_session, monkeypatch, path):
    monkeypatch.setattr(httpx, "get", no_fetch)
    r = client.post(path, json={"url": "https://x.com/"}, headers=auth)
    assert r.status_code == 422
    assert r.json()["detail"] == {"code": "source_blocked", "message": SOCIAL_BLOCKED_MESSAGE}
    assert db_session.query(Job).count() == 0


def test_warned_links_are_accepted(client, auth, db_session):
    r = client.post("/api/sources/url", json={"url": "https://www.nytimes.com/2025/01/01/pricing.html"}, headers=auth)
    assert r.status_code == 200, r.text
    assert db_session.query(Job).one().kind == "import_url"

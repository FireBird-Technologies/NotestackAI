import httpx
import pytest

from app.pipeline import ingest
from app.services import safe_http
from app.services.safe_http import UnsafeURL, check_url, safe_get


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/",
    "http://localhost/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.9/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://0.0.0.0/",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com/",
    "https://user:pw@example.com/",
    "http://example.com:5432/",
    "http:///nohost",
])
def test_refuses_internal_and_odd_addresses(url):
    with pytest.raises(UnsafeURL):
        check_url(url)


def test_allows_public_web_addresses():
    check_url("https://ada.example.com/feed")
    check_url("http://ada.example.com:80/feed")
    check_url("https://8.8.8.8/")


def test_a_name_resolving_to_any_private_address_is_refused(monkeypatch):
    monkeypatch.setattr(safe_http, "_resolve", lambda host, port: ["93.184.216.34", "10.0.0.7"])
    with pytest.raises(UnsafeURL):
        check_url("https://sneaky.example.com/")


def test_unresolvable_names_are_refused(monkeypatch):
    def fail(host, port):
        raise UnsafeURL("nope")

    monkeypatch.setattr(safe_http, "_resolve", fail)
    with pytest.raises(UnsafeURL):
        check_url("https://does-not-exist.example.com/")


def _redirecting(hops):
    seen = []

    def get(url, **kwargs):
        seen.append((url, kwargs.get("follow_redirects")))
        status, location = hops.pop(0)
        headers = {"location": location} if location else {}
        return httpx.Response(status, headers=headers, request=httpx.Request("GET", url), content=b"ok")

    return get, seen


def test_follows_a_public_redirect_by_hand(monkeypatch):
    get, seen = _redirecting([(301, "https://www.example.com/feed"), (200, None)])
    monkeypatch.setattr(httpx, "get", get)
    resp = safe_get("https://example.com/feed")
    assert resp.status_code == 200
    assert [u for u, _ in seen] == ["https://example.com/feed", "https://www.example.com/feed"]
    assert all(follow is False for _, follow in seen)


def test_a_redirect_into_the_private_network_is_refused(monkeypatch):
    get, seen = _redirecting([(302, "http://169.254.169.254/latest/meta-data/"), (200, None)])
    monkeypatch.setattr(httpx, "get", get)
    with pytest.raises(UnsafeURL):
        safe_get("https://example.com/feed")
    assert len(seen) == 1  # the metadata address was never requested


def test_relative_redirects_resolve_against_the_current_page(monkeypatch):
    get, seen = _redirecting([(302, "/moved"), (200, None)])
    monkeypatch.setattr(httpx, "get", get)
    safe_get("https://example.com/feed")
    assert seen[1][0] == "https://example.com/moved"


def test_redirect_loops_stop(monkeypatch):
    monkeypatch.setattr(httpx, "get", _redirecting([(302, "https://example.com/again")] * 20)[0])
    with pytest.raises(UnsafeURL):
        safe_get("https://example.com/again")


def test_unsafe_url_is_an_httpx_error():
    assert issubclass(UnsafeURL, httpx.HTTPError)


def test_importing_an_internal_page_is_refused_not_fetched(monkeypatch):
    monkeypatch.setattr(httpx, "get", lambda *a, **k: pytest.fail("must not fetch"))
    with pytest.raises(ingest.FeedNotFound):
        ingest.extract_article("http://169.254.169.254/latest/meta-data/")


def test_an_internal_feed_is_not_treated_as_a_feed():
    assert ingest._parse_feed("http://10.0.0.5/feed") == (None, None)

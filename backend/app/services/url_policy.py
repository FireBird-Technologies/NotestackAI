"""Which source links can be added: some are refused, some are allowed with a warning.

A copy of blog2video's classifier (blog2video/frontend/src/utils/urlScrapability.ts). NoteStack's frontend has the same
rules in frontend/src/lib/urlScrapability.ts: keep the three in step. The API refuses a blocked link; warned ones are
accepted (the frontend asks the writer first).
"""

from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit

# Always refused, whatever the path. Empty for now: the list is here so sites can be added.
HARD_BLOCKED_DOMAINS: list[str] = []

# Paywalled sites: allowed, but the scrape often returns a paywall stub.
PAYWALL_DOMAINS = ["nytimes.com"]

# Social sites: the home page and feeds are refused, a specific post is allowed.
SOCIAL_DOMAINS = ["x.com", "twitter.com", "linkedin.com", "instagram.com", "facebook.com", "fb.com"]
SOCIAL_LANDING_PATHS = ["/feed", "/home", "/login", "/explore"]

# AI chat shares and Google Docs: allowed, but only public ones can be read.
CHAT_SHARE_RULES: list[tuple[str, list[str]]] = [
    ("chatgpt.com", ["/share/", "/c/"]),
    ("chat.openai.com", ["/share/", "/c/"]),
    ("claude.ai", ["/share/", "/chat/"]),
    ("chat.deepseek.com", ["/share/", "/s/", "/a/"]),
    ("gemini.google.com", ["/share/", "/app/"]),
    ("grok.com", ["/share/", "/chat/"]),
    ("x.ai", ["/share/"]),
    ("perplexity.ai", ["/search/", "/page/"]),
    ("chat.mistral.ai", ["/chat/", "/share/"]),
    ("poe.com", ["/s/", "/share/"]),
    ("copilot.microsoft.com", ["/share/"]),
    ("docs.google.com", ["/document/", "/spreadsheets/", "/presentation/"]),
]

# Google Drive links can point at any kind of file, so the warning also asks for a text-readable one.
GOOGLE_DRIVE_RULE = ("drive.google.com", ["/file/d/", "/drive/", "/open", "/uc"])

# Adult sites: any of these anywhere in the hostname.
ADULT_KEYWORDS = ["porn", "xxx", "xvideos", "xnxx", "onlyfans", "redtube", "xhamster", "adult", "nsfw", "sex"]

# Might not be readable: allowed with a warning.
WARN_DOMAINS = ["youtube.com", "youtu.be", "m.youtube.com", "tiktok.com"]

BLOCKED_MESSAGE = "This site can't be added as a source."
SOCIAL_BLOCKED_MESSAGE = "Social media home pages and feeds can't be added. Paste a link to a specific post instead."
PUBLIC_SHARE_WARNING = "Make sure this chat/document is public. Private links can't be scraped."
GOOGLE_DRIVE_WARNING = "Ensure this document is public and is text-readable. Private or non-text files can't be scraped."
PAYWALL_WARNING = "Paywalled articles may not scrape fully. Use a free/gift link if you have one."
MAYBE_UNSCRAPABLE_WARNING = "This link might not be scrapable. Try a different one if you have it."


@dataclass(frozen=True)
class UrlClassification:
    kind: Literal["ok", "blocked", "warn"]
    message: str | None = None


OK = UrlClassification("ok")


def _matches(host: str, domain: str) -> bool:
    """The domain itself or a subdomain of it ("notnytimes.com" is not "nytimes.com")."""
    return host == domain or host.endswith(f".{domain}")


def classify_url(s: str) -> UrlClassification:
    raw = (s or "").strip().lower()
    if not raw:
        return OK
    try:
        parts = urlsplit(raw if raw.startswith("http") else f"https://{raw}")
        host = (parts.hostname or "").removeprefix("www.")
    except ValueError:
        return OK
    if not host:
        return OK
    path = parts.path or "/"

    if any(_matches(host, d) for d in HARD_BLOCKED_DOMAINS) or any(kw in host for kw in ADULT_KEYWORDS):
        return UrlClassification("blocked", BLOCKED_MESSAGE)
    if any(_matches(host, d) for d in SOCIAL_DOMAINS):
        main = path.rstrip("/")
        return UrlClassification("blocked", SOCIAL_BLOCKED_MESSAGE) if main == "" or main in SOCIAL_LANDING_PATHS else OK
    domain, prefixes = GOOGLE_DRIVE_RULE
    if _matches(host, domain) and any(path.startswith(p) for p in prefixes):
        return UrlClassification("warn", GOOGLE_DRIVE_WARNING)
    rule = next((r for r in CHAT_SHARE_RULES if _matches(host, r[0])), None)
    if rule and any(path.startswith(p) for p in rule[1]):
        return UrlClassification("warn", PUBLIC_SHARE_WARNING)
    if any(_matches(host, d) for d in PAYWALL_DOMAINS):
        return UrlClassification("warn", PAYWALL_WARNING)
    if any(_matches(host, d) for d in WARN_DOMAINS):
        return UrlClassification("warn", MAYBE_UNSCRAPABLE_WARNING)
    return OK

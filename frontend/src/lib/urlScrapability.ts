// Which source links can be added: some are refused, some allowed with a warning. A copy of blog2video's
// frontend/src/utils/urlScrapability.ts; the server has the same rules in backend/app/services/url_policy.py (it refuses
// blocked links too). Keep the three in step.

// Always refused, whatever the path. Empty for now: the list is here so sites can be added.
const HARD_BLOCKED_DOMAINS: string[] = [];

// Paywalled sites: allowed, but the scrape often returns a paywall stub.
const PAYWALL_DOMAINS = ["nytimes.com"];

// Social sites: the home page and feeds are refused, a specific post is allowed.
const SOCIAL_DOMAINS = ["x.com", "twitter.com", "linkedin.com", "instagram.com", "facebook.com", "fb.com"];
const SOCIAL_LANDING_PATHS = ["/feed", "/home", "/login", "/explore"];

// AI chat shares and Google Docs: allowed, but only public ones can be read.
const CHAT_SHARE_RULES: { domain: string; pathPrefixes: string[] }[] = [
  { domain: "chatgpt.com", pathPrefixes: ["/share/", "/c/"] },
  { domain: "chat.openai.com", pathPrefixes: ["/share/", "/c/"] },
  { domain: "claude.ai", pathPrefixes: ["/share/", "/chat/"] },
  { domain: "chat.deepseek.com", pathPrefixes: ["/share/", "/s/", "/a/"] },
  { domain: "gemini.google.com", pathPrefixes: ["/share/", "/app/"] },
  { domain: "grok.com", pathPrefixes: ["/share/", "/chat/"] },
  { domain: "x.ai", pathPrefixes: ["/share/"] },
  { domain: "perplexity.ai", pathPrefixes: ["/search/", "/page/"] },
  { domain: "chat.mistral.ai", pathPrefixes: ["/chat/", "/share/"] },
  { domain: "poe.com", pathPrefixes: ["/s/", "/share/"] },
  { domain: "copilot.microsoft.com", pathPrefixes: ["/share/"] },
  { domain: "docs.google.com", pathPrefixes: ["/document/", "/spreadsheets/", "/presentation/"] },
];

// Google Drive links can point at any kind of file, so the warning also asks for a text-readable one.
const GOOGLE_DRIVE_RULE = { domain: "drive.google.com", pathPrefixes: ["/file/d/", "/drive/", "/open", "/uc"] };

// Adult sites: any of these anywhere in the hostname.
const ADULT_KEYWORDS = ["porn", "xxx", "xvideos", "xnxx", "onlyfans", "redtube", "xhamster", "adult", "nsfw", "sex"];

// Might not be readable: allowed with a warning.
const WARN_DOMAINS = ["youtube.com", "youtu.be", "m.youtube.com", "tiktok.com"];

export const BLOCKED_MESSAGE = "This site can't be added as a source.";
export const SOCIAL_BLOCKED_MESSAGE = "Social media home pages and feeds can't be added. Paste a link to a specific post instead.";
const PUBLIC_SHARE_WARNING = "Make sure this chat/document is public. Private links can't be scraped.";
const GOOGLE_DRIVE_WARNING = "Ensure this document is public and is text-readable. Private or non-text files can't be scraped.";
const PAYWALL_WARNING = "Paywalled articles may not scrape fully. Use a free/gift link if you have one.";
const MAYBE_UNSCRAPABLE_WARNING = "This link might not be scrapable. Try a different one if you have it.";

export type UrlClassification = { kind: "ok" } | { kind: "blocked" | "warn"; message: string };

/** Parse a link that may have no scheme. Null when it can't be parsed. */
function parseUrl(s: string): URL | null {
  const trimmed = s.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    return new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

/** The domain itself or a subdomain of it ("notnytimes.com" is not "nytimes.com"). */
const matches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Blocked (refused), warn (allowed once the writer confirms) or ok. */
export function classifyUrl(s: string): UrlClassification {
  const url = parseUrl(s);
  if (!url) return { kind: "ok" };
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname;

  if (HARD_BLOCKED_DOMAINS.some((d) => matches(host, d)) || ADULT_KEYWORDS.some((kw) => host.includes(kw))) {
    return { kind: "blocked", message: BLOCKED_MESSAGE };
  }
  if (SOCIAL_DOMAINS.some((d) => matches(host, d))) {
    const main = path.replace(/\/+$/, "");
    return main === "" || SOCIAL_LANDING_PATHS.includes(main) ? { kind: "blocked", message: SOCIAL_BLOCKED_MESSAGE } : { kind: "ok" };
  }
  if (matches(host, GOOGLE_DRIVE_RULE.domain) && GOOGLE_DRIVE_RULE.pathPrefixes.some((p) => path.startsWith(p))) {
    return { kind: "warn", message: GOOGLE_DRIVE_WARNING };
  }
  const chat = CHAT_SHARE_RULES.find((r) => matches(host, r.domain));
  if (chat && chat.pathPrefixes.some((p) => path.startsWith(p))) return { kind: "warn", message: PUBLIC_SHARE_WARNING };
  if (PAYWALL_DOMAINS.some((d) => matches(host, d))) return { kind: "warn", message: PAYWALL_WARNING };
  if (WARN_DOMAINS.some((d) => matches(host, d))) return { kind: "warn", message: MAYBE_UNSCRAPABLE_WARNING };
  return { kind: "ok" };
}

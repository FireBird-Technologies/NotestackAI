import { PLATFORMS } from "./schedule";
import type { Platform, PostableArtifact, SocialAccount, SocialAccounts } from "./types";

// The post composer's rules and text edits, shared by the web ScheduleModal and the mobile Composer so both behave
// the same: which platforms take media or threads, what blocks posting, and the toolbar's edits.

/** These platforms accept the Library's images and videos. */
export const MEDIA_PLATFORMS: Platform[] = ["x", "facebook", "instagram", "threads", "linkedin"];
export const THREADED: Platform[] = ["x", "threads", "bluesky"];
/** These post only through a live connection: no email fallback. */
export const CONNECTED_ONLY: Platform[] = ["x", "facebook", "instagram", "threads", "linkedin"];
/** These platforms connect directly. */
export const COMPOSER_PLATFORMS: Platform[] = ["x", "facebook", "instagram", "threads", "linkedin"];
export const COMPOSER_EMOJIS = ["😀", "😊", "😍", "🤩", "😂", "👏", "👍", "🙌", "🔥", "✨", "💡", "🚀", "🎯", "✅", "👀", "💙"];

export type ConnectProvider = "x" | "facebook" | "instagram" | "threads" | "linkedin";
export type AiAction = "generate" | "rephrase" | "shorten" | "expand" | "casual" | "formal";
export const AI_REWORK: { id: Exclude<AiAction, "generate">; label: string }[] = [
  { id: "rephrase", label: "Rephrase" },
  { id: "shorten", label: "Shorten" },
  { id: "expand", label: "Expand" },
  { id: "casual", label: "More casual" },
  { id: "formal", label: "More formal" },
];

/** Platforms still in app review show only to accounts the backend lists as able to see them. */
export const isReviewPlatform = (platform: Platform): platform is "x" | "facebook" | "instagram" | "threads" =>
  platform === "x" || platform === "facebook" || platform === "instagram" || platform === "threads";

export const connectionFor = (p: Platform): ConnectProvider | null =>
  p === "x" || p === "facebook" || p === "instagram" || p === "threads" || p === "linkedin" ? p : null;

export const platformMeta = (p: Platform) => PLATFORMS.find((x) => x.id === p)!;

/** The composer's channel choices, review platforms included only when visible to this account. */
export const composerChannels = (accounts: SocialAccounts | null) =>
  PLATFORMS.filter((p) => COMPOSER_PLATFORMS.includes(p.id) && (!isReviewPlatform(p.id) || !!accounts?.visible[p.id]));

/** The attachment's starting text for a platform: a thread for X/Threads, one post otherwise. */
export const prefillFor = (p: Platform, a: PostableArtifact): string[] =>
  THREADED.includes(p) ? [...a.prefill.x] : [a.prefill.linkedin];

/** The live account a post on this platform goes out through, if any. */
export const activeAccount = (accounts: SocialAccounts | null, p: Platform): SocialAccount | null =>
  accounts?.accounts.find((a) => a.platform === p && a.status === "active") ?? null;

/** Why this destination can't be scheduled yet (connection, Instagram media, or public hosting); null when it can. */
export function blockerFor(
  p: Platform,
  accounts: SocialAccounts | null,
  ready: boolean,
  attached: PostableArtifact | null,
): string | null {
  if (!CONNECTED_ONLY.includes(p) || !ready) return null;
  const label = platformMeta(p).label;
  const carriesMedia = !!attached && attached.media !== "text";
  const any = accounts?.accounts.find((a) => a.platform === p);
  const live = activeAccount(accounts, p);
  if (!live) return any ? `Your ${label} connection is down. Reconnect ${label}.` : `Connect ${label} to post there.`;
  if (p === "instagram" && !carriesMedia) return "Instagram needs an image or video. Attach one first.";
  if (carriesMedia && !live.can_post_media) return p === "instagram" || p === "threads"
    ? `Public media hosting isn't configured for ${label} yet.`
    : `Reconnect ${label} to post images and videos.`;
  return null;
}

export type Texts = Partial<Record<Platform, string[]>>;

/** Edit one post and keep every other selected destination's copy identical (a thread where the platform threads). */
export function crossPostTexts(cur: Texts, selected: Platform[], p: Platform, i: number, value: string): Texts {
  const source = (cur[p] ?? [""]).map((text, index) => (index === i ? value : text));
  const combined = source.join("\n\n");
  const next: Texts = { ...cur, [p]: source };
  for (const destination of selected) {
    if (destination === p) continue;
    next[destination] = THREADED.includes(destination) && THREADED.includes(p) ? [...source] : [combined];
  }
  return next;
}

/** A newly selected destination begins with the copy already on screen, so cross-post text stays identical. */
export function seedFor(p: Platform, selected: Platform[], texts: Texts): string[] {
  const from = selected.map((s) => texts[s] ?? []).find((t) => t.some((x) => x.trim())) ?? [""];
  return THREADED.includes(p) ? [...from] : [from.join("\n\n")];
}

/** Attaching: every selected destination still empty takes the written copy, or the attachment's suggested text. */
export function textsWithAttachment(cur: Texts, selected: Platform[], fallback: Platform, a: PostableArtifact): Texts {
  const next = { ...cur };
  const seed = selected.map((p) => next[p] ?? []).find((parts) => parts.some((text) => text.trim()))
    ?? prefillFor(selected[0] ?? fallback, a);
  for (const p of selected) {
    if (!next[p]?.some((text) => text.trim())) next[p] = THREADED.includes(p) ? [...seed] : [seed.join("\n\n")];
  }
  return next;
}

/** What goes out to one platform: a thread where it threads, else one post. */
export function postsFor(p: Platform, texts: Texts): string[] {
  const clean = (texts[p] ?? []).map((t) => t.trim()).filter(Boolean);
  return THREADED.includes(p) ? clean : [clean.join("\n\n")];
}

const BULLET = /^(\s*)(?:[•◦▪‣]|[-*])\s+/;

/** Toggle Unicode bullets on every selected line (or the current line when nothing is selected). */
export function bulletEdit(value: string, start: number, end: number) {
  const from = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const endFrom = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nextBreak = value.indexOf("\n", endFrom);
  const to = nextBreak < 0 ? value.length : nextBreak;
  const lines = value.slice(from, to).split("\n");
  const words = lines.filter((line) => line.trim());
  const remove = words.length > 0 && words.every((line) => BULLET.test(line));
  const changed = lines.map((line) => {
    if (!line.trim()) return line;
    if (remove) return line.replace(BULLET, "$1");
    if (BULLET.test(line)) return line.replace(BULLET, "$1• ");
    return line.replace(/^(\s*)/, "$1• ");
  }).join("\n");
  return { value: value.slice(0, from) + changed + value.slice(to), from, to: from + changed.length };
}

/** Put text in place of the selection; the cursor lands after it. */
export function insertAt(value: string, start: number, end: number, insertion: string) {
  return { value: value.slice(0, start) + insertion + value.slice(end), cursor: start + insertion.length };
}

/** The selected words as one #hashtag, or a bare "#" to type after. */
export function hashtagEdit(value: string, start: number, end: number) {
  const selected = value.slice(start, end).trim();
  return insertAt(value, start, end, selected ? `#${selected.replace(/\s+/g, "")}` : "#");
}

/** An http(s) address from what was typed ("example.com" becomes "https://example.com/"); null when it isn't one. */
export function normalLink(raw: string): string | null {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Social captions cannot hide a URL behind anchor text, so selected words become "words: https://...". */
export function linkEdit(value: string, start: number, end: number, url: string) {
  const selected = value.slice(start, end).trim();
  const insertion = selected && selected !== url ? `${selected}: ${url}` : url;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leading = before && !/\s$/.test(before) ? " " : "";
  const trailing = after && !/^\s/.test(after) ? " " : "";
  const cursor = before.length + leading.length + insertion.length;
  return { value: before + leading + insertion + trailing + after, cursor };
}

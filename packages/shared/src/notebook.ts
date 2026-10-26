import type { ChatSummary, VideoOptions } from "./types";

/** The questions offered in an empty notebook chat. */
export const STARTERS = ["What are the strongest ideas across these posts?", "Where do I contradict myself?", "Which post is most worth updating, and why?"];

/** Chats under date headings: Today, Yesterday, the last week, the last month, then by month. Newest first. */
export function groupChats(chats: ChatSummary[]): { label: string; items: ChatSummary[] }[] {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(new Date());
  const groups: { label: string; items: ChatSummary[] }[] = [];
  const stamp = (c: ChatSummary) => (c.updated_at ? new Date(c.updated_at) : new Date()); // a chat with no time yet is brand new
  [...chats].sort((a, b) => +stamp(b) - +stamp(a)).forEach((c) => {
    const when = stamp(c);
    const days = Math.round((today - startOfDay(when)) / 86400000);
    const label = days <= 0 ? "Today" : days === 1 ? "Yesterday" : days <= 7 ? "Previous 7 days" : days <= 30 ? "Previous 30 days"
      : when.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(c);
    else groups.push({ label, items: [c] });
  });
  return groups;
}

/** A video template's colours when it names none. */
export const FALLBACK_COLORS = { accent_color: "#7c3aed", bg_color: "#ffffff", text_color: "#000000" };

/** The video wizard's starting settings: a landscape video in the default template, read by a female American voice. */
export const VIDEO_DEFAULTS: VideoOptions = {
  stock_footage_enabled: true,
  aspect_ratio: "landscape",
  video_length: "medium", // no length picker: the server sets it from a house style
  logo_position: "bottom_right",
  logo_opacity: 0.9,
  template: "default",
  video_style: "auto",
  ...FALLBACK_COLORS,
  content_language: null,
  voice_gender: "female",
  voice_accent: "american",
  bgm_volume: 0.1,
};

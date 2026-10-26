import type { QuizQuestionType } from "./types";

/** The option lists of the create dialogs (web and app show the same ones). */

/** Most chats one generated thing reads (the video wizard's cap too). */
export const MAX_CHATS = 5;

export const LANGUAGES = ["English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Polish", "Hindi",
  "Arabic", "Japanese", "Korean", "Chinese", "Turkish", "Russian", "Indonesian"];

/** "4 posts", "1 chat" or "4 posts + 1 chat": what a quiz, a card set or a report was made from. */
export function sourceSummary(source: { document_ids?: string[]; chat_ids?: string[]; count?: number } | undefined): string {
  const posts = source?.document_ids?.length ?? 0;
  const chats = source?.chat_ids?.length ?? 0;
  const parts = [posts ? `${posts} post${posts === 1 ? "" : "s"}` : "", chats ? `${chats} chat${chats === 1 ? "" : "s"}` : ""];
  return parts.filter(Boolean).join(" + ") || `${source?.count ?? 0} posts`;
}

export const QUIZ_LEVELS = [
  { id: "easy", label: "Easy" },
  { id: "medium", label: "Medium" },
  { id: "hard", label: "Hard" },
] as const;
export const QUIZ_TYPES: { id: QuizQuestionType; label: string }[] = [
  { id: "multiple_choice", label: "MCQs" },
  { id: "fill_blank", label: "Fill in the Blank" },
  { id: "short_answer", label: "Short Answer" },
];

export const CARD_LEVELS = [
  { id: "easy", label: "Easy" },
  { id: "medium", label: "Medium (Default)" },
  { id: "hard", label: "Hard" },
] as const;

export const AUDIO_STYLES = [
  { id: "deep_dive", name: "Deep Dive", blurb: "A lively conversation that unpacks the ideas in your sources and connects them." },
  { id: "brief", name: "Brief", blurb: "A bite sized overview to help you grasp the core ideas from your sources quickly." },
  { id: "critique", name: "Critique", blurb: "An expert review of your sources, with constructive feedback to help you improve your material." },
  { id: "debate", name: "Debate", blurb: "A thoughtful debate between two hosts, bringing out different perspectives on your sources." },
] as const;
export const AUDIO_LENGTHS = [
  { value: "3", label: "Short", range: "about 3 min" },
  { value: "6", label: "Default", range: "about 6 min" },
  { value: "12", label: "Long", range: "about 12 min" },
];

/** The two deck themes. Their slides are laid out on the server (backend/app/slides); the thumbnails are rendered from
 * them (backend/scripts/render_slide_thumbnails.py). */
export const SLIDE_THEMES = [
  { id: "dark-space", name: "Night stellar", blurb: "Night sky, planets and a blue glow" },
  { id: "light-space", name: "Moon light", blurb: "Moonlit sky, orbits and constellations" },
] as const;
export const DECK_FORMATS = [
  { id: "detailed", label: "Detailed deck", blurb: "Full text and details, perfect for emailing or reading on its own." },
  { id: "presenter", label: "Presenter slides", blurb: "Clean slides with key talking points to support you while you speak." },
] as const;
export const DECK_LENGTHS = [
  { id: "short", label: "Short", range: "6 to 8 slides" },
  { id: "default", label: "Default", range: "9 to 11 slides" },
  { id: "long", label: "Long", range: "12 to 16 slides" },
] as const;

export const INFOGRAPHIC_THEMES = [
  { id: "midnight", name: "Midnight", blurb: "Black and blue, white type" },
  { id: "paper", name: "Orbit", blurb: "White, black type, blue orbits and stars" },
] as const;
/** The kind of layout to lean towards; "auto" lets the AI choose from the content. */
export const INFOGRAPHIC_STYLES = [
  { id: "auto", name: "Auto", blurb: "Let the AI choose" },
  { id: "flowchart", name: "Flow chart", blurb: "Steps joined by arrows" },
  { id: "timeline", name: "Timeline", blurb: "What happens, in order" },
  { id: "compare", name: "Comparison", blurb: "Two sides side by side" },
  { id: "hierarchy", name: "Hierarchy", blurb: "A whole and its parts" },
  { id: "overview", name: "Overview", blurb: "Key ideas and numbers" },
] as const;

/** A report template's prompt with what it is about filled in. */
export const fillReportPrompt = (prompt: string, about: string) => prompt.replaceAll("{about}", about || "the selected sources");

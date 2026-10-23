// Landing page copy and plan details shared by the web landing page and the mobile app's public pages.
// No em dashes (npm run check:copy).

/** "What you get": one card per feature. The web pairs each with an icon by its label. */
export const FEATURES = [
  {
    label: "Research chat",
    title: "Ask your archive anything",
    body: "Every answer cites the exact passage it came from. If you never wrote it, Notestack says so.",
  },
  {
    label: "Mind Constellation",
    title: "Fly through your ideas",
    body: "Open a notebook as a galaxy of topics. Switch the shape, dive in and see the posts behind every star.",
  },
  {
    label: "Audio overview",
    title: "Two hosts, your ideas",
    body: "Turn a post or a whole notebook into a natural two host conversation, voiced by ElevenLabs.",
  },
  {
    label: "Video",
    title: "Narrated videos you can edit",
    body: "Pick a post and a template, then edit every scene with a live preview. Landscape for YouTube, vertical for Reels.",
  },
  {
    label: "Launch Kit",
    title: "One post, every platform",
    body: "Threads, LinkedIn, Substack Notes, hooks, quote cards and an SEO pack in one click.",
  },
  {
    label: "Voices",
    title: "Sounds like you",
    body: "Notestack learns your tone from your posts, and you can describe, pick or clone a voice for narration.",
  },
  {
    label: "Memory",
    title: "Remembers who you write for",
    body: "Short notes about your audience and style, learned from your chats and yours to edit anytime.",
  },
  {
    label: "Launchpad",
    title: "Schedule the countdown",
    body: "Plan every launch on one calendar and resurface evergreen posts when they matter again.",
  },
] as const;

export type FeatureLabel = (typeof FEATURES)[number]["label"];

/** "How it works". */
export const STEPS = [
  { n: "01", title: "Point it at your writing", body: "Any blog, newsletter or site URL, or upload markdown, text, HTML and PDF files." },
  { n: "02", title: "Watch them come into orbit", body: "Posts are cleaned, indexed and embedded in minutes." },
  { n: "03", title: "Launch", body: "Ask, listen, render and publish, all grounded in what you wrote." },
];

export type Plan = {
  id: string;
  name: string;
  tagline: string;
  price_monthly_usd: number;
  price_annual_monthly_usd?: number;
  price_annual_usd?: number;
  annual_savings_pct?: number;
  features: string[];
};

export type Cycle = "monthly" | "annual";

const ANNUAL_DISCOUNT = 0.25;

// Mirrors backend app/services/plans.py so pricing renders before (or without) the API.
export const FALLBACK_PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    tagline: "For trying Notestack on your archive",
    price_monthly_usd: 0,
    features: [
      "Up to 5 posts indexed, from any source",
      "Grounded research chat with citations",
      "1 audio overview, any length",
      "1 video",
      "2 Launch Kits",
      "2 infographics",
      "2 reports a month",
    ],
  },
  {
    id: "writer",
    name: "Writer",
    tagline: "For writers publishing every week",
    price_monthly_usd: 24.99,
    features: [
      "Up to 100 posts indexed, from any source",
      "10x more audio overviews than Free",
      "10 videos a month",
      "20 Launch Kits a month",
      "30 reports a month",
      "30 infographics a month",
      "Voice cloning with consent",
    ],
  },
  {
    id: "studio",
    name: "Studio",
    tagline: "For publications and power users",
    price_monthly_usd: 48.99,
    features: [
      "Up to 250 posts indexed, from any source",
      "40x more audio overviews than Free",
      "20 videos a month",
      "50 Launch Kits a month",
      "Unlimited reports",
      "Unlimited infographics",
      "Voice cloning with consent",
    ],
  },
];

export function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** Nearest .99 price, mirroring plans.to_99 on the backend. */
function to99(amount: number): number {
  return amount <= 0 ? 0 : Math.max(0.99, Math.round(amount + 0.01) - 0.01);
}

export function annualMonthly(plan: Plan): number {
  return plan.price_annual_monthly_usd ?? to99(plan.price_monthly_usd * (1 - ANNUAL_DISCOUNT));
}

export function savingsPct(plan: Plan): number {
  if (!plan.price_monthly_usd) return 0;
  return plan.annual_savings_pct ?? Math.round((1 - annualMonthly(plan) / plan.price_monthly_usd) * 100);
}

export function annualTotal(plan: Plan): number {
  return plan.price_annual_usd ?? Math.round(annualMonthly(plan) * 12 * 100) / 100;
}

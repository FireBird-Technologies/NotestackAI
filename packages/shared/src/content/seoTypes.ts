// Same shape as blog2video so posts and tooling port across sites.

export type BlogSection = {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  callout?: string;
};

export type FaqItem = { question: string; answer: string };

export type DistributionAsset = {
  channel: "x" | "linkedin" | "substack_notes" | "bluesky" | "newsletter" | "youtube";
  angle: string;
};

/** The reader's journey: the question they searched for and the answer they leave with. */
export type Mission = {
  question: string;
  /** Two or three sentences. Shown up front (featured snippet) and again at the destination. */
  answer: string;
};

export type BlogPost = {
  slug: string;
  title: string;
  description: string;
  category: string;
  /** Set when the canonical lives on another URL. Such posts are dropped from the sitemap. */
  canonicalPath?: string;
  heroImage?: string; // "/blog/blog-cover-<slug>.png"
  heroImageAlt?: string;
  publishedAt: string; // YYYY-MM-DD
  readTime: string;
  heroEyebrow: string;
  heroTitle: string;
  heroDescription: string;
  primaryKeyword: string;
  keywordVariant: string;
  relatedPaths: string[];
  /** Optional; derived from the title and description when absent. */
  mission?: Mission;
  /** Paragraphs, bullets, callouts and FAQ answers support inline [text](url) links and **bold**. */
  sections: BlogSection[];
  faq: FaqItem[];
  distributionPlan: DistributionAsset[];
};

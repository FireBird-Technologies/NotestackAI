import type { BlogPost } from "./seoTypes";

// Newest first. Cover images live in public/blog/blog-cover-<slug>.png.
// House rule: no em dashes anywhere in post copy (npm run check:copy enforces it).

export const blogPosts: BlogPost[] = [
  {
    slug: "turn-substack-archive-into-podcast",
    title: "How to Turn Your Substack Archive Into a Podcast Without Recording",
    description:
      "A practical guide to turning old Substack posts into a two host audio overview that stays true to what you actually wrote.",
    category: "Audio",
    publishedAt: "2026-09-22",
    readTime: "6 min read",
    heroEyebrow: "Audio overviews",
    heroTitle: "Your archive already is a podcast",
    heroDescription:
      "You have written hundreds of thousands of words. Here is how to let listeners hear them, with every claim traced back to the post it came from.",
    primaryKeyword: "substack to podcast",
    keywordVariant: "turn blog posts into podcast",
    relatedPaths: ["/blogs/grounded-ai-for-writers", "/pricing"],
    sections: [
      {
        heading: "Why most AI podcasts from blogs feel off",
        paragraphs: [
          "Generic text to speech tools read your post out loud. Generic AI podcast tools go the other way and improvise, adding facts you never wrote and opinions you do not hold.",
          "Readers notice both. The first sounds like a robot reading a newsletter. The second puts words in your mouth.",
        ],
      },
      {
        heading: "What a grounded audio overview does differently",
        paragraphs: [
          "Notestack first indexes your posts into passages. The script writer can only use those passages, and every line it writes carries a pointer to the passage that supports it.",
        ],
        bullets: [
          "Two hosts with distinct voices discuss your ideas, not the internet's",
          "Every factual line maps to a cited passage you can click",
          "Unsupported statements are rejected before audio is generated",
        ],
        callout: "If a host says it, you wrote it.",
      },
      {
        heading: "The workflow",
        paragraphs: [
          "Paste your Substack URL. Pick a post or build a notebook of related posts. Choose a format: deep dive, brief or debate. Notestack writes the script, you review it, and ElevenLabs voices it.",
          "Publish the file to your podcast feed, attach it to the original post, or cut a 60 second audiogram for social.",
        ],
      },
    ],
    faq: [
      {
        question: "Do I need to record my own voice?",
        answer:
          "No. Notestack ships with a curated pair of host voices. Voice cloning is optional and only happens after you record an explicit consent sample.",
      },
      {
        question: "Can the hosts make things up?",
        answer:
          "The script generator only sees passages from your posts, and a separate judge checks each factual line against its citation. Lines that fail are rewritten or removed.",
      },
    ],
    distributionPlan: [
      { channel: "substack_notes", angle: "Short clip of the hosts debating your most shared post" },
      { channel: "x", angle: "Thread on why grounded beats improvised AI audio" },
    ],
  },
  {
    slug: "grounded-ai-for-writers",
    title: "Grounded AI for Writers: Why Citations Matter More Than Creativity",
    description:
      "AI that writes about your work should be able to prove every sentence. Here is what grounding means and how to check for it.",
    category: "Research",
    publishedAt: "2026-09-15",
    readTime: "5 min read",
    heroEyebrow: "Research notebook",
    heroTitle: "Every sentence, traceable",
    heroDescription:
      "The most useful thing an AI can do with your archive is quote it accurately. Grounding is how you get there.",
    primaryKeyword: "grounded ai for writers",
    keywordVariant: "ai with citations for bloggers",
    relatedPaths: ["/blogs/turn-substack-archive-into-podcast"],
    sections: [
      {
        heading: "What grounding means",
        paragraphs: [
          "A grounded answer is one where each factual sentence points to a specific passage in a source you trust. In Notestack, that source is always your own writing.",
        ],
      },
      {
        heading: "How to tell if a tool is grounded",
        paragraphs: ["Ask it a question your archive cannot answer. A grounded tool says so. An ungrounded one invents."],
        bullets: [
          "Citations link to exact passages, not just post titles",
          "It admits when the archive does not cover a topic",
          "Marketing copy it writes can be traced back the same way",
        ],
      },
    ],
    faq: [
      {
        question: "Does Notestack train on my posts?",
        answer: "No. Your content and outputs are yours. Nothing is used for training unless you opt in.",
      },
    ],
    distributionPlan: [{ channel: "linkedin", angle: "Writers deserve AI that can show its sources" }],
  },
  {
    slug: "substack-launch-kit",
    title: "The Substack Launch Kit: One Post, Every Platform, Your Voice",
    description:
      "How to turn each new post into threads, LinkedIn posts, Notes, quote cards and a vertical short without sounding like a bot.",
    category: "Marketing",
    publishedAt: "2026-09-08",
    readTime: "7 min read",
    heroEyebrow: "Launch Kit",
    heroTitle: "Hit publish once. Launch everywhere.",
    heroDescription:
      "A launch kit is the set of native posts that carry one piece of writing to every place your readers are.",
    primaryKeyword: "substack marketing",
    keywordVariant: "promote substack posts",
    relatedPaths: ["/blogs/grounded-ai-for-writers", "/pricing"],
    sections: [
      {
        heading: "Why reposting the link is not enough",
        paragraphs: [
          "Every platform rewards native content. A bare link in a feed gets a fraction of the reach of a post written for that feed.",
        ],
      },
      {
        heading: "What goes in a launch kit",
        paragraphs: ["Notestack builds the full set from your post and your voice profile:"],
        bullets: [
          "An X or Bluesky thread built on the post's strongest claims",
          "A LinkedIn post with a professional framing",
          "Three Substack Notes to drip over the week",
          "Quote cards and a carousel",
          "A 9:16 short with accurate captions",
          "An SEO pack with meta description and internal links",
        ],
      },
    ],
    faq: [
      {
        question: "Will it sound like me?",
        answer:
          "Notestack builds a voice profile from your own posts and scores every draft against it before you see it.",
      },
    ],
    distributionPlan: [{ channel: "youtube", angle: "Screen recording of a full launch kit in 60 seconds" }],
  },
];

export const getPost = (slug: string) => blogPosts.find((p) => p.slug === slug);

import { missionPosts } from "./missionPosts";
import type { BlogPost } from "./seoTypes";

// Newest first. Cover images live in public/blog/blog-cover-<slug>.png.
// House rule: no em dashes anywhere in post copy (npm run check:copy enforces it).

export const blogPosts: BlogPost[] = [
  ...missionPosts,
  {
    slug: "built-on-the-blog2video-api",
    title: "How Notestack Makes Video: Built on the Blog2Video API",
    description:
      "Notestack turns a writer's archive into video by calling the Blog2Video API. Here is how it works, what we had to build around it, and what to copy if you embed video in your own product.",
    category: "Engineering",
    publishedAt: "2026-11-01",
    readTime: "6 min read",
    heroEyebrow: "Under the hood",
    heroTitle: "Notestack does not render video. Blog2Video does.",
    heroDescription:
      "A real example of embedding the Blog2Video API in a product, including the part most tutorials skip: who is allowed to see which video.",
    primaryKeyword: "video api for platforms",
    keywordVariant: "embed video generation in your product",
    relatedPaths: ["/blogs/grounded-ai-for-writers", "/blogs/ai-tools-for-writers"],
    sections: [
      {
        heading: "Disclosure first",
        paragraphs: [
          "Notestack and Blog2Video are both made by Firebird Technologies. This is a first party case study, not an independent review. What it offers is something an outside write up cannot: the actual shape of the integration, including the parts that took work.",
        ],
      },
      {
        heading: "What Notestack asks Blog2Video to do",
        paragraphs: [
          "Notestack is built around a writer's own archive. When a writer wants a video from a post, Notestack hands the text or the link to the [Blog2Video API](https://blog2video.app/api-docs), which writes the scenes, records the voiceover and renders the MP4. Notestack never runs a render pipeline of its own for video.",
          "The call is the same one any developer would make: create a video with POST /api/v1/videos, poll its status, trigger the render, and read video_url when it is done. Everything else in the product, the template picker, the voice picker, the scene editing screens, sits on top of that.",
        ],
        bullets: [
          "Create: a link, pasted text or a post from the workspace becomes a Blog2Video video.",
          "Templates: Notestack lists the built-in catalog and the writer's custom templates, with poster images served from blog2video.app.",
          "Voices and editing: voice choice and scene edits are forwarded to the Blog2Video API.",
          "Status: Notestack polls until generation and rendering report done.",
        ],
      },
      {
        heading: "Why we did not build our own renderer",
        paragraphs: [
          "Notestack is a research and writing product. Rendering narrated video with templates, voices and layouts is a large separate problem, and Blog2Video already solves it. Embedding it let us keep working on what makes Notestack different.",
          "The same logic applies to newsletter tools, Ghost and WordPress hosts, finance media companies and anyone building agents. If video is a feature of your product and not the product, call an API.",
        ],
      },
      {
        heading: "The part tutorials skip: one key, many users",
        paragraphs: [
          "Notestack calls the API with its own account key, so every video is charged to that account. Blog2Video's ownership checks stop at the account, which means anything made with that key can be listed and edited with it.",
          "So Notestack checks ownership itself. Every route that takes a Blog2Video id first confirms the video, template or style belongs to the current workspace and returns a 404 otherwise, so another workspace's ids are never confirmed. Every create or edit body has its template, style and voice references checked before it is forwarded.",
          "Notestack also tags videos with an external_user_id, which the API lets you filter on when listing, so a workspace's library is one filtered call.",
        ],
        callout: "If you embed the API in a multi-user product, ownership checks are your job. Build them first.",
      },
      {
        heading: "Operational lessons worth copying",
        paragraphs: [
          "A few small decisions have paid for themselves.",
        ],
        bullets: [
          "Keep the key on the backend only. It never reaches the browser or the logs.",
          "Set explicit timeouts. Notestack waits up to 30 seconds on every call, because Blog2Video can take well over 10 seconds on creates, uploads and full project reads.",
          "Alert on capacity. Notestack logs an error when the Blog2Video account has fewer than 20 videos left, so a plan limit never surprises a user.",
          "Poll, do not wait. The API has no webhooks today, so status polling is part of the design.",
        ],
      },
      {
        heading: "Build the same thing",
        paragraphs: [
          "If you are adding video to a platform, start from the API overview and the finance and data publisher guide. The limits are stated plainly there: no avatars, no prompt generated footage, no webhooks.",
          "Read [the Blog2Video API overview](https://blog2video.app/blogs/video-generation-api-for-publishers), then open the [API documentation](https://blog2video.app/api-docs) and make your first request.",
        ],
      },
    ],
    faq: [
      {
        question: "Is Notestack really built on the Blog2Video API?",
        answer:
          "Notestack's video features call the public Blog2Video API with Notestack's own account key. Notestack does not render video itself. Both products are made by Firebird Technologies.",
      },
      {
        question: "How does Notestack stop one user seeing another user's videos?",
        answer:
          "Blog2Video checks ownership at the account level, so Notestack checks that every video, template and style id belongs to the current workspace before forwarding a request, and returns a 404 otherwise.",
      },
      {
        question: "Does the Blog2Video API have webhooks?",
        answer:
          "Not today. Notestack polls the status endpoints until generation and rendering report done.",
      },
      {
        question: "Can I use the Blog2Video API in my own product?",
        answer:
          "Yes. API access is on paid plans. Create a key, keep it on your server, and follow the quick start in the Blog2Video API documentation.",
      },
    ],
    distributionPlan: [
      { channel: "x", angle: "Thread: how Notestack makes video without a render pipeline, and the ownership check every embedder needs" },
      { channel: "linkedin", angle: "Engineering note on embedding a video API in a multi-user product, with the lessons list" },
      { channel: "newsletter", angle: "Short behind the scenes piece on why we built on our own API" },
    ],
  },
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
    relatedPaths: ["/blogs/grounded-ai-for-writers"],
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
          "Want to see the shape of the episode before you connect anything? Paste a post into the free [AI podcast generator](/tools/ai-podcast-generator) for a two host script, or use the [podcast script generator](/tools/podcast-script-generator) if you plan to record it yourself.",
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
    relatedPaths: ["/blogs/grounded-ai-for-writers"],
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

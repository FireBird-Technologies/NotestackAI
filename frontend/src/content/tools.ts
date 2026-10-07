// Free tools at /tools/<slug>. Copy is shared by the React page and the build time prerender (seo/prerender.ts).
// Every tool widget requires sign in; the copy below stays public so the page can rank.
// Volumes are US Google Ads, Sep 2026. No em dashes (npm run check:copy).

export type ToolSection = { heading: string; paragraphs: string[]; bullets?: string[] };

export type ToolDef = {
  slug: string;
  /** <title> and meta description. */
  metaTitle: string;
  description: string;
  eyebrow: string;
  heroTitle: string;
  heroDescription: string;
  primaryKeyword: string;
  /** What the widget asks for. */
  inputLabel: string;
  inputPlaceholder: string;
  /** Optional line under the input (inline [text](url) links allowed). */
  inputHint?: string;
  sections: ToolSection[];
  faq: { question: string; answer: string }[];
  relatedPaths: string[];
};

export const toolsHub = {
  path: "/tools",
  metaTitle: "Free AI Podcast Tools for Writers | Notestack",
  description:
    "Free tools that turn your writing into podcasts: an AI podcast generator, a PDF to podcast converter and a two host podcast script generator.",
  heroTitle: "Free tools for turning writing into audio",
  heroDescription:
    "Every tool works on words you already wrote. Sign in free, paste a post or a PDF's text, and get a two host script you can voice in Notestack.",
};

export const tools: ToolDef[] = [
  {
    slug: "ai-podcast-generator",
    metaTitle: "Free AI Podcast Generator: Turn Any Post Into a Two Host Show | Notestack",
    description:
      "Free AI podcast generator for writers. Paste a blog post or newsletter and get a two host podcast script grounded in your words, then voice it as a full audio overview in Notestack.",
    eyebrow: "AI podcast generator",
    heroTitle: "AI podcast generator for writers",
    heroDescription:
      "Paste a blog post, newsletter or article and get a two host podcast script built only from what you wrote. Voice it as a finished audio overview in one click.",
    primaryKeyword: "ai podcast generator",
    inputLabel: "Paste your post",
    inputPlaceholder: "Paste a blog post, newsletter issue or article. The script is built only from this text.",
    sections: [
      {
        heading: "How the AI podcast generator works",
        paragraphs: [
          "Most AI podcast generators write a new show and hope it matches your ideas. This one starts from your text. It picks the sentences that carry your argument, then stages them as a conversation between two hosts: one who guides, one who asks the questions a listener would ask.",
          "Because every host line comes from a passage you wrote, nothing is invented. In the full Notestack app each line keeps a citation back to the exact source lines, so you can check the show before anyone hears it.",
        ],
      },
      {
        heading: "From script to finished episode",
        paragraphs: [
          "The free tool gives you the script. To hear it, connect your blog or newsletter to Notestack and generate an audio overview: two natural voices, delivery controls, and optional consented voice cloning so one host can sound like you. The free plan includes audio minutes to try it.",
          "Want a video instead of audio? [Blog2Video](https://blog2video.app/blog-to-video) turns the same post into a narrated video, and [PDF2Video](https://pdf2vid.com) does the same for reports and papers.",
        ],
        bullets: [
          "Two hosts, grounded in your own post",
          "Runtime estimate before you record anything",
          "Copy or download the script as text",
          "Voice it in Notestack with two host audio overviews",
        ],
      },
      {
        heading: "Why writers use a podcast generator",
        paragraphs: [
          "A post that took a week to write gets read once. A two host episode of the same post reaches people on walks, commutes and at the gym, and it keeps your archive working long after publish day. It is the fastest way to add audio to a newsletter without booking a guest or sitting at a microphone.",
          "If you are comparing tools, our guide to the [best NotebookLM alternatives](/blogs/notebooklm-alternatives) covers the other audio overview options, and [Notestack vs NotebookLM](/notebooklm-alternative) explains the difference side by side.",
        ],
      },
    ],
    faq: [
      {
        question: "Is the AI podcast generator free?",
        answer:
          "Yes. Sign in with a free Notestack account and generate as many scripts as you like. Turning a script into audio uses the audio minutes included in every plan, free plan included.",
      },
      {
        question: "Does it make up content?",
        answer:
          "No. The script is assembled only from sentences in the text you paste. The hosts reframe and question your points, but the substance is always yours.",
      },
      {
        question: "How is this different from NotebookLM audio overviews?",
        answer:
          "NotebookLM works on sources you upload one at a time. Notestack syncs your whole blog or newsletter, keeps citations to the exact lines, and can voice one host in your own cloned voice with consent.",
      },
      {
        question: "How long will my episode be?",
        answer:
          "The tool estimates runtime at about 150 spoken words per minute. A 1,500 word post usually becomes a six to nine minute episode.",
      },
    ],
    relatedPaths: ["/tools/pdf-to-podcast", "/tools/podcast-script-generator", "/blogs/turn-substack-archive-into-podcast", "/notebooklm-alternative"],
  },
  {
    slug: "pdf-to-podcast",
    metaTitle: "PDF to Podcast: Turn Any PDF Into a Two Host Podcast Free | Notestack",
    description:
      "Turn a PDF, research paper or report into a two host podcast. Paste the PDF's text or upload the file to Notestack, and get an audio overview grounded in the document.",
    eyebrow: "PDF to podcast",
    heroTitle: "Turn any PDF into a podcast",
    heroDescription:
      "Research papers, reports, ebooks and slide decks become a two host conversation you can listen to. Every line stays tied to the page it came from.",
    primaryKeyword: "pdf to podcast",
    inputLabel: "Paste the text from your PDF",
    inputPlaceholder: "Paste the text of your PDF here. The script is built only from this text.",
    inputHint:
      "Need the text first? Pull it out with the free [PDF to text tool](https://pdf2vid.com/tools/pdf-to-text), or upload the PDF straight into a Notestack notebook.",
    sections: [
      {
        heading: "How PDF to podcast works",
        paragraphs: [
          "Paste the text from your PDF and the tool pulls out the sentences that carry the document: the claim, the evidence and the conclusion. It stages them as a two host conversation, with one host explaining and the other asking what a listener would ask.",
          "In the Notestack app you can skip the copy and paste. Upload the PDF into a notebook and generate a full audio overview, with every host line cited to the page and lines it came from.",
        ],
      },
      {
        heading: "Which PDFs make the best podcasts",
        paragraphs: [
          "Documents with an argument work best: research papers, white papers, annual reports, long reads and ebook chapters. Pure reference material such as manuals or spreadsheets makes a thinner show.",
        ],
        bullets: [
          "Research papers: the hosts walk through the question, method and finding",
          "Reports: turn the executive summary into a ten minute briefing",
          "Ebooks: one episode per chapter becomes a series",
          "Slide decks: the narration fills in what the slides leave out",
        ],
      },
      {
        heading: "Podcast or video?",
        paragraphs: [
          "Audio suits people who listen on the move. If your audience watches instead, [PDF2Video](https://pdf2vid.com) turns the same PDF into a narrated video with slides, and its [PDF to audio](https://pdf2vid.com/tools/pdf-to-audio) tool reads a document aloud word for word. A podcast is different: two hosts talk the ideas through.",
          "Researching across many PDFs? Read our guide to the [best AI for research](/blogs/best-ai-for-research).",
        ],
      },
    ],
    faq: [
      {
        question: "Can I turn a PDF into a podcast for free?",
        answer:
          "Yes. Sign in free, paste the PDF's text and get a two host script. Voicing it in Notestack uses the audio minutes included in the free plan.",
      },
      {
        question: "Does it work with scanned PDFs?",
        answer:
          "The tool needs selectable text. If your PDF is a scan, run it through OCR first, then paste the text.",
      },
      {
        question: "Is PDF to podcast the same as PDF to audio?",
        answer:
          "No. PDF to audio reads the document aloud. PDF to podcast turns it into a conversation between two hosts who explain and question the ideas, which is easier to follow for long or technical documents.",
      },
    ],
    relatedPaths: ["/tools/ai-podcast-generator", "/tools/podcast-script-generator", "/blogs/best-ai-for-research", "/notebooklm-alternative"],
  },
  {
    slug: "podcast-script-generator",
    metaTitle: "Free Podcast Script Generator: Two Host Scripts From Your Writing | Notestack",
    description:
      "Free podcast script generator. Paste your notes, post or article and get a formatted two host podcast script with an intro, segments, questions and an outro, built only from your words.",
    eyebrow: "Podcast script generator",
    heroTitle: "Podcast script generator",
    heroDescription:
      "Turn notes, a post or an article into a ready to record two host script: cold open, segments, the questions your listeners would ask, and a clean outro.",
    primaryKeyword: "podcast script generator",
    inputLabel: "Paste your notes or post",
    inputPlaceholder: "Paste notes, an outline or a full post. The script is built only from this text.",
    sections: [
      {
        heading: "What you get",
        paragraphs: [
          "A script in the standard two host format: a cold open that states the big idea, segments built from your key points, host questions that set up each point, and an outro that lands the takeaway. Each line is labelled with its speaker so you can record straight from it.",
        ],
        bullets: [
          "Speaker labelled lines for Host A and Host B",
          "Segments ordered the way your text builds its argument",
          "Estimated runtime at a natural speaking pace",
          "Plain text you can copy into any teleprompter or doc",
        ],
      },
      {
        heading: "Record it, or let Notestack voice it",
        paragraphs: [
          "Record the script yourself with a co host, or generate a voiced audio overview in Notestack with two natural voices. Writers who publish every week connect their newsletter once, and every new post can become an episode.",
          "Turning a whole back catalog into a show? Read [how to turn your Substack archive into a podcast](/blogs/turn-substack-archive-into-podcast).",
        ],
      },
      {
        heading: "Tips for a better script",
        paragraphs: ["The generator follows your text, so the clearer the source, the better the show."],
        bullets: [
          "Paste the full post, not a summary: the hosts need your specifics",
          "Keep one idea per paragraph so segments split cleanly",
          "Edit the questions to sound like your real audience",
          "Aim for 800 to 2,000 words for a five to fifteen minute episode",
        ],
      },
    ],
    faq: [
      {
        question: "Is the podcast script generator free?",
        answer: "Yes. It is free with a Notestack account. Sign in and generate as many scripts as you need.",
      },
      {
        question: "Can I use the script commercially?",
        answer: "Yes. The script is built from your own text, so it is yours to record, publish and monetize.",
      },
      {
        question: "Does it support one host shows?",
        answer:
          "The generator writes for two hosts, the format that keeps long ideas easy to follow. For a solo show, read Host A's lines and turn Host B's questions into your own transitions.",
      },
    ],
    relatedPaths: ["/tools/ai-podcast-generator", "/tools/pdf-to-podcast", "/blogs/substack-launch-kit", "/blogs/ai-tools-for-writers"],
  },
];

export const getTool = (slug: string) => tools.find((t) => t.slug === slug);

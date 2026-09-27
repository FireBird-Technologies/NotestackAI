import type { BlogPost } from "./seoTypes";

// SEO missions (keyword research: DataForSEO, US, September 2026).
//   notebooklm alternatives        590/mo  KD 0    alternative to notebooklm 170/mo
//   best ai for research         2,400/mo  KD 19   ai tools for research 720/mo KD 10
//   ai tools for writers           880/mo  KD 22   best ai for writing 4,400/mo KD 26
//   notebooklm vs chatgpt          320/mo  KD 0    grounded ai 480/mo KD 8
//   ai second brain                390/mo  KD 16   rising fast (110 to 880/mo over the year)
// Sister products are linked where they answer the reader's next question:
//   blog2video.app (posts, URLs and PDFs to video), pdf2vid.com (PDF to narrated video),
//   bloghub.app (free blog and newsletter directory).
// House rule: no em dashes.

export const missionPosts: BlogPost[] = [
  {
    slug: "notebooklm-alternatives",
    title: "NotebookLM Alternatives in 2026: Why Notestack Is the Ultimate Pick for Writers",
    description:
      "An honest guide to NotebookLM alternatives: which tool to use for grounded research, open source privacy, audio, video and working with your own writing archive.",
    category: "Research",
    publishedAt: "2026-09-27",
    readTime: "9 min read",
    heroEyebrow: "NotebookLM alternatives",
    heroTitle: "Looking past NotebookLM",
    heroDescription:
      "NotebookLM made source grounded AI mainstream. It is also a bundle, and most people only need part of it. Here is how to pick the part that matters to you.",
    primaryKeyword: "notebooklm alternatives",
    keywordVariant: "alternative to notebooklm",
    relatedPaths: ["/blogs/notebooklm-vs-chatgpt", "/blogs/best-ai-for-research", "/blogs/ai-tools-for-writers"],
    mission: {
      question: "What is the best NotebookLM alternative for my kind of work?",
      answer:
        "For writers, bloggers and newsletters, Notestack is the ultimate NotebookLM alternative: it syncs your whole archive, cites the exact lines behind every answer, and turns your writing into audio, video and launch posts. If you need open source and self hosted, use Khoj. For academic papers, Elicit or Consensus. For turning documents into video, [PDF2Video](https://pdf2vid.com) or [Blog2Video](https://blog2video.app).",
    },
    sections: [
      {
        heading: "First, decide which part of NotebookLM you actually use",
        paragraphs: [
          "NotebookLM is several products in one: a place to upload sources, a chat that answers only from them, study guides, audio overviews and, more recently, video overviews. Most people who search for an alternative love one of those and are frustrated by another.",
          "So before comparing tools, name the job. Are you researching other people's documents, or working with your own writing? Do you need citations you can click, or a quick summary? Do you want to listen, watch or publish the result?",
        ],
        bullets: [
          "**Grounded chat over sources**: answers that only come from what you uploaded",
          "**Your own archive**: years of posts or notes you want to question and reuse",
          "**Audio and video**: turning material into something people can listen to or watch",
          "**Privacy and control**: running it locally or on your own servers",
        ],
        callout: "The best alternative is the one that does your one job better, not the one that copies every feature.",
      },
      {
        heading: "The ultimate NotebookLM alternative for writers: Notestack",
        paragraphs: [
          "If the sources you care about are your own posts, a general notebook makes you upload files by hand and loses track of what you wrote when. Notestack connects to your Substack, Ghost, Medium or any RSS feed, keeps each post as its own file, and answers with citations to the exact lines it read.",
          "The difference shows up in the details. Answers cite line ranges, not whole documents, and anything the tool cannot support from your posts is dropped instead of guessed. The same archive feeds audio overviews, video and Launch Kits written in your voice.",
          "That combination is why we call it the ultimate NotebookLM alternative for anyone who publishes. See the full [Notestack vs NotebookLM comparison](/notebooklm-alternative) for every difference, side by side.",
        ],
        bullets: [
          "Syncs a whole publication, including the back catalogue",
          "Line level citations you can open and check",
          "Topic map, voice profile and resurfacing built on the same archive",
        ],
      },
      {
        heading: "For open source and self hosting: Khoj and friends",
        paragraphs: [
          "If your documents cannot leave your machine, look at open source options. Khoj is the most mature: it indexes your files and notes, answers with sources, and can run on your own hardware with a local model. Obsidian with an AI plugin is a lighter route if you already live in markdown.",
          "The trade off is setup and maintenance. You choose the model, handle updates and accept that local models are weaker at long, careful reasoning than the best hosted ones.",
        ],
      },
      {
        heading: "For academic research: Elicit, Consensus and Perplexity Spaces",
        paragraphs: [
          "NotebookLM only knows what you upload. Research tools built for papers go further by finding the papers too. Elicit pulls findings from studies into comparison tables, Consensus answers questions from peer reviewed literature, and Perplexity Spaces combines your files with live web search.",
          "Use them to discover and screen sources, then bring the ones that matter into a grounded notebook where every claim stays tied to a page. Our guide to the [best AI for research](/blogs/best-ai-for-research) walks through that workflow step by step.",
        ],
      },
      {
        heading: "For audio and video overviews",
        paragraphs: [
          "Audio overviews are the feature people miss most. Notestack makes two host audio overviews from a post or a notebook, with every line tied back to a passage, and you can pick from ElevenLabs voices or clone your own with consent.",
          "Video is where dedicated tools win. If your source is a report, paper or deck, [PDF2Video](https://pdf2vid.com) turns any PDF into a narrated video. If it is a blog post, URL or script, [Blog2Video](https://blog2video.app) turns it into a finished video without you touching an editor. Both are a better fit than a notebook when the video itself is the deliverable.",
        ],
        callout: "Research in a notebook. Publish with a tool built for the format.",
      },
      {
        heading: "How to switch without losing your work",
        paragraphs: [
          "Export what you can first: your notes, saved answers and the list of sources. Then rebuild around the job you named at the start rather than recreating every notebook one to one.",
          "If you are a writer, the fastest path is to connect your publication and let the archive rebuild itself. Once it is indexed, list it on [BlogHub](https://bloghub.app), a free blog and newsletter directory, so new readers can find the work you are now researching and repurposing.",
        ],
      },
    ],
    faq: [
      {
        question: "Is there a free alternative to NotebookLM?",
        answer:
          "Yes. Khoj is open source and free to self host, most research tools have free tiers, and Notestack has a free plan for trying grounded chat on your latest posts.",
      },
      {
        question: "Is there an open source NotebookLM alternative?",
        answer:
          "Khoj is the most complete open source option. You can run it locally with your own model, which keeps documents on your machine.",
      },
      {
        question: "What is the best NotebookLM alternative for video overviews?",
        answer:
          "Use a tool built for video. [PDF2Video](https://pdf2vid.com) turns PDFs into narrated videos and [Blog2Video](https://blog2video.app) turns blog posts, URLs and scripts into videos.",
      },
      {
        question: "Which NotebookLM alternative is best for writers?",
        answer:
          "Notestack. It connects to your blog, newsletter or site (or your markdown files) instead of relying on manual uploads, cites exact lines, and turns answers into audio, video and posts in your voice. Compare them in [Notestack vs NotebookLM](/notebooklm-alternative).",
      },
    ],
    distributionPlan: [
      { channel: "x", angle: "Thread: pick a NotebookLM alternative by the one job you need done" },
      { channel: "linkedin", angle: "Why grounded AI for your own archive beats uploading PDFs one by one" },
      { channel: "substack_notes", angle: "The NotebookLM feature writers miss most, and where to find it" },
    ],
  },
  {
    slug: "best-ai-for-research",
    title: "Best AI for Research in 2026: A Workflow, Not a Single Tool",
    description:
      "The best AI for research depends on the stage: finding sources, reading them, synthesizing and sharing. Here are the AI tools for research that fit each stage, and how to keep every claim traceable.",
    category: "Research",
    publishedAt: "2026-09-26",
    readTime: "8 min read",
    heroEyebrow: "AI for research",
    heroTitle: "Research is a trip in stages",
    heroDescription:
      "No single AI is best at finding, reading, thinking and explaining. Chain the right tools and keep a citation trail from the first search to the final draft.",
    primaryKeyword: "best ai for research",
    keywordVariant: "ai tools for research",
    relatedPaths: ["/blogs/notebooklm-alternatives", "/blogs/notebooklm-vs-chatgpt", "/blogs/ai-tools-for-writers"],
    mission: {
      question: "Which AI is actually best for research?",
      answer:
        "No single one. Use a discovery tool (Elicit, Consensus or Perplexity) to find sources, a grounded notebook to read and synthesize them with line level citations, and a publishing tool such as [PDF2Video](https://pdf2vid.com) to share findings. The best setup is the one where every claim can be traced back to a source.",
    },
    sections: [
      {
        heading: "Why one tool is never enough",
        paragraphs: [
          "General chatbots are good at sounding certain, which is the opposite of what research needs. The failure is rarely a wrong fact on its own. It is a confident sentence with no trail back to where it came from.",
          "Good research AI is less about intelligence and more about provenance. At every stage, ask one question: can I click through to the exact passage behind this sentence?",
        ],
        callout: "If you cannot trace it, you cannot trust it.",
      },
      {
        heading: "Stage one: find the sources",
        paragraphs: [
          "Discovery tools search far beyond what you already have. Consensus answers questions from peer reviewed papers, Elicit extracts findings from studies into tables you can compare, and Perplexity searches the live web with links for every claim.",
          "Treat this stage as a net, not a verdict. Save the promising sources, skim the abstracts, and move the ones that matter into a place where you can read them properly.",
        ],
        bullets: ["Consensus for evidence from papers", "Elicit for comparing many studies side by side", "Perplexity for current events and the open web"],
      },
      {
        heading: "Stage two: read deeply with a grounded notebook",
        paragraphs: [
          "Once you have sources, you want an AI that answers only from them. This is where grounded notebooks shine: NotebookLM for uploaded documents, and Notestack, the ultimate [NotebookLM alternative](/notebooklm-alternative) when the sources are your own writing, synced straight from your blog, newsletter or site.",
          "The best of these do more than summarize. They search with several phrasings, read around each hit, and cite the line range they used, so you can open the passage and check the context yourself.",
        ],
      },
      {
        heading: "Stage three: synthesize without losing the trail",
        paragraphs: [
          "Synthesis is where most AI research breaks. A summary of ten papers quietly blends them, and the nuance of which source said what disappears.",
          "Keep synthesis inside the grounded notebook, ask for claims with citations rather than prose, and write the final argument yourself. If you publish on Substack, a notebook built from your own posts also shows how your thinking has changed over time, which is research most writers never get to do.",
        ],
      },
      {
        heading: "Stage four: share what you found",
        paragraphs: [
          "Research that stays in a document rarely gets read. Turn the dense parts into formats people actually consume. [PDF2Video](https://pdf2vid.com) turns a paper, report or slide deck into a narrated video, which is often the fastest way to brief a team or a class.",
          "For findings you have written up as a post, [Blog2Video](https://blog2video.app) makes a video from the URL, and an audio overview gives listeners the two host version while you keep every line grounded in the source.",
        ],
      },
      {
        heading: "A simple stack to start with",
        paragraphs: ["If you want one setup to try this week, keep it small and make each tool earn its place."],
        bullets: [
          "Discover: Consensus or Elicit, plus Perplexity for the web",
          "Read and synthesize: a grounded notebook with line citations",
          "Write: your own words, with the notebook open beside you",
          "Share: a narrated video with [PDF2Video](https://pdf2vid.com) or an audio overview",
        ],
      },
    ],
    faq: [
      {
        question: "Is ChatGPT good for research?",
        answer:
          "It is good for brainstorming and explaining concepts, but it can state things confidently without a source. For research, pair it with tools that cite, or read our [NotebookLM vs ChatGPT](/blogs/notebooklm-vs-chatgpt) comparison.",
      },
      {
        question: "What are the best free AI tools for research?",
        answer:
          "Consensus, Elicit and Perplexity all have free tiers for discovery, NotebookLM is free for reading uploaded sources, and open source tools like Khoj are free to self host.",
      },
      {
        question: "Which AI is most reliable for research?",
        answer:
          "The most reliable is the one that shows its sources at the passage level and refuses to answer when the sources do not cover the question. Reliability comes from grounding, not from model size.",
      },
      {
        question: "How do I turn research papers into videos?",
        answer:
          "Upload the PDF to [PDF2Video](https://pdf2vid.com) and it produces a narrated video. For findings published as a blog post, use [Blog2Video](https://blog2video.app).",
      },
    ],
    distributionPlan: [
      { channel: "linkedin", angle: "The four stage research stack, and why provenance beats intelligence" },
      { channel: "x", angle: "Thread: best AI for research depends on the stage you are in" },
      { channel: "youtube", angle: "Narrated walkthrough made with PDF2Video from the workflow checklist" },
    ],
  },
  {
    slug: "ai-tools-for-writers",
    title: "AI Tools for Writers Who Care About Depth, Not Word Count",
    description:
      "The best AI for writing is not the one that writes the most. Here are AI tools for writers that help with research, memory, voice and distribution, while you keep doing the deep work.",
    category: "Writing",
    publishedAt: "2026-09-25",
    readTime: "8 min read",
    heroEyebrow: "AI for deep writing",
    heroTitle: "Use AI for everything around the writing",
    heroDescription:
      "Deep writing is slow on purpose. The right AI speeds up the research, the remembering and the distribution, so the slow part gets more of your time.",
    primaryKeyword: "ai tools for writers",
    keywordVariant: "best ai for writing",
    relatedPaths: ["/blogs/ai-second-brain-for-writers", "/blogs/best-ai-for-research", "/blogs/notebooklm-alternatives"],
    mission: {
      question: "How can AI help me write deeper instead of just faster?",
      answer:
        "Keep the drafting and let AI handle the work around it: research with citations, remembering what you already wrote, checking drafts against your voice, and turning finished posts into audio, video and social posts. The best AI tools for writers protect your thinking time instead of replacing it.",
    },
    sections: [
      {
        heading: "Why most AI writing tools make writing shallower",
        paragraphs: [
          "Most AI writing assistants are built to produce more words. That is useful for product descriptions and useless for an essay whose value is the thinking behind it.",
          "Readers can tell. Generated prose is smooth, general and forgettable, because it averages the internet instead of arguing a point only you would make.",
        ],
        callout: "Depth comes from what you know and what you have already said. That is where AI should help.",
      },
      {
        heading: "Research you can cite",
        paragraphs: [
          "The first job for AI in deep writing is research that holds up. Use tools that answer from sources and show the passage, not ones that paraphrase the web from memory.",
          "Our guide to the [best AI for research](/blogs/best-ai-for-research) covers discovery tools and grounded notebooks. The rule for writers is simple: never publish a fact you cannot click through to.",
        ],
      },
      {
        heading: "A memory of everything you have written",
        paragraphs: [
          "Writers with a long archive repeat themselves, contradict themselves and forget their best lines. A grounded notebook over your own posts fixes that. Ask what you have already argued about a topic and get the answer with citations to your past posts.",
          "Notestack builds this from your publication automatically, then maps the topics you keep returning to and the ones that went dormant. It is the research assistant that has read everything you ever published, and the ultimate [NotebookLM alternative](/notebooklm-alternative) for writers.",
        ],
        bullets: [
          "Find what you already said before you say it again",
          "See how your view changed over the years",
          "Pull exact quotes with the line they came from",
        ],
      },
      {
        heading: "A second reader for voice and structure",
        paragraphs: [
          "AI is a decent editor when it knows your voice. A voice profile built from your best posts lets it flag sentences that sound unlike you, suggest cuts, and point out where an argument jumps a step.",
          "Keep it in the editor's chair. Ask for questions and critiques, not rewrites, and your draft stays yours.",
        ],
      },
      {
        heading: "Distribution without the busywork",
        paragraphs: [
          "Deep posts deserve a long life, and that is where AI saves the most time. A Launch Kit turns one post into a thread, a LinkedIn post, Substack Notes and a carousel, written from claims the post actually makes.",
          "Video extends the reach further: [Blog2Video](https://blog2video.app) turns a finished post into a video for YouTube or Shorts. And make sure new readers can find you at all by listing your publication on [BlogHub](https://bloghub.app), a free directory of blogs and newsletters.",
        ],
      },
      {
        heading: "A deep writing stack",
        paragraphs: ["Here is a setup that protects the slow part of writing."],
        bullets: [
          "Research: a discovery tool plus a grounded notebook with citations",
          "Memory: your own archive, searchable and cited",
          "Editing: a voice profile that critiques instead of rewrites",
          "Distribution: Launch Kits, [Blog2Video](https://blog2video.app) and a listing on [BlogHub](https://bloghub.app)",
        ],
      },
    ],
    faq: [
      {
        question: "What is the best AI for writing long form essays?",
        answer:
          "For long form work, the most useful AI is a grounded research and memory tool rather than a text generator. Draft yourself, and use AI to research, recall your past writing and edit against your voice.",
      },
      {
        question: "Will using AI make my writing sound generic?",
        answer:
          "Only if it writes for you. Used for research, recall and critique, AI makes writing more specific, because you spend more time on the ideas only you have.",
      },
      {
        question: "How do I grow readers for a newsletter?",
        answer:
          "Repurpose each post into formats people discover on other platforms, and list your publication on [BlogHub](https://bloghub.app) so readers browsing for new blogs and newsletters can find it.",
      },
      {
        question: "Can AI turn my blog posts into videos?",
        answer: "Yes. [Blog2Video](https://blog2video.app) turns blog posts, URLs and scripts into videos without an editor.",
      },
    ],
    distributionPlan: [
      { channel: "substack_notes", angle: "Use AI for everything around the writing, never for the writing itself" },
      { channel: "linkedin", angle: "A deep writing stack: research, memory, voice, distribution" },
      { channel: "x", angle: "Thread: why most AI writing tools make writing shallower" },
    ],
  },
  {
    slug: "notebooklm-vs-chatgpt",
    title: "NotebookLM vs ChatGPT: Which Is Better for Research and Writing?",
    description:
      "NotebookLM vs ChatGPT comes down to grounding. One answers only from your sources, the other from everything it learned. Here is when to use each, and what grounded AI really means.",
    category: "Research",
    publishedAt: "2026-09-24",
    readTime: "7 min read",
    heroEyebrow: "Grounded AI",
    heroTitle: "Two ways an AI can know things",
    heroDescription:
      "ChatGPT knows a little about everything. NotebookLM knows only what you give it. For research and writing, that difference decides whether you can trust the answer.",
    primaryKeyword: "notebooklm vs chatgpt",
    keywordVariant: "grounded ai",
    relatedPaths: ["/blogs/notebooklm-alternatives", "/blogs/best-ai-for-research", "/blogs/grounded-ai-for-writers"],
    mission: {
      question: "Should I use NotebookLM or ChatGPT for research?",
      answer:
        "Use ChatGPT to brainstorm, explain and draft ideas, and a grounded tool like NotebookLM (or Notestack for your own writing) when accuracy matters. Grounded AI answers only from your sources and cites them, so you can check every claim.",
    },
    sections: [
      {
        heading: "The real difference is grounding",
        paragraphs: [
          "ChatGPT answers from patterns in its training data, plus web search when enabled. NotebookLM answers from the sources you upload and cites them. Both use large language models; they differ in what they are allowed to rely on.",
          "Grounded AI means the model can only use a defined set of sources and must point to where each claim came from. That constraint is what makes it useful for research.",
        ],
        callout: "An ungrounded answer asks for your trust. A grounded one shows its work.",
      },
      {
        heading: "Where ChatGPT wins",
        paragraphs: [
          "ChatGPT is the better thinking partner when you do not have sources yet. It explains unfamiliar concepts, suggests angles, drafts outlines and argues the other side.",
          "Use it early and loosely. Anything factual that survives into your final draft should be checked against a real source.",
        ],
        bullets: ["Brainstorming and outlining", "Explaining concepts you are new to", "Stress testing an argument"],
      },
      {
        heading: "Where NotebookLM wins",
        paragraphs: [
          "Once you have sources, NotebookLM is safer. Its answers stay inside your documents, it cites them, and features like audio overviews help you absorb long material.",
          "Its limits are about workflow. You upload documents one at a time, citations point to passages but not always the exact lines, and there is no built in way to publish what you learn.",
        ],
      },
      {
        heading: "What writers need that neither does",
        paragraphs: [
          "If your main source is your own archive, you need a notebook that syncs your publication, keeps each post intact and cites the exact lines. That is the gap Notestack fills as the ultimate [NotebookLM alternative for writers](/notebooklm-alternative), and our list of [NotebookLM alternatives](/blogs/notebooklm-alternatives) covers the other options.",
          "Writers also need to ship. Turn a PDF or report into a narrated explainer with [PDF2Video](https://pdf2vid.com), or turn a post into video with [Blog2Video](https://blog2video.app), so the research ends up in front of people.",
        ],
      },
      {
        heading: "How to use them together",
        paragraphs: ["The strongest workflow uses both, in order."],
        bullets: [
          "Explore with ChatGPT until you know what to look for",
          "Collect sources and move them into a grounded notebook",
          "Ask the notebook for claims with citations",
          "Write your argument yourself, checking each claim against its source",
        ],
      },
    ],
    faq: [
      {
        question: "Is NotebookLM better than ChatGPT?",
        answer:
          "For questions about your own documents, yes, because it answers only from them and cites them. For open ended thinking and explanation, ChatGPT is more flexible.",
      },
      {
        question: "What is grounded AI?",
        answer:
          "Grounded AI answers only from a defined set of sources and points to where each claim came from, so you can verify it instead of taking it on trust.",
      },
      {
        question: "Does ChatGPT cite its sources?",
        answer:
          "With web search on, it links to pages. Without it, it answers from training data and cannot point to a specific source for each claim.",
      },
      {
        question: "What is the best alternative to both for writers?",
        answer:
          "Notestack, the ultimate NotebookLM alternative for writers: a grounded notebook built from your own blog, newsletter, site or markdown that cites exact lines and turns answers into audio, video and posts.",
      },
    ],
    distributionPlan: [
      { channel: "x", angle: "NotebookLM vs ChatGPT in one line: grounding" },
      { channel: "linkedin", angle: "When to use a thinking partner vs a grounded notebook" },
    ],
  },
  {
    slug: "ai-second-brain-for-writers",
    title: "An AI Second Brain for Writers: Turn Your Archive Into a Thinking Partner",
    description:
      "An AI second brain is only as good as what goes in and how it answers. For writers, the best second brain is your own archive, searchable, cited and ready to reuse.",
    category: "Writing",
    publishedAt: "2026-09-23",
    readTime: "7 min read",
    heroEyebrow: "AI second brain",
    heroTitle: "You already built a second brain",
    heroDescription:
      "Every post you published is a note you took in public. An AI notebook over that archive becomes the second brain most writers spend years trying to build.",
    primaryKeyword: "ai second brain",
    keywordVariant: "ai notebook",
    relatedPaths: ["/blogs/ai-tools-for-writers", "/blogs/notebooklm-alternatives", "/blogs/grounded-ai-for-writers"],
    mission: {
      question: "What is the best way to build an AI second brain as a writer?",
      answer:
        "Start with what you have already published. Connect your archive to an AI notebook that answers with citations, maps your recurring topics and resurfaces old posts. Your writing becomes a second brain you can question, instead of a folder of notes you never reopen.",
    },
    sections: [
      {
        heading: "Why most second brains end up abandoned",
        paragraphs: [
          "The classic second brain asks you to capture everything, tag it and review it. Most systems die at the review step: notes go in and never come back out.",
          "AI changes the retrieval side. You no longer need perfect tags if you can ask a question and get the relevant notes back, with the exact passages cited.",
        ],
        callout: "A second brain is only useful if it talks back.",
      },
      {
        heading: "Your archive is the best notes you ever took",
        paragraphs: [
          "Private notes are fragments. Published posts are finished thoughts: argued, edited and dated. For a writer, that archive is the most valuable dataset you own.",
          "Connecting it to an AI notebook lets you ask what you think about something and get an answer drawn from years of your own writing, with links to the lines you wrote.",
        ],
      },
      {
        heading: "What a good AI second brain does",
        paragraphs: ["Look for these capabilities, whatever tool you choose."],
        bullets: [
          "**Cites exact passages** so you can check the context",
          "**Maps topics** so you see the themes you return to",
          "**Surfaces dormant ideas** worth revisiting",
          "**Remembers the conversation** so follow up questions work",
          "**Stays yours**: no training on your content without opt in",
        ],
      },
      {
        heading: "From remembering to publishing",
        paragraphs: [
          "The payoff comes when the second brain feeds new work. Resurface an evergreen post, turn it into a Launch Kit, or turn it into video with [Blog2Video](https://blog2video.app). Old ideas find new readers without you starting from a blank page.",
          "Discovery matters too. Listing your publication on [BlogHub](https://bloghub.app) puts the archive you are mining in front of readers who are looking for new blogs and newsletters.",
        ],
      },
      {
        heading: "Setting one up in ten minutes",
        paragraphs: [
          "Paste your blog, newsletter or site URL into Notestack (the ultimate [NotebookLM alternative](/notebooklm-alternative) for writers), or upload your markdown, and let it index your posts. Ask it what you have written about your favourite topic, open the topic map, and check which ideas you have not touched in a year.",
          "If you keep PDFs, research papers or slides alongside your writing, [PDF2Video](https://pdf2vid.com) can turn the best of them into narrated videos, so your second brain produces as well as remembers.",
        ],
      },
    ],
    faq: [
      {
        question: "What is an AI second brain?",
        answer:
          "A personal knowledge base that you can question in plain language, with an AI that finds and cites the relevant notes instead of you searching and tagging by hand.",
      },
      {
        question: "Is Notion or Obsidian a good AI second brain?",
        answer:
          "Both work for private notes, especially with AI plugins. For writers, a notebook built from your published archive is often more useful, because those posts are finished thoughts.",
      },
      {
        question: "What is the difference between an AI notebook and a chatbot?",
        answer:
          "A chatbot answers from general knowledge. An AI notebook answers from your own sources and cites them, which is what makes it a second brain rather than a search engine.",
      },
      {
        question: "Can I turn my notes into videos?",
        answer:
          "Yes. Use [Blog2Video](https://blog2video.app) for posts and URLs, or [PDF2Video](https://pdf2vid.com) for PDFs and documents.",
      },
    ],
    distributionPlan: [
      { channel: "substack_notes", angle: "Your archive is the second brain you already built" },
      { channel: "x", angle: "Thread: why second brains die at the review step, and how AI fixes it" },
      { channel: "linkedin", angle: "Published posts are finished thoughts: the best dataset a writer owns" },
    ],
  },
];

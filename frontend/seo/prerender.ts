import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import { blogPosts } from "../src/content/blogPosts";
import { NOTEBOOKLM_ALT_FAQ, NOTEBOOKLM_ALT_META, NOTEBOOKLM_ALT_ROWS } from "../src/content/notebooklmAlternative";
import type { BlogPost } from "../src/content/seoTypes";
import { tools, toolsHub, type ToolDef } from "../src/content/tools";

/**
 * Writes a static HTML file per public route after `vite build`, so crawlers that do not run JavaScript still get the
 * page's title, description, canonical, headings, copy and links. The React app replaces #root on load.
 *
 * Files are written as <route>.html, not <route>/index.html: Cloudflare Pages serves /blogs/x from blogs/x.html with no
 * redirect, while a folder index would 308 to /blogs/x/ and fight the canonical (which has no trailing slash).
 */

type Rendered = { path: string; title: string; description: string; body: string; jsonLd?: object[]; ogType?: string };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Post copy supports [text](url) links and **bold**; render them as real anchors. */
const inline = (text: string) =>
  esc(text)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => `<a href="${href}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

const plain = (text: string) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");

const faqLd = (items: { q: string; a: string }[]) => ({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: items.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: plain(f.a) } })),
});

const faqHtml = (items: { q: string; a: string }[]) =>
  items.length
    ? `<section><h2>Questions</h2>${items.map((f) => `<h3>${esc(f.q)}</h3><p>${inline(f.a)}</p>`).join("")}</section>`
    : "";

const nav = () =>
  `<header><nav aria-label="Main"><a href="/">Notestack</a> <a href="/notebooklm-alternative">Notestack vs NotebookLM</a> <a href="/tools">Free tools</a> <a href="/pricing">Pricing</a> <a href="/blogs">Blog</a></nav></header>`;

const footer = () =>
  `<footer><nav aria-label="Footer"><h2>Free tools</h2><ul>${tools
    .map((t) => `<li><a href="/tools/${t.slug}">${esc(t.heroTitle)}</a></li>`)
    .join("")}</ul><h2>Company</h2><ul><li><a href="/support">Support</a></li><li><a href="/privacy">Privacy</a></li><li><a href="/terms">Terms</a></li></ul><h2>More from Firebird Technologies</h2><ul><li><a href="https://blog2video.app">Blog2Video: blog to video</a></li><li><a href="https://pdf2vid.com">PDF2Video: PDF to video</a></li><li><a href="https://bloghub.app">BlogHub: blog and newsletter directory</a></li></ul></nav><p>&copy; Firebird Technologies</p></footer>`;

const page = (main: string) => `${nav()}<main>${main}</main>${footer()}`;

function pathTitle(p: string) {
  const post = blogPosts.find((b) => `/blogs/${b.slug}` === p);
  if (post) return post.title;
  const tool = tools.find((t) => `/tools/${t.slug}` === p);
  if (tool) return tool.heroTitle;
  if (p === "/notebooklm-alternative") return "Notestack vs NotebookLM";
  return p;
}

function renderPost(post: BlogPost): Rendered {
  const sections = post.sections
    .map(
      (s) =>
        `<section><h2>${esc(s.heading)}</h2>${s.paragraphs.map((p) => `<p>${inline(p)}</p>`).join("")}${
          s.bullets?.length ? `<ul>${s.bullets.map((b) => `<li>${inline(b)}</li>`).join("")}</ul>` : ""
        }${s.callout ? `<p>${inline(s.callout)}</p>` : ""}</section>`,
    )
    .join("");
  const mission = post.mission ? `<p><strong>${esc(post.mission.question)}</strong> ${inline(post.mission.answer)}</p>` : "";
  const related = post.relatedPaths.length
    ? `<nav aria-label="Related"><h2>Related</h2><ul>${post.relatedPaths
        .map((p) => `<li><a href="${p}">${esc(pathTitle(p))}</a></li>`)
        .join("")}</ul></nav>`
    : "";
  const faq = post.faq.map((f) => ({ q: f.question, a: f.answer }));
  return {
    path: `/blogs/${post.slug}`,
    title: `${post.title} | Notestack`,
    description: post.description,
    ogType: "article",
    body: page(
      `<article><p>${esc(post.heroEyebrow)}</p><h1>${esc(post.title)}</h1><p>${esc(post.heroDescription)}</p><time datetime="${post.publishedAt}">${post.publishedAt}</time>${mission}${sections}${faqHtml(faq)}</article>${related}`,
    ),
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: post.title,
        description: post.description,
        datePublished: post.publishedAt,
        author: { "@type": "Organization", name: "Notestack" },
        publisher: { "@type": "Organization", name: "Firebird Technologies" },
      },
      ...(faq.length ? [faqLd(faq)] : []),
    ],
  };
}

function renderTool(tool: ToolDef): Rendered {
  const faq = tool.faq.map((f) => ({ q: f.question, a: f.answer }));
  const sections = tool.sections
    .map(
      (s) =>
        `<section><h2>${esc(s.heading)}</h2>${s.paragraphs.map((p) => `<p>${inline(p)}</p>`).join("")}${
          s.bullets?.length ? `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""
        }</section>`,
    )
    .join("");
  const next = encodeURIComponent(`/tools/${tool.slug}`);
  return {
    path: `/tools/${tool.slug}`,
    title: tool.metaTitle,
    description: tool.description,
    body: page(
      `<article><p>${esc(tool.eyebrow)}</p><h1>${esc(tool.heroTitle)}</h1><p>${esc(tool.heroDescription)}</p><p><a href="/auth?mode=signup&amp;next=${next}">Sign up free to use the ${esc(
        tool.eyebrow.toLowerCase(),
      )}</a></p>${sections}${faqHtml(faq)}</article><nav aria-label="Related"><h2>Keep exploring</h2><ul>${tool.relatedPaths
        .map((p) => `<li><a href="${p}">${esc(pathTitle(p))}</a></li>`)
        .join("")}</ul></nav>`,
    ),
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: tool.heroTitle,
        applicationCategory: "MultimediaApplication",
        operatingSystem: "Web",
        description: tool.description,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@type": "Organization", name: "Notestack" },
      },
      faqLd(faq),
    ],
  };
}

function routes(): Rendered[] {
  const posts = [...blogPosts].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const altFaq = NOTEBOOKLM_ALT_FAQ.map((f) => ({ q: f.q, a: f.a }));
  return [
    {
      path: "/",
      title: "Notestack: your knowledge, in orbit | NotebookLM alternative for writers",
      description:
        "Notestack turns any blog, newsletter, site or markdown files into a grounded research notebook, audio overviews, videos and a launch kit, all in your own voice.",
      body: page(
        `<h1>Your knowledge, in orbit.</h1><p>Notestack turns your blog, newsletter, site or markdown files into a research notebook you can question, podcasts you can publish and launch kits for every platform. Every word traced back to what you actually wrote.</p><p><a href="/auth?mode=signup">Start free</a> or see <a href="/notebooklm-alternative">Notestack vs NotebookLM</a>.</p><h2>Free tools</h2><ul>${tools
          .map((t) => `<li><a href="/tools/${t.slug}">${esc(t.heroTitle)}</a>: ${esc(t.description)}</li>`)
          .join("")}</ul><h2>Field notes</h2><ul>${posts
          .map((p) => `<li><a href="/blogs/${p.slug}">${esc(p.title)}</a></li>`)
          .join("")}</ul>`,
      ),
      jsonLd: [
        {
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "Notestack",
          applicationCategory: "BusinessApplication",
          operatingSystem: "Web",
          description: "Notestack vs NotebookLM for writers: a grounded research notebook built from your own archive.",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          publisher: { "@type": "Organization", name: "Firebird Technologies" },
        },
      ],
    },
    {
      path: "/notebooklm-alternative",
      title: NOTEBOOKLM_ALT_META.title,
      description: NOTEBOOKLM_ALT_META.description,
      body: page(
        `<article><p>Notestack vs NotebookLM</p><h1>Notestack vs NotebookLM: which fits a writer's archive?</h1><p>NotebookLM is great for a pile of documents. Notestack is built for a body of work: it syncs your blog, newsletter, site or markdown, answers with citations to the exact lines you wrote, and turns your knowledge into audio, video and launch posts.</p><p><a href="/auth?mode=signup">Start free</a></p><section><h2>Notestack vs NotebookLM</h2><table><thead><tr><th></th><th>Notestack</th><th>NotebookLM</th></tr></thead><tbody>${NOTEBOOKLM_ALT_ROWS.map(
          (r) => `<tr><th>${esc(r.feature)}</th><td>${esc(r.notestack)}</td><td>${esc(r.notebooklm)}</td></tr>`,
        ).join("")}</tbody></table></section><section><h2>When NotebookLM is still the right call</h2><p>If you are studying someone else's documents for a one off project, want a free tool from Google, or live in Google Drive, NotebookLM is excellent. Notestack is the better fit when the sources are your own writing and the goal is to reuse and publish it.</p></section><section><h2>Pair it with the right publishing tool</h2><ul><li><a href="https://blog2video.app/blog-to-video">Blog2Video</a>: turn blog posts, URLs and scripts into finished videos.</li><li><a href="https://pdf2vid.com">PDF2Video</a>: turn any PDF, report, paper or deck into a narrated video.</li><li><a href="https://bloghub.app/submit-your-newsletter">BlogHub</a>: list your blog or newsletter in a free directory.</li></ul></section>${faqHtml(
          altFaq,
        )}<p>Comparing more tools? Read our guide to <a href="/blogs/notebooklm-alternatives">NotebookLM alternatives</a> and <a href="/blogs/notebooklm-vs-chatgpt">NotebookLM vs ChatGPT</a>.</p></article>`,
      ),
      jsonLd: [faqLd(altFaq)],
    },
    {
      path: "/pricing",
      title: "Pricing | Notestack",
      description:
        "Notestack pricing: Free ($0), Writer ($24.99 a month, $18.99 billed annually) and Studio ($48.99 a month, $36.99 billed annually). Annual billing saves 24%.",
      body: page(
        `<h1>Pick your trajectory</h1><ul><li><h2>Free</h2><p>$0. 1 source, your latest 5 posts indexed, 3 audio minutes, 1 video minute, 2 Launch Kits a month.</p></li><li><h2>Writer</h2><p>$24.99 a month ($18.99 a month billed annually). 3 sources, 500 posts, 60 audio minutes, 30 video minutes, 50 Launch Kits.</p></li><li><h2>Studio</h2><p>$48.99 a month ($36.99 a month billed annually). 10 sources, 5,000 posts, 240 audio minutes, 120 video minutes, unlimited Launch Kits.</p></li></ul><p><a href="/auth?mode=signup">Start free</a></p>`,
      ),
    },
    {
      path: "/blogs",
      title: "Blog | Notestack",
      description: "Field notes on research, deep writing and turning your archive into audio, video and launches.",
      body: page(
        `<h1>Every post is a search for an answer</h1>${posts
          .map(
            (p) =>
              `<article><h2><a href="/blogs/${p.slug}">${esc(p.title)}</a></h2><p>${esc(p.description)}</p><time datetime="${p.publishedAt}">${p.publishedAt}</time></article>`,
          )
          .join("")}`,
      ),
    },
    {
      path: "/tools",
      title: toolsHub.metaTitle,
      description: toolsHub.description,
      body: page(
        `<h1>${esc(toolsHub.heroTitle)}</h1><p>${esc(toolsHub.heroDescription)}</p><ul>${tools
          .map((t) => `<li><h2><a href="/tools/${t.slug}">${esc(t.heroTitle)}</a></h2><p>${esc(t.description)}</p></li>`)
          .join("")}</ul>`,
      ),
    },
    {
      path: "/privacy",
      title: "Privacy policy | Notestack",
      description: "Learn how Notestack collects, uses, and protects your personal information.",
      body: page(
        `<article><p>Your data</p><h1>Privacy policy</h1><p>Effective October 14, 2026</p><section><h2>1. Introduction</h2><p>Firebird Technologies operates Notestack at notestack.ai. This Privacy Policy explains how we collect, use, disclose, and protect information when you use the Service.</p></section><section><h2>2. Information we collect</h2><p>We collect account information, User Content, connection and usage data, and subscription status. If you sign in with Google, we may receive your Google profile image. If you use voice cloning, we process your consent and voice sample. Payment processors handle full card details.</p></section><section><h2>3. How we use your information</h2><p>We use information to provide and improve the Service, process sources and requested outputs, operate authorised connected apps and MCP access, manage subscriptions, communicate with you, respond to support, prevent abuse, analyse usage, and comply with law.</p></section><section><h2>4. Third-party services</h2><p>We use identity, payment, cloud, AI, speech, web-import, media, analytics, email, and connected-app providers. They receive only the information needed for their functions. We do not sell personal data or use workspace content for model training unless you enable the training opt-in setting.</p></section><section><h2>5. Data retention</h2><p>We keep account information and User Content while your account is active or as needed to provide the Service. Some information may remain for legal, security, billing, dispute, or backup purposes. Unfinished uploads and verification records are normally removed after one day. MCP access tokens normally expire after one hour and refresh access after 30 days.</p></section><section><h2>6. Data security</h2><p>We use reasonable technical and organisational safeguards, but no internet service can guarantee absolute security.</p></section><section><h2>7. Your rights</h2><p>Depending on your location, you may have rights to access, correct, delete, restrict, object to processing, or receive a portable copy of your data. You can manage supported choices in Settings.</p></section><section><h2>8. Cookies</h2><p>We use cookies and browser storage for sign-in, preferences, temporary workflow state, and usage analysis. Disabling them may affect the Service.</p></section><section><h2>9. Children's privacy</h2><p>The Service is not directed to children under 18, and we do not knowingly collect their personal information.</p></section><section><h2>10. Changes to this policy</h2><p>We may update this Policy and notify you by changing the date above or emailing your registered address.</p></section><section><h2>11. Contact us</h2><p>Questions can be sent to <a href="mailto:arslan@firebird-technologies.com">arslan@firebird-technologies.com</a>.</p></section></article>`,
      ),
    },
    {
      path: "/terms",
      title: "Terms of service | Notestack",
      description: "Read the Terms of Service for Notestack, the AI research and content workspace by Firebird Technologies.",
      body: page(
        `<article><p>Using Notestack</p><h1>Terms of service</h1><p>Effective October 14, 2026</p><section><h2>1. Agreement to terms</h2><p>By accessing or using Notestack at notestack.ai, you agree to these Terms. The Service is operated by Firebird Technologies. If you do not agree, do not use the Service.</p></section><section><h2>2. Description of service</h2><p>Notestack is an AI-powered research and content workspace for importing and organising sources, using notebooks, asking questions, and creating reports, podcasts, presentations, videos, mind maps, and other outputs. Features may include connected apps, publishing tools, and MCP access.</p></section><section><h2>3. Accounts</h2><p>You must be at least 18, keep your credentials confidential, provide accurate information, and accept responsibility for activity under your account.</p></section><section><h2>4. Subscriptions and payment</h2><p>Paid subscriptions renew automatically unless cancelled before renewal. Fees are non-refundable except where required by law or stated in our refund policy. Pricing may change with reasonable notice.</p></section><section><h2>5. Your content</h2><p>You retain ownership of User Content and grant us a limited licence to process, store, and transform it to provide the Service and as allowed by your privacy choices. You must have all necessary rights and informed consent for any voice sample submitted for cloning.</p></section><section><h2>6. AI-generated output</h2><p>You are responsible for reviewing AI-generated output before relying on, publishing, or distributing it. We do not guarantee its accuracy, completeness, originality, or fitness for a particular purpose. Connected services have their own terms.</p></section><section><h2>7. Prohibited uses</h2><p>You may not infringe rights, create harmful or unlawful content, clone a voice without consent, access another account, bypass limits, exploit the Service, transmit malware, or violate applicable law.</p></section><section><h2>8. Intellectual property</h2><p>The Service, including its design, code, trademarks, and content we create, belongs to Firebird Technologies and is protected by applicable law.</p></section><section><h2>9. Termination</h2><p>We may suspend or terminate access for violation of these Terms or at our discretion. You may terminate your account through Settings or by contacting us.</p></section><section><h2>10. Disclaimers</h2><p>The Service is provided as is and as available without warranties of any kind to the extent permitted by law.</p></section><section><h2>11. Limitation of liability</h2><p>To the maximum extent permitted by law, Firebird Technologies is not liable for indirect, incidental, special, consequential, or punitive damages. Aggregate liability will not exceed amounts paid in the three months preceding the claim.</p></section><section><h2>12. Changes to terms</h2><p>We may update these Terms and notify you by changing the date above or emailing your registered address. Continued use constitutes acceptance.</p></section><section><h2>13. Governing law</h2><p>These Terms are governed by applicable law, and disputes shall be resolved in the competent courts where Firebird Technologies operates.</p></section><section><h2>14. Contact</h2><p>Questions can be sent to <a href="mailto:arslan@firebird-technologies.com">arslan@firebird-technologies.com</a>. Read the <a href="/privacy">privacy policy</a>.</p></section></article>`,
      ),
    },
    {
      path: "/support",
      title: "Support | Notestack",
      description: "Get help with your Notestack account, subscription, integrations, or content.",
      body: page(
        `<article><p>Help center</p><h1>Support</h1><p>For help with your account, subscription, sources, generated content, or the Notestack MCP connection, email <a href="mailto:arslan@firebird-technologies.com">arslan@firebird-technologies.com</a>.</p><section><h2>Include these details</h2><ul><li>The email address on your account.</li><li>What happened and what you expected.</li><li>The page or integration you were using.</li><li>A screenshot or exact error with secrets and private content removed.</li></ul><p>Never send passwords, payment-card numbers, API keys, or access tokens by email.</p></section><section><h2>Privacy and account requests</h2><p>You can revoke apps, manage privacy choices, and delete your account from Settings. Read our <a href="/privacy">privacy policy</a> or <a href="/terms">terms of service</a>.</p></section></article>`,
      ),
    },
    ...tools.map(renderTool),
    ...posts.filter((p) => !p.canonicalPath).map(renderPost),
  ];
}

/** Strips the head tags this plugin owns, so every route gets exactly one of each. */
function sanitize(template: string) {
  return template
    .replace(/<title>[\s\S]*?<\/title>\s*/gi, "")
    .replace(/<meta\s+name="description"[^>]*>\s*/gi, "")
    .replace(/<meta\s+property="og:(title|description|url|type)"[^>]*>\s*/gi, "")
    .replace(/<meta\s+name="twitter:(title|description)"[^>]*>\s*/gi, "")
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, "");
}

function head(r: Rendered, origin: string) {
  const url = `${origin}${r.path === "/" ? "/" : r.path}`;
  const tags = [
    `<title>${esc(r.title)}</title>`,
    `<meta name="description" content="${esc(r.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="${r.ogType ?? "website"}" />`,
    `<meta property="og:title" content="${esc(r.title)}" />`,
    `<meta property="og:description" content="${esc(r.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta name="twitter:title" content="${esc(r.title)}" />`,
    `<meta name="twitter:description" content="${esc(r.description)}" />`,
    ...(r.jsonLd ?? []).map((ld) => `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>`),
  ];
  return tags.join("\n    ");
}

/**
 * The static copy is for crawlers and screen readers, not for people: until the app's JS and CSS load it would flash
 * as an unstyled page of links. Keep it in the document but visually hidden (not display:none, which some crawlers
 * skip), and paint the app's black background from the first frame. React's createRoot replaces it on load.
 */
const STATIC_STYLE =
  "<style>html,body{background:#000;color:#fff;margin:0}" +
  ".seo-static{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;" +
  "clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}</style>";

export function prerenderPlugin(siteUrl: string): Plugin {
  const origin = siteUrl.replace(/\/+$/, "");
  let config: ResolvedConfig;
  return {
    name: "notestack-prerender",
    apply: "build",
    configResolved(c) {
      config = c;
    },
    async closeBundle() {
      const outDir = path.resolve(config.root, config.build.outDir);
      const template = sanitize(await readFile(path.join(outDir, "index.html"), "utf8"));
      const all = routes();
      for (const r of all) {
        const html = template
          .replace("</head>", `    ${head(r, origin)}\n    ${STATIC_STYLE}\n  </head>`)
          .replace('<div id="root"></div>', `<div id="root"><div class="seo-static">${r.body}</div></div>`);
        const file = r.path === "/" ? path.join(outDir, "index.html") : path.join(outDir, `${r.path.slice(1)}.html`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, html, "utf8");
      }
      // Signed in and unknown routes fall back to an app shell with no page content (see public/_redirects).
      await writeFile(path.join(outDir, "app.html"), template.replace("</head>", `    <meta name="robots" content="noindex" />\n    <title>Notestack</title>\n    ${STATIC_STYLE}\n  </head>`), "utf8");
      config.logger.info(`prerendered ${all.length} public routes`);
    },
  };
}

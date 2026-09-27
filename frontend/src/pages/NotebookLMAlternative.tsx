import { Link } from "react-router-dom";
import SkyCanvas from "../components/SkyCanvas";
import { PublicFooter, PublicNav } from "../components/PublicChrome";
import { useMeta } from "./Blog";
import "../styles/blog.css";

/** SEO landing page: "notebooklm alternative" (590 searches/mo in the US, keyword difficulty 0, Sep 2026). */

const ROWS: { feature: string; notestack: string; notebooklm: string }[] = [
  {
    feature: "Getting your writing in",
    notestack: "Syncs any blog, newsletter or site feed (Substack, Ghost, WordPress, Medium, RSS), plus markdown, text, HTML and PDF uploads",
    notebooklm: "Add sources one at a time: PDFs, Docs, web pages, videos",
  },
  {
    feature: "Stays in sync",
    notestack: "New posts arrive automatically on every sync",
    notebooklm: "Re-add sources by hand when they change",
  },
  {
    feature: "Citations",
    notestack: "Exact line ranges, read back and verified before you see them",
    notebooklm: "Passage level citations to the source",
  },
  {
    feature: "When the answer is not in your sources",
    notestack: "Says so instead of guessing; unverifiable claims are dropped",
    notebooklm: "Grounded in sources, with passage citations",
  },
  {
    feature: "Chat memory",
    notestack: "Follow ups resolved from the conversation; off topic questions answered instantly",
    notebooklm: "Conversation within a notebook",
  },
  {
    feature: "Audio overviews",
    notestack: "Two hosts, ElevenLabs voices, delivery controls, or your own consented voice clone",
    notebooklm: "Two host audio overviews with Google voices",
  },
  {
    feature: "Video",
    notestack: "9:16 shorts, 16:9 explainers and 1:1 audiograms with captions and your brand",
    notebooklm: "Video overviews",
  },
  {
    feature: "Publishing",
    notestack: "Launch Kits (threads, LinkedIn, Notes, Bluesky, SEO, carousels, quote cards) and a scheduling calendar",
    notebooklm: "Not a publishing tool",
  },
  {
    feature: "Your voice",
    notestack: "Voice profile learned from your posts, used for every draft",
    notebooklm: "General purpose writing",
  },
  {
    feature: "Seeing your archive",
    notestack: "Topic map with rising and dormant topics, plus evergreen resurfacing",
    notebooklm: "Mind maps per notebook",
  },
];

const FAQ = [
  {
    q: "What is the best NotebookLM alternative?",
    a: "For writers, bloggers and newsletters, Notestack is the ultimate NotebookLM alternative: it syncs your whole archive, cites the exact lines behind every answer, and turns what you wrote into audio, video and launch posts. For academic papers, discovery tools like Elicit or Consensus pair well with it.",
  },
  {
    q: "Is Notestack free?",
    a: "Yes, there is a free plan to try it on your latest posts. Paid plans add more sources, more posts, more audio and video minutes and voice cloning.",
  },
  {
    q: "Can Notestack make NotebookLM style audio overviews?",
    a: "Yes. It writes a two host conversation grounded in your posts and voices it with ElevenLabs, with every line tied to the passage it came from. You can choose the voices or clone your own with consent.",
  },
  {
    q: "What if my writing is not on Substack?",
    a: "Notestack works with any blog, newsletter or site that has a feed, single article URLs, and uploaded markdown, text, HTML or PDF files.",
  },
];

export default function NotebookLMAlternative() {
  useMeta(
    "The Ultimate NotebookLM Alternative for Writers | Notestack",
    "Notestack is the ultimate NotebookLM alternative for writers, bloggers and newsletters: sync your archive, get answers cited to the exact line, and turn your writing into audio, video and launch posts.",
  );
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  const appLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Notestack",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description: "The ultimate NotebookLM alternative for writers: a grounded research notebook built from your own archive.",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };

  return (
    <div className="page">
      <SkyCanvas intensity={0.7} travel />
      <PublicNav />
      <main className="container post mission alt-page">
        <script type="application/ld+json">{JSON.stringify(faqLd)}</script>
        <script type="application/ld+json">{JSON.stringify(appLd)}</script>

        <header className="mission-head">
          <p className="eyebrow">NotebookLM alternative</p>
          <div className="transmission incoming">
            <span className="mono tx-label">Incoming query</span>
            <p className="tx-query">Is there a NotebookLM built for my own writing?</p>
          </div>
          <h1 className="post-title">The ultimate NotebookLM alternative for writers</h1>
          <p className="post-lede muted">
            NotebookLM is great for a pile of documents. Notestack is built for a body of work: it syncs your blog, newsletter, site or
            markdown, answers with citations to the exact lines you wrote, and turns your knowledge into audio, video and launch posts.
          </p>
          <div className="alt-ctas">
            <Link to="/auth?mode=signup" className="btn btn-primary">
              Start free
            </Link>
            <a href="#compare" className="btn">
              See the comparison
            </a>
          </div>
        </header>

        <section className="alt-section">
          <p className="mono waypoint-label">Why writers switch</p>
          <h2>Your archive is not a stack of uploads</h2>
          <div className="alt-grid">
            <div className="card">
              <h3>It already knows your work</h3>
              <p className="muted">
                Paste your address once. Every post comes in, stays in sync, and keeps its date, so you can ask how your thinking changed
                over the years.
              </p>
            </div>
            <div className="card">
              <h3>Every sentence, traceable</h3>
              <p className="muted">
                Answers cite line ranges that are read back from your files before you see them. If the posts do not support it, Notestack
                says so.
              </p>
            </div>
            <div className="card">
              <h3>From research to launch</h3>
              <p className="muted">
                The same grounded archive writes audio overviews, videos, threads, LinkedIn posts, Notes and SEO packs, in your voice, and
                schedules them.
              </p>
            </div>
          </div>
        </section>

        <section id="compare" className="alt-section">
          <p className="mono waypoint-label">Side by side</p>
          <h2>Notestack vs NotebookLM</h2>
          <div className="md-table alt-table">
            <table>
              <thead>
                <tr>
                  <th scope="col"> </th>
                  <th scope="col">Notestack</th>
                  <th scope="col">NotebookLM</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.feature}>
                    <th scope="row">{r.feature}</th>
                    <td>{r.notestack}</td>
                    <td className="muted">{r.notebooklm}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">NotebookLM details reflect its public product at the time of writing and may change.</p>
        </section>

        <section className="alt-section">
          <p className="mono waypoint-label">Honest take</p>
          <h2>When NotebookLM is still the right call</h2>
          <p className="muted">
            If you are studying someone else's documents for a one off project, want a free tool from Google, or live in Google Drive,
            NotebookLM is excellent. Notestack is the ultimate NotebookLM alternative when the sources are your own writing and the goal is
            to reuse and publish it.
          </p>
        </section>

        <section className="alt-section">
          <p className="mono waypoint-label">The rest of the fleet</p>
          <h2>Pair it with the right publishing tool</h2>
          <div className="alt-grid">
            <a className="card alt-sister" href="https://blog2video.app" target="_blank" rel="noopener">
              <h3>Blog2Video</h3>
              <p className="muted">Turn blog posts, URLs, PDFs and scripts into finished videos without an editor.</p>
              <span className="mono small-link">blog2video.app</span>
            </a>
            <a className="card alt-sister" href="https://pdf2vid.com" target="_blank" rel="noopener">
              <h3>PDF2Video</h3>
              <p className="muted">Turn any PDF, report, paper or deck into a narrated video.</p>
              <span className="mono small-link">pdf2vid.com</span>
            </a>
            <a className="card alt-sister" href="https://bloghub.app" target="_blank" rel="noopener">
              <h3>BlogHub</h3>
              <p className="muted">List your blog or newsletter in a free directory so new readers can find it.</p>
              <span className="mono small-link">bloghub.app</span>
            </a>
          </div>
        </section>

        <section className="alt-section debrief">
          <p className="mono waypoint-label">Mission debrief</p>
          <h2>Questions</h2>
          {FAQ.map((f) => (
            <details key={f.q} className="faq">
              <summary>{f.q}</summary>
              <p className="muted">{f.a}</p>
            </details>
          ))}
          <p className="muted">
            Comparing more tools? Read our full guide to <Link to="/blogs/notebooklm-alternatives">NotebookLM alternatives</Link> and{" "}
            <Link to="/blogs/notebooklm-vs-chatgpt">NotebookLM vs ChatGPT</Link>.
          </p>
        </section>

        <aside className="card post-cta">
          <h3>Put your knowledge in orbit</h3>
          <p className="muted">Connect any blog, newsletter or site, or upload markdown, and ask your first question in minutes.</p>
          <Link to="/auth?mode=signup" className="btn btn-primary">
            Start free
          </Link>
        </aside>
      </main>
      <PublicFooter />
    </div>
  );
}

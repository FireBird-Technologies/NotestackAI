import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import SkyCanvas from "../components/SkyCanvas";
import { PublicFooter, PublicNav } from "../components/PublicChrome";
import { getTool, tools, toolsHub, type ToolDef } from "../content/tools";
import { useAuth } from "../hooks/useAuth";
import { buildPodcastScript, scriptToText } from "../lib/podcastScript";
import { Inline, useMeta } from "./Blog";
import "../styles/blog.css";
import "../styles/tools.css";

const pathTitle = (path: string) => {
  const tool = tools.find((t) => `/tools/${t.slug}` === path);
  if (tool) return tool.heroTitle;
  if (path === "/notebooklm-alternative") return "Notestack vs NotebookLM";
  return path.replace(/^\/blogs\//, "").replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
};

export function ToolsHub() {
  useMeta(toolsHub.metaTitle, toolsHub.description);
  return (
    <div className="page">
      <SkyCanvas intensity={0.7} travel />
      <PublicNav />
      <main className="container post mission alt-page">
        <header className="mission-head">
          <p className="eyebrow">Free tools</p>
          <h1 className="post-title">{toolsHub.heroTitle}</h1>
          <p className="post-lede muted">{toolsHub.heroDescription}</p>
        </header>
        <div className="alt-grid">
          {tools.map((t) => (
            <Link key={t.slug} to={`/tools/${t.slug}`} className="card alt-sister">
              <h2 className="tool-card-title">{t.heroTitle}</h2>
              <p className="muted">{t.description}</p>
            </Link>
          ))}
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}

/** Every free tool requires sign in: signed out visitors see the pitch and a sign in link that returns them here. */
function SignInGate({ tool }: { tool: ToolDef }) {
  const next = encodeURIComponent(`/tools/${tool.slug}`);
  return (
    <div className="card tool-gate">
      <h2>Sign in to use the {tool.eyebrow.toLowerCase()}</h2>
      <p className="muted">It is free. Create an account in seconds and come straight back to this tool.</p>
      <div className="alt-ctas">
        <Link to={`/auth?mode=signup&next=${next}`} className="btn btn-primary">
          Sign up free
        </Link>
        <Link to={`/auth?next=${next}`} className="btn">
          Sign in
        </Link>
      </div>
    </div>
  );
}

function PodcastScriptWidget({ tool }: { tool: ToolDef }) {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const script = useMemo(() => buildPodcastScript(text), [text]);
  const inputWords = text.trim() ? text.trim().split(/\s+/).length : 0;

  const copy = async () => {
    if (!script) return;
    await navigator.clipboard.writeText(scriptToText(script));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const download = () => {
    if (!script) return;
    const url = URL.createObjectURL(new Blob([scriptToText(script)], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tool.slug}-script.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="tool-widget">
      <label className="field">
        <span>
          {tool.inputLabel} <span className="muted mono small">{inputWords} words</span>
        </span>
        <textarea
          className="input tool-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={tool.inputPlaceholder}
          rows={10}
        />
      </label>
      {tool.inputHint && (
        <p className="muted small">
          <Inline text={tool.inputHint} />
        </p>
      )}
      {text.trim() && !script && <p className="muted">Paste a little more: the script needs at least three full sentences.</p>}
      {script && (
        <div className="card tool-output">
          <div className="tool-output-head">
            <span className="mono small muted">
              {script.lines.length} lines · about {Math.max(1, Math.round(script.minutes))} min · built from {script.sourceSentences} of your
              sentences
            </span>
            <span className="tool-actions">
              <button type="button" className="btn" onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button type="button" className="btn" onClick={download}>
                Download
              </button>
            </span>
          </div>
          <ol className="tool-script">
            {script.lines.map((l, i) => (
              <li key={i} className={`host-${l.host}`}>
                <span className="mono host-label">Host {l.host}</span>
                <p>{l.text}</p>
              </li>
            ))}
          </ol>
          <div className="tool-next">
            <p className="muted">Hear it with two natural voices, grounded in your whole archive.</p>
            <Link to="/app/studio" className="btn btn-primary">
              Voice it in Studio
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export function ToolPage() {
  const { slug = "" } = useParams();
  const tool = getTool(slug);
  const { user, loading } = useAuth();
  useMeta(tool?.metaTitle ?? "Not found | Notestack", tool?.description ?? "");

  if (!tool) {
    return (
      <div className="page">
        <PublicNav />
        <main className="container section">
          <h1 className="section-title">Tool not found</h1>
          <Link to="/tools">See all free tools</Link>
        </main>
      </div>
    );
  }

  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: tool.faq.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })),
  };

  return (
    <div className="page">
      <SkyCanvas intensity={0.7} travel />
      <PublicNav />
      <main className="container post mission alt-page">
        <script type="application/ld+json">{JSON.stringify(faqLd)}</script>
        <header className="mission-head">
          <p className="eyebrow">{tool.eyebrow}</p>
          <h1 className="post-title">{tool.heroTitle}</h1>
          <p className="post-lede muted">{tool.heroDescription}</p>
        </header>

        <section className="alt-section">{loading ? null : user ? <PodcastScriptWidget tool={tool} /> : <SignInGate tool={tool} />}</section>

        {tool.sections.map((s) => (
          <section key={s.heading} className="alt-section">
            <h2>{s.heading}</h2>
            {s.paragraphs.map((p, i) => (
              <p key={i} className="muted">
                <Inline text={p} />
              </p>
            ))}
            {s.bullets && (
              <ul>
                {s.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </section>
        ))}

        <section className="alt-section debrief">
          <h2>Questions</h2>
          {tool.faq.map((f) => (
            <details key={f.question} className="faq">
              <summary>{f.question}</summary>
              <p className="muted">{f.answer}</p>
            </details>
          ))}
        </section>

        <nav className="alt-section" aria-label="Related">
          <h2>Keep exploring</h2>
          <ul>
            {tool.relatedPaths.map((p) => (
              <li key={p}>
                <Link to={p}>{pathTitle(p)}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </main>
      <PublicFooter />
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { publicApi } from "../api/endpoints";
import type { PublicInfographicData, PublicReportData } from "../api/types";
import { InfographicFrame } from "../components/Infographic";
import Logo from "../components/Logo";
import { ReportView } from "../components/ReportView";
import { Loading } from "../components/ui";

/** What a share link opens: /r/:token. Read only, no sign in, not indexed. */
export default function PublicReport() {
  const { token = "" } = useParams();
  const [shared, setShared] = useState<PublicReportData | PublicInfographicData | null>(null);
  const [missing, setMissing] = useState(false);
  const [showSources, setShowSources] = useState(false);

  useEffect(() => {
    // Shared pages stay out of search results.
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    publicApi.report(token).then(
      (r) => {
        setShared(r);
        document.title = `${r.title} | Notestack`;
      },
      () => setMissing(true),
    );
  }, [token]);

  if (missing) {
    return (
      <main className="rp-public rp-public-empty">
        <Logo />
        <h1>This link does not work</h1>
        <p className="muted">The page may have been taken down, or the link is wrong.</p>
        <Link to="/" className="btn btn-primary">Go to Notestack</Link>
      </main>
    );
  }
  if (!shared) return <main className="rp-public"><Loading label="Opening" /></main>;
  if (shared.kind === "infographic") {
    return (
      <main className="rp-public ig-public">
        <header className="rp-public-bar">
          <Link to="/" aria-label="Notestack home"><Logo /></Link>
        </header>
        <div className="rp-public-body">
          <p className="eyebrow">Infographic</p>
          <h1>{shared.title}</h1>
          <InfographicFrame html={shared.html_landscape || shared.html} title={shared.title}
                            layout={shared.html_landscape ? "landscape" : "portrait"} />
        </div>
        <footer className="rp-public-foot">
          <span className="muted">Made with</span> <Link to="/">Notestack</Link>
        </footer>
      </main>
    );
  }
  const report = shared;

  const posts = report.sources?.posts ?? [];
  return (
    <main className="rp-public">
      <header className="rp-public-bar">
        <Link to="/" aria-label="Notestack home"><Logo /></Link>
        {report.show_sources && report.sources && (
          <div className="rp-sources">
            <button type="button" className="btn btn-small" aria-expanded={showSources} onClick={() => setShowSources((o) => !o)}>
              Sources
            </button>
            {showSources && (
              <div className="rp-sources-pop" role="dialog" aria-label="Sources used for this report">
                <p className="eyebrow">Made from</p>
                {report.sources.chats > 0 && <p>{report.sources.chats} notebook chat{report.sources.chats === 1 ? "" : "s"}</p>}
                <ul>
                  {posts.map((p, i) => (
                    <li key={i}>{p.url ? <a href={p.url} target="_blank" rel="noreferrer noopener">{p.title}</a> : p.title}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </header>
      <div className="rp-public-body">
        <p className="eyebrow">{report.format === "interactive" ? "Interactive report" : "Report"}</p>
        <h1>{report.title}</h1>
        <p className="rp-meta">
          {report.created_at ? new Date(report.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : ""}
          {report.created_at && " · "}
          {report.blocks.filter((b) => b.type === "prose").length} sections
        </p>
        <ReportView
          content={{ title: report.title, blocks: report.blocks, citations: [], sources: report.sources?.posts ?? [],
                     chat_count: report.sources?.chats ?? 0 }}
          artifactId={token} />
      </div>
      <footer className="rp-public-foot">
        <span className="muted">Made with</span> <Link to="/">Notestack</Link>
      </footer>
    </main>
  );
}

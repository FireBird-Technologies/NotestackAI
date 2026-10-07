import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { NavLink } from "react-router-dom";
import { docsApi, jobsApi, sourcesApi } from "../api/endpoints";
import type { Doc, Job, Source } from "../api/types";
import { Reader } from "../components/Reader";
import { ConfirmButton, EmptyState, errorMessage, formatDate, JobProgress, Loading, PageHeader, StatusPill } from "../components/ui";
import { useJobMap } from "../hooks/useJob";
import { useUpgrade } from "../hooks/useUpgrade";

const PAGE = 50;

/** Sources and the Topic map share one sidebar entry; this strip switches between them. */
export function SourcesNav() {
  return (
    <nav className="tabs" aria-label="Sources views">
      <NavLink to="/app/sources" className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
        Posts
      </NavLink>
      <NavLink to="/app/map" className={({ isActive }) => `tab${isActive ? " active" : ""}`}>
        Topic map
      </NavLink>
    </nav>
  );
}

export const FILE_ACCEPT = ".md,.markdown,.txt,.vtt,.html,.htm,.pdf,text/vtt,text/markdown,text/plain,text/html,application/pdf";

/** A bare domain, a Substack or a feed URL is a whole archive; a deep link is one article. */
export function looksLikeArticle(raw: string): boolean {
  const v = raw.trim();
  if (!v) return false;
  try {
    const u = new URL(v.includes("://") ? v : `https://${v}`);
    const path = u.pathname.replace(/\/+$/, "");
    if (!path || /(feed|rss|atom)(\.xml)?$/i.test(path) || /^\/@[^/]+$/.test(path)) return false;
    const parts = path.split("/").filter(Boolean);
    return /\/p\/|\/posts?\/|\/\d{4}\/|\.html?$/i.test(path) || parts.length >= 2 || path.length > 24;
  } catch {
    return false;
  }
}

/** Imports each file as its own post. Returns how many failed. */
export async function importFiles(files: File[], onAdded: (source: Source, job: Job) => void): Promise<number> {
  let failed = 0;
  for (const f of files) {
    try {
      const res = await sourcesApi.importFile(f);
      onAdded(res.source, res.job);
    } catch {
      failed += 1;
    }
  }
  return failed;
}

/** One box for everything: paste a link (feed or article is worked out for you) or add files. */
export function AddSource({ onAdded }: { onAdded: (source: Source, job: Job) => void }) {
  const [value, setValue] = useState("");
  const [override, setOverride] = useState<"feed" | "url" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mode = override ?? (looksLikeArticle(value) ? "url" : "feed");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const res = mode === "feed" ? await sourcesApi.connect(value.trim()) : await sourcesApi.importUrl(value.trim());
      onAdded(res.source, res.job);
      setValue("");
      setOverride(null);
    } catch (err) {
      setError(errorMessage(err, mode === "feed" ? "We could not find a feed there." : "We could not import that page."));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setError(null);
    setBusy(true);
    const failed = await importFiles(list, onAdded);
    if (failed) setError(`${failed} of ${list.length} files could not be uploaded.`);
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="card add-source">
      <form onSubmit={submit} className="add-smart">
        <input
          className="input"
          placeholder="Paste a blog, newsletter or article link"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setOverride(null);
          }}
          aria-label="Blog, newsletter or article link"
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !value.trim()}>
          {busy ? "Working..." : mode === "feed" ? "Connect" : "Import article"}
        </button>
        <span className="muted small">or</span>
        <button type="button" className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
          Upload files
        </button>
        <input ref={fileRef} type="file" multiple accept={FILE_ACCEPT} hidden onChange={(e) => upload(e.target.files)} aria-label="Files to upload" />
      </form>
      <p className="muted small">
        {!value.trim() && "Substack, Ghost, WordPress, Medium or any site with a feed. Markdown, text, VTT transcripts, HTML and PDF files work too; drop them anywhere on this page."}
        {value.trim() && mode === "feed" && (
          <>
            We will pull in the whole archive and keep it in sync.{" "}
            <button type="button" className="link-btn small" onClick={() => setOverride("url")}>
              Just this one page instead
            </button>
          </>
        )}
        {value.trim() && mode === "url" && (
          <>
            Looks like a single article, so we will import just this page.{" "}
            <button type="button" className="link-btn small" onClick={() => setOverride("feed")}>
              Connect the whole site instead
            </button>
          </>
        )}
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default function Sources() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const { openUpgrade } = useUpgrade();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string>("");
  const [removing, setRemoving] = useState<Set<string>>(new Set()); // sources being deleted: dimmed at once, gone when done
  const [offset, setOffset] = useState(0);
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSources = useCallback(() => sourcesApi.list().then(setSources), []);
  const loadDocs = useCallback(
    (reset = true) => {
      const start = reset ? 0 : offset + PAGE;
      return docsApi.list({ q, source_id: filter || undefined, indexed_only: true, limit: PAGE, offset: start }).then((p) => {
        setTotal(p.total);
        setOffset(start);
        setDocs((d) => (reset ? p.items : [...d, ...p.items]));
      });
    },
    [q, filter, offset],
  );

  const { jobs, watch } = useJobMap(() => {
    loadSources();
    loadDocs();
  });

  useEffect(() => {
    loadSources().catch(() => setError("Could not load your sources. Refresh to try again."));
  }, [loadSources]);

  useEffect(() => {
    const t = setTimeout(() => loadDocs(true), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filter]);

  // Pick up syncs and imports that were already running when the page opened.
  useEffect(() => {
    jobsApi.active().then((active) => {
      for (const job of active) {
        if (typeof job.params.source_id === "string" && ["ingest", "import_url", "import_upload"].includes(job.kind)) {
          watch(job.params.source_id, job);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const added = (source: Source, job: Job) => {
    setSources((list) => {
      const rest = (list ?? []).filter((s) => s.id !== source.id);
      return [...rest, source];
    });
    watch(source.id, job);
  };

  const [dropping, setDropping] = useState(false);

  return (
    <div
      className={`page-wrap${dropping ? " drop-over" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={async (e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDropping(false);
        const files = Array.from(e.dataTransfer.files);
        const failed = await importFiles(files, added);
        setError(failed ? `${failed} of ${files.length} files could not be uploaded.` : null);
      }}
    >
      <SourcesNav />
      <PageHeader eyebrow="Sources" title="Your knowledge, in orbit" />
      <AddSource onAdded={added} />
      {error && <p className="error-text">{error}</p>}

      {/* Outside the card grid, so the loader is centered across the page rather than in the first column */}
      {!sources && <Loading center="page" />}
      <section className="grid-cards">
        {sources?.map((s) => {
          const job = jobs[s.id];
          const active = job && (job.status === "queued" || job.status === "running");
          return (
            <article key={s.id} className={`card source-card${removing.has(s.id) ? " removing" : ""}`}>
              <header className="row between">
                <div className="source-title">
                  <strong>{s.title ?? s.feed_url}</strong>
                  <span className="mono muted">
                    {s.is_imports ? "imports" : s.platform} · {s.document_count - s.locked_count} posts
                    {s.last_synced_at ? ` · synced ${formatDate(s.last_synced_at, true)}` : ""}
                  </span>
                </div>
                <StatusPill status={active ? "syncing" : s.sync_status} />
              </header>
              {!s.is_imports && (
                <a className="mono muted small-link" href={s.site_url ?? s.feed_url} target="_blank" rel="noreferrer">
                  {s.feed_url.replace(/^site:/, "")}
                </a>
              )}
              {job && (active || job.status === "failed") && <JobProgress job={job} compact />}
              {s.locked_count > 0 && !active && (
                <div className="welcome-cap locked-cap">
                  <div>
                    <strong>{s.locked_count} posts not indexed</strong>
                    <p className="muted small">
                      Your plan only indexes your latest posts. Upgrade to index the rest so answers, audio and Launch Kits
                      can use your whole archive.
                    </p>
                  </div>
                  <button type="button" className="btn btn-small btn-primary" onClick={() => openUpgrade("indexed_posts")}>
                    Index all {s.document_count}
                  </button>
                </div>
              )}
              {s.sync_status === "error" && s.sync_error && !active && <p className="error-text">{s.sync_error}</p>}
              <footer className="row source-actions">
                {!s.is_imports && (
                  <button
                    className="btn btn-small"
                    disabled={Boolean(active)}
                    onClick={async () => {
                      const res = await sourcesApi.sync(s.id);
                      watch(s.id, res.job);
                    }}
                  >
                    Sync now
                  </button>
                )}
                <button className="btn btn-small" onClick={() => setFilter(filter === s.id ? "" : s.id)}>
                  {filter === s.id ? "Hide posts" : "Show posts"}
                </button>
                <ConfirmButton
                  confirmLabel="Click again to delete"
                  busyLabel="Deleting..."
                  onConfirm={async () => {
                    setRemoving((r) => new Set(r).add(s.id));
                    try {
                      await sourcesApi.remove(s.id);
                    } catch (e) {
                      setRemoving((r) => {
                        const next = new Set(r);
                        next.delete(s.id);
                        return next;
                      });
                      throw e;
                    }
                    // Gone from the page now; the lists refresh behind it.
                    setSources((list) => (list ?? []).filter((x) => x.id !== s.id));
                    setDocs((list) => list.filter((d) => d.source_id !== s.id));
                    if (filter === s.id) setFilter("");
                    loadSources();
                    loadDocs();
                  }}
                >
                  Delete
                </ConfirmButton>
              </footer>
            </article>
          );
        })}
      </section>
      {sources?.length === 0 && (
        <EmptyState title="No sources yet" body="A lone satellite, waiting for signal. Connect a blog or site above, or upload your markdown files." />
      )}

      {sources && sources.length > 0 && filter && (
        <section className="card posts-table">
          <div className="row between">
            <h2>
              Posts <span className="mono muted">{total}</span>
            </h2>
            <input className="input input-sm search" placeholder="Search titles and text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search posts" />
          </div>
          <ul className="doc-list">
            {docs.map((d) => (
              <li key={d.id} className="doc-row">
                <button className="link-btn doc-title" onClick={() => setReading(d.id)}>
                  {d.title}
                </button>
                {d.locked && (
                  <span className="mono muted small" title="Upgrade to index this post">
                    Not indexed
                  </span>
                )}
                <span className="mono muted">
                  {d.source_title ?? ""} · {formatDate(d.published_at)} · {d.words} words
                </span>
              </li>
            ))}
            {docs.length === 0 && <li className="muted">No posts match.</li>}
          </ul>
          {docs.length < total && (
            <button className="btn btn-small" onClick={() => loadDocs(false)}>
              Load more
            </button>
          )}
        </section>
      )}
      {reading && <Reader documentId={reading} onClose={() => setReading(null)} />}
    </div>
  );
}

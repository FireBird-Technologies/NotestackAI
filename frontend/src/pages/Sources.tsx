import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { docsApi, jobsApi, sourcesApi } from "../api/endpoints";
import type { Doc, Job, Source } from "../api/types";
import { Reader } from "../components/Reader";
import { ConfirmButton, EmptyState, errorMessage, formatDate, JobProgress, Loading, PageHeader, StatusPill, Tabs } from "../components/ui";
import { useJobMap } from "../hooks/useJob";

type AddMode = "feed" | "url" | "file";

const PAGE = 50;

export function AddSource({ onAdded }: { onAdded: (source: Source, job: Job) => void }) {
  const [mode, setMode] = useState<AddMode>("feed");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "file") {
        const file = fileRef.current?.files?.[0];
        if (!file) throw new Error("Choose a file first.");
        const res = await sourcesApi.importFile(file);
        onAdded(res.source, res.job);
        if (fileRef.current) fileRef.current.value = "";
      } else {
        if (!value.trim()) return;
        const res = mode === "feed" ? await sourcesApi.connect(value.trim()) : await sourcesApi.importUrl(value.trim());
        onAdded(res.source, res.job);
        setValue("");
      }
    } catch (err) {
      setError(errorMessage(err, "Could not add that."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card add-source">
      <Tabs<AddMode>
        tabs={[
          { id: "feed", label: "Connect a feed" },
          { id: "url", label: "Import one URL" },
          { id: "file", label: "Upload a file" },
        ]}
        value={mode}
        onChange={(m) => {
          setMode(m);
          setError(null);
        }}
      />
      <p className="muted">
        {mode === "feed" && "Substack, Ghost, Medium, WordPress or any RSS feed. We find the feed and pull in your archive."}
        {mode === "url" && "One article from anywhere on the web. It lands in Imported posts."}
        {mode === "file" && "Markdown, text, HTML or PDF. Handy for drafts and posts that never had a feed."}
      </p>
      <form onSubmit={submit} className="inline-form">
        {mode === "file" ? (
          <input ref={fileRef} className="input file-input" type="file" accept=".md,.markdown,.txt,.html,.htm,.pdf,text/markdown,text/plain,text/html,application/pdf" aria-label="File" />
        ) : (
          <input
            className="input"
            placeholder={mode === "feed" ? "yourname.substack.com" : "https://example.com/my-essay"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={mode === "feed" ? "Feed or site URL" : "Article URL"}
          />
        )}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? (mode === "feed" ? "Finding feed..." : "Starting...") : mode === "feed" ? "Connect" : "Import"}
        </button>
      </form>
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
  const [docs, setDocs] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string>("");
  const [offset, setOffset] = useState(0);
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSources = useCallback(() => sourcesApi.list().then(setSources), []);
  const loadDocs = useCallback(
    (reset = true) => {
      const start = reset ? 0 : offset + PAGE;
      return docsApi.list({ q, source_id: filter || undefined, limit: PAGE, offset: start }).then((p) => {
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
    loadSources().catch(() => setError("Could not reach the API. Is it running?"));
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

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Sources" title="Your archive, in orbit" />
      <AddSource onAdded={added} />
      {error && <p className="error-text">{error}</p>}

      <section className="grid-cards">
        {!sources && <Loading />}
        {sources?.map((s) => {
          const job = jobs[s.id];
          const active = job && (job.status === "queued" || job.status === "running");
          return (
            <article key={s.id} className="card source-card">
              <header className="row between">
                <div className="source-title">
                  <strong>{s.title ?? s.feed_url}</strong>
                  <span className="mono muted">
                    {s.is_imports ? "imports" : s.platform} · {s.document_count} posts
                    {s.last_synced_at ? ` · synced ${formatDate(s.last_synced_at, true)}` : ""}
                  </span>
                </div>
                <StatusPill status={active ? "syncing" : s.sync_status} />
              </header>
              {!s.is_imports && (
                <a className="mono muted small-link" href={s.site_url ?? s.feed_url} target="_blank" rel="noreferrer">
                  {s.feed_url}
                </a>
              )}
              {job && (active || job.status === "failed") && <JobProgress job={job} compact />}
              {s.sync_status === "error" && s.sync_error && !active && <p className="error-text">{s.sync_error}</p>}
              <footer className="row">
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
                  {filter === s.id ? "Show all posts" : "Show posts"}
                </button>
                <ConfirmButton
                  confirmLabel={`Delete ${s.document_count} posts?`}
                  onConfirm={async () => {
                    await sourcesApi.remove(s.id);
                    if (filter === s.id) setFilter("");
                    loadSources();
                    loadDocs();
                  }}
                >
                  Remove
                </ConfirmButton>
              </footer>
            </article>
          );
        })}
      </section>
      {sources?.length === 0 && (
        <EmptyState title="No sources yet" body="A lone satellite, waiting for signal. Connect your Substack above." />
      )}

      {sources && sources.length > 0 && (
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

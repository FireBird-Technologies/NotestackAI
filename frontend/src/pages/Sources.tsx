import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { NavLink } from "react-router-dom";
import { docsApi, jobsApi, sourcesApi } from "../api/endpoints";
import type { Doc, Job, Source } from "../api/types";
import { Reader } from "../components/Reader";
import { TrashIcon } from "../components/icons/Icons";
import { SourceUrlHint, useSourceUrlCheck } from "../components/SourceUrlCheck";
import { DeleteButton, EmptyState, errorMessage, formatDate, JobProgress, Loading, PageHeader, StatusPill } from "../components/ui";
import { useJobMap } from "../hooks/useJob";
import { useUpgrade } from "../hooks/useUpgrade";

const PAGE = 50;
const PENDING_IMPORTS_ID = "pending-imports";

function pendingImports(count: number): Source {
  return {
    id: PENDING_IMPORTS_ID,
    feed_url: "imports",
    site_url: null,
    platform: "imports",
    title: "Imported posts and files",
    sync_status: "syncing",
    sync_error: null,
    last_synced_at: null,
    document_count: count,
    locked_count: 0,
    is_imports: true,
  };
}

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

/** Live counts from a running sync: posts found, fetched and indexed so far. */
function SyncStats({ job }: { job: Job }) {
  const r = job.result as { found?: number; fetched?: number; fetch_total?: number; indexed?: number; index_total?: number };
  if (job.kind !== "ingest" || !r || r.found === undefined) return null;
  const of = (done?: number, total?: number) => (total ? `${done ?? 0} / ${total}` : `${done ?? 0}`);
  return (
    <dl className="sync-stats mono" aria-label="Sync progress">
      <div>
        <dt>Found</dt>
        <dd>{r.found ?? 0}</dd>
      </div>
      <div>
        <dt>Fetched</dt>
        <dd>{of(r.fetched, r.fetch_total)}</dd>
      </div>
      <div>
        <dt>Indexed</dt>
        <dd>{of(r.indexed, r.index_total)}</dd>
      </div>
    </dl>
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
/** A file the import can read. Dropped files skip the picker's FILE_ACCEPT, so they are checked here: an image would
 *  otherwise be stored as a "post" of its raw bytes. */
export function isDocumentFile(f: File): boolean {
  return /\.(md|markdown|txt|vtt|html?|pdf)$/i.test(f.name);
}

/** What to say after an upload: how many failed, naming files that are not documents at all. */
export function uploadError(files: File[], failed: number): string | null {
  if (!failed) return null;
  const skipped = files.filter((f) => !isDocumentFile(f)).map((f) => f.name);
  const why = skipped.length
    ? ` ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? " and others" : ""} ${skipped.length === 1 ? "isn't a" : "aren't"} supported (Markdown, text, VTT, HTML or PDF).`
    : "";
  return `${failed} of ${files.length} files could not be uploaded.${why}`;
}

export async function importFiles(files: File[], onAdded: (source: Source, job: Job) => void, notebookId?: string): Promise<number> {
  let failed = 0;
  for (const f of files) {
    if (!isDocumentFile(f)) {
      failed += 1;
      continue;
    }
    try {
      const res = await sourcesApi.importFile(f, notebookId);
      onAdded(res.source, res.job);
    } catch {
      failed += 1;
    }
  }
  return failed;
}

/** One box for everything: paste a link (feed or article is worked out for you) or add files. */
export function AddSource({
  onAdded,
  notebookId,
  onUploadStart,
  onUploadSettled,
  compact = false,
}: {
  onAdded: (source: Source, job: Job) => void;
  /** Smaller Connect and Upload buttons (inside a dialog). */
  compact?: boolean;
  /** Added from inside a notebook: the posts join it. */
  notebookId?: string;
  onUploadStart?: (count: number) => void;
  onUploadSettled?: (failed: number, total: number) => void;
}) {
  const [value, setValue] = useState("");
  const [override, setOverride] = useState<"feed" | "url" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mode = override ?? (looksLikeArticle(value) ? "url" : "feed");
  const { check, modal } = useSourceUrlCheck();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || !(await check(value))) return;
    setError(null);
    setBusy(true);
    try {
      const res = mode === "feed" ? await sourcesApi.connect(value.trim(), notebookId) : await sourcesApi.importUrl(value.trim(), notebookId);
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
    onUploadStart?.(list.length);
    const failed = await importFiles(list, onAdded, notebookId);
    onUploadSettled?.(failed, list.length);
    setError(uploadError(list, failed));
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className={`card add-source${compact ? " add-source-compact" : ""}`}>
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
        <button className={`btn btn-primary${compact ? " btn-small" : ""}`} type="submit" disabled={busy || !value.trim()}>
          {busy ? (mode === "feed" ? "Finding posts..." : "Working...") : mode === "feed" ? "Connect" : "Import article"}
        </button>
        <span className="muted small">or</span>
        <button type="button" className={`btn${compact ? " btn-small" : ""}`} disabled={busy} onClick={() => fileRef.current?.click()}>
          Upload files
        </button>
        <input ref={fileRef} type="file" multiple accept={FILE_ACCEPT} hidden onChange={(e) => upload(e.target.files)} aria-label="Files to upload" />
      </form>
      <p className="muted small">
        {!value.trim() && (compact
          ? "Any blog or newsletter link, or Markdown, text, HTML and PDF files."
          : "Substack, Ghost, WordPress, Medium or any site with a feed. Markdown, text, VTT transcripts, HTML and PDF files work too; drop them anywhere on this page.")}
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
      <SourceUrlHint url={value} />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {modal}
    </div>
  );
}

export default function Sources() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const { openUpgrade } = useUpgrade();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [removing, setRemoving] = useState<Set<string>>(new Set()); // sources being deleted: dimmed at once, gone when done
  const [offset, setOffset] = useState(0);
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [optimisticImportCount, setOptimisticImportCount] = useState<number | null>(null);
  const optimisticImportCountRef = useRef<number | null>(null);

  const rememberOptimisticCount = (count: number | null) => {
    optimisticImportCountRef.current = count;
    setOptimisticImportCount(count);
  };

  const loadSources = useCallback(() => sourcesApi.list().then((next) => {
    const expected = optimisticImportCountRef.current;
    if (expected === null) return setSources(next);
    const imports = next.find((s) => s.is_imports);
    if (!imports) return setSources([...next, pendingImports(expected)]);
    setSources(next.map((s) => (s.id === imports.id ? { ...s, document_count: Math.max(s.document_count, expected) } : s)));
  }), []);
  const loadDocs = useCallback(
    (reset = true) => {
      const start = reset ? 0 : offset + PAGE;
      return docsApi.list({ q, indexed_only: true, sort: "added", limit: PAGE, offset: start }).then((p) => {
        setTotal(p.total);
        setOffset(start);
        setDocs((d) => (reset ? p.items : [...d, ...p.items]));
      });
    },
    [q, offset],
  );

  const { jobs, watch } = useJobMap((_key, finished) => {
    void Promise.all([loadSources(), loadDocs()]).then(() => {
      if (finished.kind === "import_upload") rememberOptimisticCount(null);
    });
  });

  // The post counts on the cards come from the server, so refresh them, and the posts list under them, while a sync is running:
  // posts show up as they arrive. (Not while a search is being typed or a "Load more" page is open: that would reset them.)
  const syncing = Object.values(jobs).some((j) => j.status === "queued" || j.status === "running");
  const loadDocsRef = useRef(loadDocs);
  loadDocsRef.current = loadDocs;
  const paged = useRef(false);
  paged.current = docs.length > PAGE;
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(() => {
      loadSources().catch(() => {});
      if (!paged.current) loadDocsRef.current(true).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [syncing, loadSources]);

  useEffect(() => {
    loadSources().catch(() => setError("Could not load your sources. Refresh to try again."));
  }, [loadSources]);

  useEffect(() => {
    const t = setTimeout(() => loadDocs(true), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

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
      const rest = (list ?? []).filter((s) => s.id !== source.id && !(source.is_imports && s.is_imports));
      return [...rest, source];
    });
    watch(source.id, job);
  };

  const importsStarted = (count: number) => {
    const current = sources?.find((s) => s.is_imports)?.document_count ?? 0;
    const expected = Math.max(current, optimisticImportCountRef.current ?? 0) + count;
    rememberOptimisticCount(expected);
    setSources((list) => {
      const items = list ?? [];
      const existing = items.find((s) => s.is_imports);
      if (!existing) return [...items, pendingImports(expected)];
      return items.map((s) => (s.id === existing.id ? { ...s, document_count: expected, sync_status: "syncing" } : s));
    });
  };

  const importsSettled = (failed: number, total: number) => {
    if (!failed) return;
    const next = Math.max(0, (optimisticImportCountRef.current ?? total) - failed);
    rememberOptimisticCount(next || null);
    if (failed === total) void loadSources();
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
        importsStarted(files.length);
        const failed = await importFiles(files, added);
        importsSettled(failed, files.length);
        setError(uploadError(files, failed));
      }}
    >
      <SourcesNav />
      <PageHeader eyebrow="Sources" title="Your knowledge, in orbit" />
      <AddSource onAdded={added} onUploadStart={importsStarted} onUploadSettled={importsSettled} />
      {error && <p className="error-text">{error}</p>}

      {/* Outside the card grid, so the loader is centered across the page rather than in the first column */}
      {!sources && <Loading center="page" />}
      <section className="grid-cards">
        {sources?.map((s) => {
          const job = jobs[s.id];
          const active = job && (job.status === "queued" || job.status === "running");
          const failed = !active && (s.sync_status === "error" || job?.status === "failed");
          return (
            <article key={s.id} className={`card source-card${removing.has(s.id) ? " removing" : ""}`}>
              <header className="row between">
                <div className="source-title">
                  <strong>{s.title ?? s.feed_url}</strong>
                  <span className="mono muted">
                    {s.is_imports ? "imports" : s.platform} · {Math.max(s.document_count - s.locked_count, s.is_imports ? optimisticImportCount ?? 0 : 0)} posts
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
              {job && active && <SyncStats job={job} />}
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
                {failed && !s.is_imports && s.id !== PENDING_IMPORTS_ID && <DeleteButton
                  className="btn btn-small btn-danger"
                  label={`Delete ${s.title ?? s.feed_url}`}
                  heading="Delete this source?"
                  name={s.title ?? s.feed_url}
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
                    loadSources();
                    loadDocs();
                  }}
                >
                  Delete
                </DeleteButton>}
              </footer>
            </article>
          );
        })}
      </section>
      {sources?.length === 0 && (
        <EmptyState title="No sources yet" body="A lone satellite, waiting for signal. Connect a blog or site above, or upload your markdown files." />
      )}

      {/* One automatic feed across every source, with the most recently added posts first. */}
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
                {d.locked && (
                  <span className="mono muted small" title="Upgrade to index this post">
                    Not indexed
                  </span>
                )}
                <span className="mono muted">
                  {d.source_title ?? ""} · {formatDate(d.published_at)} · {d.words} words
                </span>
                <DeleteButton
                  className="icon-btn doc-delete"
                  label={`Delete ${d.title}`}
                  heading="Delete this post?"
                  name={d.title}
                  onConfirm={async () => {
                    // A failure shows in the warning, which stays open to try again
                    await docsApi.remove(d.id);
                    if (reading === d.id) setReading(null);
                    setDocs((list) => list.filter((post) => post.id !== d.id));
                    setTotal((n) => Math.max(0, n - 1));
                    setSources((list) => list?.map((source) => source.id === d.source_id
                      ? { ...source, document_count: Math.max(0, source.document_count - 1) }
                      : source) ?? null);
                  }}
                >
                  <TrashIcon size={18} />
                </DeleteButton>
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

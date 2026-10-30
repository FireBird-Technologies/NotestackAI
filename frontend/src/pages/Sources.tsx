import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { docsApi, jobsApi, settingsApi, sourcesApi, type NotebookLmImportResult } from "@notestack/shared/endpoints";
import { looksLikeArticle } from "@notestack/shared/urlScrapability";
import type { Doc, Job, Source } from "@notestack/shared/types";
import { NotebookLmTransferButton } from "../components/NotebookLmTransferButton";
import { Reader } from "../components/Reader";
import { TrashIcon } from "../components/icons/Icons";
import { SourceUrlHint, useSourceUrlCheck } from "../components/SourceUrlCheck";
import { DeleteButton, EmptyState, errorMessage, formatDate, JobProgress, Loading, PageHeader, Pager, StatusPill, Tabs } from "../components/ui";
import { useJobMap } from "../hooks/useJob";
import { useUpgrade } from "../hooks/useUpgrade";
import { useAuth } from "../hooks/useAuth";
import {
  isNotebookLmExtensionInstalled,
  completeNotebookLmTransfer,
  NOTEBOOKLM_PLAN_LIMIT_REACHED,
  openNotebookLmExtensionStore,
  openNotebookLmTransfer,
  notebookLmPlanLimitMessage,
  notebookLmPlanLimitPreviewMessage,
  pendingNotebookLmTransfer,
  reportNotebookLmTransferStatus,
} from "../lib/notebooklm";

const PAGE = 10; // posts on one page of the list
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
type AddSourceMethod = "link" | "upload" | "notebooklm";

const ADD_SOURCE_METHODS: { id: AddSourceMethod; label: string }[] = [
  { id: "link", label: "Link" },
  { id: "upload", label: "Upload" },
  { id: "notebooklm", label: "Transfer from NotebookLM" },
];

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
  returnToNotebookId,
  onUploadStart,
  onUploadSettled,
  compact = false,
}: {
  onAdded: (source: Source, job: Job) => void;
  /** Smaller Connect and Upload buttons (inside a dialog). */
  compact?: boolean;
  /** Added from inside a notebook: the posts join it. */
  notebookId?: string;
  /** The notebook page that opened this control, including the archive notebook. */
  returnToNotebookId?: string;
  onUploadStart?: (count: number) => void;
  onUploadSettled?: (failed: number, total: number) => void;
}) {
  const { user } = useAuth();
  const [value, setValue] = useState("");
  const [override, setOverride] = useState<"feed" | "url" | null>(null);
  const [method, setMethod] = useState<AddSourceMethod>("link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [extensionInstalled, setExtensionInstalled] = useState(isNotebookLmExtensionInstalled);
  const [waitingForStoreReturn, setWaitingForStoreReturn] = useState(false);
  const [notebookLmLaunchMessage, setNotebookLmLaunchMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const mode = override ?? (looksLikeArticle(value) ? "url" : "feed");
  const { check, modal } = useSourceUrlCheck();

  useEffect(() => {
    const detect = () => setExtensionInstalled(isNotebookLmExtensionInstalled());
    detect();
    window.addEventListener("notestack:notebooklm-exporter-ready", detect);
    const timer = window.setInterval(detect, 750);
    return () => {
      window.removeEventListener("notestack:notebooklm-exporter-ready", detect);
      window.clearInterval(timer);
    };
  }, []);

  // A newly installed extension is not injected into tabs that were already open. Refresh this page once when the
  // person comes back from the Web Store so Step 2 unlocks without a separate check button.
  useEffect(() => {
    if (!waitingForStoreReturn) return;
    let leftForStore = false;
    let timer: number | undefined;
    const onBlur = () => { leftForStore = true; };
    const onFocus = () => {
      if (!leftForStore) return;
      setWaitingForStoreReturn(false);
      timer = window.setTimeout(() => {
        if (isNotebookLmExtensionInstalled()) setExtensionInstalled(true);
        else window.location.reload();
      }, 350);
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [waitingForStoreReturn]);

  const installNotebookLmExtension = () => {
    setWaitingForStoreReturn(true);
    openNotebookLmExtensionStore();
  };

  const beginNotebookLmExport = async () => {
    if (!extensionInstalled) return;
    setNotebookLmLaunchMessage(null);
    const returnTo = returnToNotebookId
      ? `/app/notebooks/${encodeURIComponent(returnToNotebookId)}?notebooklm=import`
      : "/app/sources?notebooklm=import";
    const result = await openNotebookLmTransfer(returnTo, user);
    setNotebookLmLaunchMessage(
      result.alreadyOpen
        ? result.message || "A NotebookLM transfer is already open and still running."
        : result.ok
          ? "Transfer side panel opened. Keep it open to watch progress."
          : result.error || "NotebookLM could not be opened.",
    );
  };

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
    <div className={`card add-source${compact ? " add-source--compact" : ""}`}>
      <Tabs<AddSourceMethod>
        tabs={ADD_SOURCE_METHODS}
        className="source-methods"
        value={method}
        label="Choose an import method"
        onChange={(next) => {
          setMethod(next);
          setError(null);
          if (next !== "notebooklm") setNotebookLmLaunchMessage(null);
        }}
      />
      <div className={`source-method-panel source-method-panel--${method}`} role="tabpanel">
        {method === "link" && (
          <>
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
            </form>
            <p className="muted small source-method-help">
              {!value.trim() && (compact
                ? "Paste a blog, newsletter, feed, or one article."
                : "Substack, Ghost, WordPress, Medium, any site with a feed, or one article link.")}
              {value.trim() && mode === "feed" && (
                <>
                  We will pull in the whole archive and keep it in sync.{" "}
                  <button type="button" className="link-btn small" onClick={() => setOverride("url")}>Just this one page instead</button>
                </>
              )}
              {value.trim() && mode === "url" && (
                <>
                  Looks like a single article, so we will import just this page.{" "}
                  <button type="button" className="link-btn small" onClick={() => setOverride("feed")}>Connect the whole site instead</button>
                </>
              )}
            </p>
            <SourceUrlHint url={value} />
          </>
        )}
        {method === "upload" && (
          <label
            className={`source-upload-drop${dragging ? " over" : ""}${busy ? " disabled" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!busy) setDragging(true);
            }}
            onDragLeave={(e) => {
              e.stopPropagation();
              setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragging(false);
              if (!busy) void upload(e.dataTransfer.files);
            }}
          >
            <input ref={fileRef} type="file" multiple accept={FILE_ACCEPT} disabled={busy} onChange={(e) => void upload(e.target.files)} aria-label="Files to upload" />
            <span className="source-upload-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></svg>
            </span>
            <strong>{busy ? "Uploading files..." : "Drop files here or choose files"}</strong>
            <span className="mono muted small">Markdown · text · VTT · HTML · PDF</span>
          </label>
        )}
        {method === "notebooklm" && (
          <>
            <div className="source-method-heading">
              <p className="eyebrow">NotebookLM transfer</p>
              <h2>Move your notebooks into Notestack</h2>
              <p className="muted small">Install the extension once, choose what to transfer, then return here to index everything.</p>
            </div>
            <div className="welcome-transfer-flow" id="notebooklm-transfer-guide">
              <div className={`welcome-transfer-flow-step${extensionInstalled ? " done" : " current"}`}>
                <span className="welcome-transfer-flow-number">1</span>
                <div>
                  <strong>Install the extension</strong>
                  <p className="muted small">Get NotebookLM Transfer to Notestack from the Chrome Web Store.</p>
                </div>
                {extensionInstalled ? (
                  <span className="welcome-transfer-installed mono">Installed</span>
                ) : (
                  <button type="button" className="btn btn-small" onClick={installNotebookLmExtension}>Open Chrome Web Store</button>
                )}
              </div>
              <div className={`welcome-transfer-flow-step${extensionInstalled ? " current" : " disabled"}`}>
                <span className="welcome-transfer-flow-number">2</span>
                <div>
                  <strong>Transfer to Notestack</strong>
                  <p className="muted small">
                    {extensionInstalled
                      ? "Choose what to transfer to Notestack in the extension."
                      : "This unlocks automatically after the extension is installed."}
                  </p>
                  {notebookLmLaunchMessage && <p className="muted small" role="status">{notebookLmLaunchMessage}</p>}
                </div>
                <NotebookLmTransferButton disabled={!extensionInstalled} onClick={beginNotebookLmExport} />
              </div>
              <div className="welcome-transfer-flow-step disabled">
                <span className="welcome-transfer-flow-number">3</span>
                <div>
                  <strong>Return and index</strong>
                  <p className="muted small">After the transfer, you return automatically and we add everything to your library.</p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {method === "link" && modal}
    </div>
  );
}

type NotebookLmImportState = "reading" | "importing" | "done" | "limit" | "error";

export function NotebookLmImportSteps({
  onImported,
  onBack,
  notebookId,
  backLabel = "Back to Sources",
}: {
  onImported: () => Promise<void>;
  onBack: () => void;
  notebookId?: string;
  backLabel?: string;
}) {
  const { user } = useAuth();
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const [state, setState] = useState<NotebookLmImportState>("reading");
  const [result, setResult] = useState<NotebookLmImportResult | null>(null);
  const [message, setMessage] = useState("Reading the transfer from your extension…");
  const [limitWarning, setLimitWarning] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const run = async () => {
      let transferId = "";
      try {
        const transfer = await pendingNotebookLmTransfer();
        if (!transfer) {
          // A completed transfer is removed from extension storage. If this page is later
          // restored with the old query string, return to Sources instead of reporting a
          // false failure for work that already finished.
          onBackRef.current();
          return;
        }
        transferId = transfer.transferId;
        if (!live) return;
        const usage = await settingsApi.usage().catch(() => null);
        const limit = usage?.limits.indexed_posts ?? -1;
        const used = usage?.used.indexed_posts ?? 0;
        const room = limit < 0 ? transfer.posts.length : Math.max(0, limit - used);
        const artifactCount = transfer.artifacts.length;
        const selectedCount = transfer.posts.length + artifactCount;
        const overPlan = transfer.posts.length > room;
        const preflightMessage = overPlan
          ? notebookLmPlanLimitPreviewMessage(transfer.posts.length, room)
          : `Transferring ${selectedCount} ${selectedCount === 1 ? "item" : "items"} to Notestack…`;
        setMessage(preflightMessage);
        setLimitWarning(null);
        if (limit >= 0 && room === 0 && artifactCount === 0) {
          const summary = {
            selectedCount,
            acceptedCount: 0,
            skippedPlan: transfer.posts.length,
            plan: usage?.plan ?? "",
            planLimit: limit,
          };
          setMessage(NOTEBOOKLM_PLAN_LIMIT_REACHED);
          setLimitWarning(NOTEBOOKLM_PLAN_LIMIT_REACHED);
          setState("limit");
          await completeNotebookLmTransfer(transferId, NOTEBOOKLM_PLAN_LIMIT_REACHED, summary, user);
          return;
        }
        setState("importing");
        reportNotebookLmTransferStatus(transferId, "importing", preflightMessage, 0.68, {
          selectedCount,
          acceptedCount: Math.min(transfer.posts.length, room) + artifactCount,
          skippedPlan: Math.max(0, transfer.posts.length - room),
          plan: usage?.plan ?? "",
          planLimit: Math.max(0, limit),
        }, user);
        const imported = await sourcesApi.importNotebookLm(transferId, transfer.posts, transfer.artifacts, notebookId);
        const accepted = imported.eligible - imported.skipped_plan;
        const importedArtifacts = imported.artifacts_imported + imported.artifacts_updated;
        const totalReady = accepted + importedArtifacts;
        const planLimitReached = accepted === 0 && imported.skipped_plan > 0 && importedArtifacts === 0;
        const completionMessage = planLimitReached
          ? NOTEBOOKLM_PLAN_LIMIT_REACHED
          : imported.skipped_plan > 0
          ? importedArtifacts
            ? `Transfer complete. ${totalReady} ${totalReady === 1 ? "item is" : "items are"} ready; ${imported.skipped_plan} ${imported.skipped_plan === 1 ? "post exceeds" : "posts exceed"} your plan limit.`
            : notebookLmPlanLimitMessage(imported.eligible, accepted, imported.skipped_plan)
          : `Transfer complete. ${totalReady} ${totalReady === 1 ? "item is" : "items are"} ready in Notestack.`;
        const completionSummary = {
          selectedCount: imported.eligible + imported.artifacts_received,
          acceptedCount: totalReady,
          skippedPlan: imported.skipped_plan,
          plan: imported.plan,
          planLimit: imported.plan_limit,
        };
        if (planLimitReached) {
          if (live) {
            setResult(imported);
            setMessage(completionMessage);
            setLimitWarning(completionMessage);
            setState("limit");
          }
          await completeNotebookLmTransfer(transferId, completionMessage, completionSummary, user);
          return;
        }
        // The import API has already committed the content. Mark the extension complete before
        // refreshing this page; navigation or a failed refresh must not strand the side panel at 90%.
        await completeNotebookLmTransfer(transferId, completionMessage, completionSummary, user);
        if (!live) return;
        setResult(imported);
        setMessage(completionMessage);
        setLimitWarning(imported.skipped_plan > 0 ? completionMessage : null);
        setState("done");
        await onImportedRef.current().catch(() => undefined);
      } catch (error) {
        if (!live) return;
        const failure = errorMessage(error, "The NotebookLM transfer could not be completed.");
        setMessage(failure);
        setState("error");
        if (transferId) reportNotebookLmTransferStatus(transferId, "error", failure, 0);
      }
    };
    // Defer one tick so React StrictMode can finish its setup/cleanup probe without cancelling
    // the only transfer attempt and leaving this screen on "Reading the transfer…" forever.
    const timer = window.setTimeout(() => void run(), 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <section className="card add-source add-source-notebooklm-guide" aria-live="polite">
      <p className="eyebrow">NotebookLM transfer</p>
      <h2>{state === "limit" ? "Plan limit reached" : state === "done" ? "Your notebooks are indexed" : state === "error" ? "We could not finish the transfer" : "Bringing your notebooks into Notestack"}</h2>
      {limitWarning && <div className="welcome-cap" role="alert"><div><strong>Plan limit</strong><p className="muted small">{limitWarning.replace(/^Plan limit warning:\s*/i, "")}</p></div></div>}
      <ol className="welcome-notebooklm-index-steps" aria-label="NotebookLM transfer progress">
        <li className="done"><span>1</span><div><strong>Extension connected</strong><small>Notestack can receive your transfer.</small></div></li>
        <li className="done"><span>2</span><div><strong>Notebooks collected</strong><small>Your selected NotebookLM content is ready.</small></div></li>
        <li className={state === "done" ? "done" : state === "limit" || state === "error" ? "error" : "current"}>
          <span>3</span>
          <div><strong>{state === "limit" ? "Plan limit reached" : state === "done" ? "Index complete" : "Index in Notestack"}</strong><small>{message}</small></div>
          {(state === "reading" || state === "importing") && <div className="orbit-loader orbit-loader--inline" aria-hidden="true"><span /></div>}
        </li>
      </ol>
      {state === "done" && result && <p className="muted small">{result.imported + result.unchanged} items are now available in your Sources library.</p>}
      <button type="button" className={`btn welcome-transfer-view-back${state === "done" || state === "limit" ? " btn-primary" : ""}`} onClick={onBack}>
        {state === "done" || state === "limit" ? backLabel : "Back"}
      </button>
    </section>
  );
}

export default function Sources() {
  const [searchParams, setSearchParams] = useSearchParams();
  const returningFromNotebookLm = searchParams.get("notebooklm") === "import";
  const [sources, setSources] = useState<Source[] | null>(null);
  const { openUpgrade } = useUpgrade();
  const [docs, setDocs] = useState<Doc[] | null>(null); // null: a page is loading (the loader, not the last page)
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
  /** One page of posts, from `start` (default: the page shown, so a refresh keeps it). A page past the end (posts were
   * deleted) gives way to the last one. */
  const docsAsked = useRef(0); // the latest request: an older answer (another search or page) is dropped
  const loadDocs = useCallback(
    (start = offset): Promise<void> => {
      const asked = ++docsAsked.current;
      return docsApi.list({ q, indexed_only: true, sort: "added", limit: PAGE, offset: start }).then((p) => {
        if (asked !== docsAsked.current) return;
        if (!p.items.length && start > 0 && p.total > 0) return loadDocs(Math.floor((p.total - 1) / PAGE) * PAGE);
        setTotal(p.total);
        setOffset(start);
        setDocs(p.items);
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
  // posts show up as they arrive. (Only on the first page: a later page would shift under the reader.)
  const syncing = Object.values(jobs).some((j) => j.status === "queued" || j.status === "running");
  const loadDocsRef = useRef(loadDocs);
  loadDocsRef.current = loadDocs;
  const paged = useRef(false);
  paged.current = offset > 0;
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(() => {
      loadSources().catch(() => {});
      if (!paged.current) loadDocsRef.current(0).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [syncing, loadSources]);

  // A NotebookLM transfer runs outside the job system, so refresh the cards and posts while its screen is open.
  useEffect(() => {
    if (!returningFromNotebookLm) return;
    const t = setInterval(() => {
      loadSources().catch(() => {});
      if (!paged.current) loadDocsRef.current(0).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [returningFromNotebookLm, loadSources]);

  useEffect(() => {
    loadSources().catch(() => setError("Could not load your sources. Refresh to try again."));
  }, [loadSources]);

  useEffect(() => {
    // A new search starts on its first page, with the loader until it arrives
    const t = setTimeout(() => {
      setDocs(null);
      loadDocs(0).catch(() => {
        setDocs([]);
        setError("Could not load your posts. Try again.");
      });
    }, 200);
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
      {returningFromNotebookLm ? (
        <NotebookLmImportSteps
          onImported={async () => { await Promise.all([loadSources(), loadDocs(0)]); }}
          onBack={() => setSearchParams({}, { replace: true })}
        />
      ) : (
        <AddSource onAdded={added} onUploadStart={importsStarted} onUploadSettled={importsSettled} />
      )}
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
                    setDocs((list) => list?.filter((d) => d.source_id !== s.id) ?? list);
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
      {sources?.length === 0 && total === 0 && !returningFromNotebookLm && (
        <EmptyState title="No sources yet" body="A lone satellite, waiting for signal. Connect a blog or site above, or upload your markdown files." />
      )}

      {/* One automatic feed across every source, with the most recently added posts first. */}
      {((sources && sources.length > 0) || total > 0) && (
        <section className="card posts-table">
          <div className="row between">
            <h2>
              Posts <span className="mono muted">{total}</span>
            </h2>
            <input className="input input-sm search" placeholder="Search titles and text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search posts" />
          </div>
          <ul className="doc-list">
            {!docs && (
              <li>
                <Loading />
              </li>
            )}
            {docs?.map((d) => (
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
                  {d.source_title ?? ""}
                  {d.transferred_from_notebooklm && " · Transferred from NotebookLM"} · {formatDate(d.published_at)} · {d.words} words
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
                    // The page refills from the next one; its last post gone, the page before it
                    void loadDocs(docs.length === 1 && offset > 0 ? offset - PAGE : offset).catch(() => {
                      setDocs((list) => list?.filter((post) => post.id !== d.id) ?? list);
                      setTotal((n) => Math.max(0, n - 1));
                    });
                    setSources((list) => list?.map((source) => source.id === d.source_id
                      ? { ...source, document_count: Math.max(0, source.document_count - 1) }
                      : source) ?? null);
                  }}
                >
                  <TrashIcon size={18} />
                </DeleteButton>
              </li>
            ))}
            {docs?.length === 0 && <li className="muted">No posts match.</li>}
          </ul>
          <Pager page={Math.floor(offset / PAGE)} pages={Math.ceil(total / PAGE)}
                 onChange={(page) => {
                   // That page at once, with the loader until its posts arrive
                   setDocs(null);
                   setOffset(page * PAGE);
                   void loadDocs(page * PAGE).catch(() => {
                     setDocs([]);
                     setError("Could not load that page. Try again.");
                   });
                 }} />
        </section>
      )}
      {reading && <Reader documentId={reading} onClose={() => setReading(null)} />}
    </div>
  );
}

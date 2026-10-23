import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { docsApi, jobsApi, notebooksApi, settingsApi, sourcesApi, type NotebookLmImportResult } from "../api/endpoints";
import type { Job, Source } from "../api/types";
import { CloseIcon, UploadIcon } from "../components/icons/Icons";
import Logo from "../components/Logo";
import SkyCanvas from "../components/SkyCanvas";
import { SourceUrlHint, useSourceUrlCheck } from "../components/SourceUrlCheck";
import { errorMessage, JobProgress, Tabs } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { useJob } from "../hooks/useJob";
import {
  completeNotebookLmTransfer,
  isNotebookLmExtensionInstalled,
  NOTEBOOKLM_PLAN_LIMIT_REACHED,
  openNotebookLmExtensionStore,
  openNotebookLmTransfer,
  notebookLmPlanLimitMessage,
  notebookLmPlanLimitPreviewMessage,
  pendingNotebookLmTransfer,
  reportNotebookLmTransferStatus,
} from "../lib/notebooklm";
import { classifyUrl } from "../lib/urlScrapability";
import { PENDING_SOURCE_KEY } from "./Landing";

type Step = "connect" | "indexing" | "goal" | "ready";
type Goal = "ask" | "audio" | "launch";
type Mode = "feed" | "url" | "file" | "notebooklm";

const MODES: { id: Mode; label: string }[] = [
  { id: "feed", label: "Blog or website" },
  // Hidden for now: { id: "notebooklm", label: "Transfer from NotebookLM" },
  { id: "url", label: "One article" },
  { id: "file", label: "Upload files" },
];

const FILE_ACCEPT = ".md,.markdown,.txt,.vtt,.html,.htm,.pdf,text/vtt,text/markdown,text/plain,text/html,application/pdf";

const EXAMPLES = ["yourblog.com", "yourname.substack.com", "medium.com/@you"];

const GOALS: { id: Goal; title: string; body: string }[] = [
  { id: "ask", title: "Ask my archive", body: "Chat with everything you have written. Every answer cites the lines it came from." },
  { id: "audio", title: "Hear it as a podcast", body: "Two hosts talk through your best posts, grounded in your words." },
  { id: "launch", title: "Launch my next post", body: "Threads, LinkedIn, Notes, SEO and quote cards, in your voice." },
];

export const ONBOARDED_KEY = "ns_onboarded";
const NOTEBOOKLM_GUIDE_KEY = "ns_notebooklm_guide_open";
const NOTEBOOKLM_RETURN_PATH = "/welcome?notebooklm=import";

function notebookLmGuideWasOpen(): boolean {
  try {
    return sessionStorage.getItem(NOTEBOOKLM_GUIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboarded() {
  try {
    localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    /* ignore */
  }
}

function takePending(): string {
  try {
    const v = sessionStorage.getItem(PENDING_SOURCE_KEY) ?? "";
    sessionStorage.removeItem(PENDING_SOURCE_KEY);
    return v;
  } catch {
    return "";
  }
}

/** Resolves once every job has finished, so a multi-file upload only counts as indexed when all files are in. */
async function waitForJobs(ids: string[]): Promise<void> {
  let pending = ids;
  while (pending.length) {
    const jobs = await Promise.all(pending.map((id) => jobsApi.get(id).catch(() => null)));
    pending = pending.filter((_, i) => jobs[i] && jobs[i]!.status !== "done" && jobs[i]!.status !== "failed");
    if (pending.length) await new Promise((r) => setTimeout(r, 1500));
  }
}

/** First run: connect a blog, import an article or upload files, watch it index, pick what to do first, land somewhere useful. */
export default function Welcome() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returningFromNotebookLm = searchParams.get("notebooklm") === "import";
  const [step, setStep] = useState<Step>("connect");
  const [mode, setMode] = useState<Mode>(() => notebookLmGuideWasOpen() ? "notebooklm" : "feed");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const earlierJobs = useRef<string[]>([]);
  const [url, setUrl] = useState(takePending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [goal, setGoal] = useState<Goal | null>(null);
  const [posts, setPosts] = useState(0);
  const [extensionInstalled, setExtensionInstalled] = useState(isNotebookLmExtensionInstalled);
  const [waitingForStoreReturn, setWaitingForStoreReturn] = useState(false);
  const [notebookLmImportState, setNotebookLmImportState] = useState<"idle" | "reading" | "importing" | "done" | "limit" | "error">("idle");
  const [notebookLmImportResult, setNotebookLmImportResult] = useState<NotebookLmImportResult | null>(null);
  const [notebookLmLimitWarning, setNotebookLmLimitWarning] = useState<string | null>(null);
  const [notebookLmLaunchMessage, setNotebookLmLaunchMessage] = useState<string | null>(null);
  const notebookLmImportStarted = useRef(false);
  const autoStarted = useRef(false);

  const live = useJob(job, async (j) => {
    if (j.status !== "done") return;
    await waitForJobs(earlierJobs.current);
    const list = await docsApi.list({ limit: 1 });
    setPosts(list.total);
    setStep((s) => (s === "indexing" ? "goal" : s === "goal" ? "goal" : "ready"));
  });

  const { check, modal } = useSourceUrlCheck();

  const connect = async (value: string, as: Mode = "feed") => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = as === "url" ? await sourcesApi.importUrl(value.trim()) : await sourcesApi.connect(value.trim());
      earlierJobs.current = [];
      setSource(res.source);
      setJob(res.job);
      setStep("indexing");
    } catch (e) {
      setError(errorMessage(e, as === "url" ? "We could not import that page." : "We could not reach that address."));
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      // One import job per file: the last drives the progress bar, the rest are awaited before moving on.
      const jobs: Job[] = [];
      let res: Awaited<ReturnType<typeof sourcesApi.importFile>> | null = null;
      for (const f of files) {
        res = await sourcesApi.importFile(f);
        jobs.push(res.job);
      }
      earlierJobs.current = jobs.slice(0, -1).map((j) => j.id);
      setSource(res!.source);
      setJob(res!.job);
      setStep("indexing");
    } catch (e) {
      setError(errorMessage(e, "That upload did not go through."));
    } finally {
      setBusy(false);
    }
  };

  const addFiles = (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    if (picked.length) setFiles((cur) => [...cur, ...picked.filter((f) => !cur.some((c) => c.name === f.name && c.size === f.size))]);
  };

  // A URL pasted on the landing page starts connecting straight away: its warning was confirmed there, but a link that
  // can't be added stops here.
  useEffect(() => {
    if (url && !autoStarted.current && user) {
      autoStarted.current = true;
      const verdict = classifyUrl(url);
      if (verdict.kind === "blocked") setError(verdict.message);
      else void connect(url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // The extension announces itself at document_start. Polling also catches a newly injected bridge without making the
  // person click a separate "check again" control.
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

  // Chrome does not inject a newly installed content script into a page that was already open. After the person returns
  // from the Web Store, refresh this one onboarding page once; the bridge then loads at document_start and Step 2 enables.
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

  // An export started here returns to the regular onboarding Index screen. Importing is synchronous, then the same
  // Choose step used by blogs and file uploads opens automatically.
  useEffect(() => {
    if (!user || !returningFromNotebookLm || notebookLmImportStarted.current) return;
    notebookLmImportStarted.current = true;
    let active = true;
    let continueTimer: number | undefined;
    setStep("indexing");
    setSource(null);
    setJob(null);
    setError(null);
    setNotebookLmImportState("reading");

    const run = async () => {
      let transferId = "";
      try {
        const transfer = await pendingNotebookLmTransfer();
        if (!transfer) throw new Error("No pending NotebookLM transfer was found. Return to the transfer steps and try again.");
        transferId = transfer.transferId;
        if (!active) return;
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
        setNotebookLmLimitWarning(null);
        if (limit >= 0 && room === 0 && artifactCount === 0) {
          const summary = {
            selectedCount,
            acceptedCount: 0,
            skippedPlan: transfer.posts.length,
            plan: usage?.plan ?? "",
            planLimit: limit,
          };
          setNotebookLmLimitWarning(NOTEBOOKLM_PLAN_LIMIT_REACHED);
          setNotebookLmImportState("limit");
          await completeNotebookLmTransfer(transfer.transferId, NOTEBOOKLM_PLAN_LIMIT_REACHED, summary, user);
          return;
        }
        setNotebookLmImportState("importing");
        reportNotebookLmTransferStatus(transfer.transferId, "importing", preflightMessage, 0.68, {
          selectedCount,
          acceptedCount: Math.min(transfer.posts.length, room) + artifactCount,
          skippedPlan: Math.max(0, transfer.posts.length - room),
          plan: usage?.plan ?? "",
          planLimit: Math.max(0, limit),
        }, user);
        const imported = await sourcesApi.importNotebookLm(transfer.transferId, transfer.posts, transfer.artifacts);
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
        setNotebookLmLimitWarning(imported.skipped_plan > 0 ? completionMessage : null);
        const completionSummary = {
          selectedCount: imported.eligible + imported.artifacts_received,
          acceptedCount: totalReady,
          skippedPlan: imported.skipped_plan,
          plan: imported.plan,
          planLimit: imported.plan_limit,
        };
        if (planLimitReached) {
          if (active) {
            setNotebookLmImportResult(imported);
            setNotebookLmImportState("limit");
          }
          await completeNotebookLmTransfer(transfer.transferId, completionMessage, completionSummary, user);
          return;
        }
        // Importing is synchronous and committed above. Complete the extension handoff before
        // the optional page refresh so leaving onboarding cannot freeze the panel at 90%.
        await completeNotebookLmTransfer(transfer.transferId, completionMessage, completionSummary, user);
        if (!active) return;
        setNotebookLmImportResult(imported);
        setNotebookLmImportState("done");
        const list = await docsApi.list({ limit: 1 }).catch(() => null);
        if (!active) return;
        if (list) setPosts(list.total);
        try {
          sessionStorage.removeItem(NOTEBOOKLM_GUIDE_KEY);
        } catch {
          /* ignore */
        }
        // A transfer launched during onboarding always stays in onboarding. Once indexing finishes, continue to
        // Step 3 even when the plan imported only part of the selection.
        continueTimer = window.setTimeout(() => {
          setStep("goal");
          navigate("/welcome", { replace: true });
        }, 1100);
      } catch (e) {
        if (!active) return;
        setNotebookLmImportState("error");
        const message = errorMessage(e, "The NotebookLM transfer could not be completed.");
        setError(message);
        if (transferId) reportNotebookLmTransferStatus(transferId, "error", message, 0);
      }
    };

    const startTimer = window.setTimeout(() => void run(), 0);
    return () => {
      active = false;
      notebookLmImportStarted.current = false;
      window.clearTimeout(startTimer);
      if (continueTimer !== undefined) window.clearTimeout(continueTimer);
    };
  }, [user, returningFromNotebookLm, navigate]);

  if (loading) return <div className="boot"><div className="orbit-loader"><span /></div></div>;
  if (!user) return <Navigate to="/auth?mode=signup" replace />;

  const notebookLmIndexing = notebookLmImportState !== "idle";
  const indexingDone = live?.status === "done" || notebookLmImportState === "done";
  const indexingFailed = live?.status === "failed" || notebookLmImportState === "error";
  // The ingest job lists the whole archive but indexes only the plan's limit; the rest waits behind an upgrade.
  const locked = notebookLmImportResult?.skipped_plan ?? Number(live?.result?.locked ?? 0);
  const capped = indexingDone && locked > 0;
  const available = notebookLmImportResult
    ? notebookLmImportResult.eligible - notebookLmImportResult.skipped_plan
    : Number(live?.result?.available ?? posts);
  const found = notebookLmImportResult?.eligible ?? Number(live?.result?.found ?? posts);
  const notebookLmLockedNotice = capped && notebookLmImportResult ? (
    <div className="welcome-cap">
      <div>
        <strong>{notebookLmPlanLimitMessage(found, available, locked)}</strong>
      </div>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => {
          markOnboarded();
          navigate("/app?upgrade=1", { replace: true });
        }}
      >
        Upgrade to import more
      </button>
    </div>
  ) : null;
  const standardLockedNotice = capped && !notebookLmImportResult ? (
    <div className="welcome-cap">
      <div>
        <strong>We found {found} posts. The free plan indexed only your latest {available}.</strong>
        <p className="muted small">
          The other {locked} are sitting in your archive, unread. Until you upgrade, answers, audio overviews and Launch
          Kits can only use {available} posts. Upgrade and all {found} are indexed automatically.
        </p>
      </div>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => {
          markOnboarded();
          navigate("/app?upgrade=1", { replace: true });
        }}
      >
        Index all {found} posts
      </button>
    </div>
  ) : null;
  const lockedNotice = notebookLmLockedNotice ?? standardLockedNotice;
  const first = (user.name ?? user.email).split(/[ @]/)[0];

  /** The All posts notebook: where a skipped (or empty) onboarding ends, to add sources from there. */
  const toArchive = async () => {
    try {
      navigate(`/app/notebooks/${(await notebooksApi.archive()).id}`, { replace: true });
    } catch {
      navigate("/app/notebooks", { replace: true });
    }
  };

  const finish = async (chosen: Goal | null) => {
    markOnboarded();
    if (!chosen || posts === 0) return toArchive();
    if (chosen === "launch") return navigate("/app/launchpad/kits", { replace: true });
    setBusy(true);
    try {
      const docs = await docsApi.list({ limit: 5000 });
      const nb = await notebooksApi.create(source?.title ? `${source.title} archive` : "My archive", docs.items.map((d) => d.id));
      navigate(chosen === "audio" ? `/app/notebooks/${nb.id}?studio=audio` : `/app/notebooks/${nb.id}`, { replace: true });
    } catch {
      navigate("/app/notebooks", { replace: true });
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === "file") void upload();
    else if (mode !== "notebooklm" && await check(url)) void connect(url, mode);
  };

  const selectMode = (next: Mode) => {
    setMode(next);
    try {
      if (next === "notebooklm") sessionStorage.setItem(NOTEBOOKLM_GUIDE_KEY, "1");
      else sessionStorage.removeItem(NOTEBOOKLM_GUIDE_KEY);
    } catch {
      /* ignore */
    }
  };

  const setNotebookLmGuide = (open: boolean) => selectMode(open ? "notebooklm" : "feed");

  const installNotebookLmExtension = () => {
    setNotebookLmGuide(true);
    setWaitingForStoreReturn(true);
    openNotebookLmExtensionStore();
  };

  const beginNotebookLmExport = async () => {
    if (!extensionInstalled) return;
    setNotebookLmGuide(true);
    setNotebookLmLaunchMessage(null);
    const result = await openNotebookLmTransfer(NOTEBOOKLM_RETURN_PATH, user);
    setNotebookLmLaunchMessage(
      result.alreadyOpen
        ? result.message || "A NotebookLM transfer is already open and still running."
        : result.ok
          ? "Transfer side panel opened. Keep it open to watch progress."
          : result.error || "NotebookLM could not be opened.",
    );
  };

  const backToNotebookLmSteps = () => {
    setNotebookLmImportState("idle");
    setNotebookLmImportResult(null);
    setNotebookLmLimitWarning(null);
    setError(null);
    setStep("connect");
    setNotebookLmGuide(true);
    navigate("/welcome", { replace: true });
  };

  const stepIndex = { connect: 0, indexing: 1, goal: 2, ready: 3 }[step];

  return (
    <div className="page welcome">
      <SkyCanvas intensity={0.9} />
      <main className="welcome-wrap">
        <div className="welcome-top">
          <Logo size={36} />
          <button className="link-btn mono" onClick={() => finish(null)}>
            Skip for now
          </button>
        </div>
        <ol className="welcome-steps mono" aria-label="Onboarding progress">
          {["Connect", "Index", "Choose", "Launch"].map((label, i) => (
            <li key={label} className={i < stepIndex ? "done" : i === stepIndex ? "current" : ""}>
              <span className="welcome-dot" />
              <span>
                <span className="welcome-step-num">{i + 1}</span>
                {label}
              </span>
            </li>
          ))}
        </ol>

        {step === "connect" && (
          <section className="card welcome-card">
            <p className="eyebrow">Welcome aboard, {first}</p>
            <h1>Where does your writing live?</h1>
            <p className="muted">Bring it in however suits you. We turn it into a research notebook you can question, hear and launch from.</p>
            <Tabs<Mode>
              tabs={MODES}
              value={mode}
              label="Choose how to add your writing"
              onChange={(next) => {
                selectMode(next);
                setError(null);
              }}
            />
            {mode === "notebooklm" ? (
              <div className="source-method-panel source-method-panel--notebooklm">
                <div className="source-method-heading">
                  <p className="eyebrow">NotebookLM transfer</p>
                  <h2>Move your notebooks into Notestack</h2>
                  <p className="muted small">Install the extension once, transfer your notebooks, then return here to index everything.</p>
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
                          ? "Now you can extract your notebooks. Choose what to bring over in the extension."
                          : "This unlocks automatically after the extension is installed."}
                      </p>
                      {notebookLmLaunchMessage && <p className="muted small" role="status">{notebookLmLaunchMessage}</p>}
                    </div>
                    <button type="button" className="btn btn-small btn-primary" disabled={!extensionInstalled} onClick={beginNotebookLmExport}>
                      Open NotebookLM
                    </button>
                  </div>
                  <div className="welcome-transfer-flow-step disabled">
                    <span className="welcome-transfer-flow-number">3</span>
                    <div>
                      <strong>Return and index</strong>
                      <p className="muted small">After the transfer, you return here automatically. We index everything, then continue to Choose.</p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <p className="muted small">
                  {mode === "feed" && "Substack, Ghost, WordPress, Medium or anything with a feed. We find the feed, pull in your archive and keep it in sync."}
                  {mode === "url" && "Any single article on the web. Add more later from Sources."}
                  {mode === "file" && "Markdown, text, VTT transcripts, HTML or PDF: drafts, exports and posts that never had a feed. Add as many as you like."}
                </p>
                <form onSubmit={submit} className="welcome-form">
                  {mode === "file" ? (
                    <label
                      className={`welcome-drop${dragging ? " over" : ""}`}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragging(true);
                      }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragging(false);
                        addFiles(e.dataTransfer.files);
                      }}
                    >
                      <input
                        type="file"
                        multiple
                        accept={FILE_ACCEPT}
                        onChange={(e) => {
                          addFiles(e.target.files);
                          e.target.value = "";
                        }}
                        aria-label="Files to upload"
                      />
                      <UploadIcon size={28} />
                  <strong>Drop files here or click to choose</strong>
                      <span className="mono muted small">.md · .txt · .html · .pdf</span>
                    </label>
                  ) : (
                    <input
                      key={mode}
                      className="input"
                      autoFocus
                      placeholder={mode === "feed" ? "yourblog.com" : "https://example.com/my-essay"}
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      aria-label={mode === "feed" ? "Blog, newsletter or site address" : "Article URL"}
                    />
                  )}
                  {mode === "file" && files.length > 0 && (
                    <ul className="welcome-files mono small">
                      {files.map((f) => (
                        <li key={`${f.name}-${f.size}`}>
                          <span>{f.name}</span>
                          <button type="button" className="icon-btn" onClick={() => setFiles(files.filter((x) => x !== f))} aria-label={`Remove ${f.name}`} title="Remove"><CloseIcon size={14} /></button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button className="btn btn-primary" disabled={busy || (mode === "file" ? !files.length : !url.trim())}>
                    {mode === "feed" && (busy ? "Finding your feed..." : "Connect")}
                    {mode === "url" && (busy ? "Importing..." : "Import")}
                    {mode === "file" && (busy ? "Uploading..." : files.length === 1 ? "Upload 1 file" : `Upload ${files.length || ""} files`.replace("  ", " "))}
                  </button>
                </form>
                {mode !== "file" && <SourceUrlHint url={url} />}
                {modal}
                {mode === "feed" && (
                  <div className="welcome-examples mono muted">
                    Try:{" "}
                    {EXAMPLES.map((ex) => (
                      <button key={ex} type="button" className="chip" onClick={() => setUrl(ex)}>{ex}</button>
                    ))}
                  </div>
                )}
              </>
            )}
            {error && <p className="error-text" role="alert">{error}</p>}
          </section>
        )}

        {step === "indexing" && (
          <section className="card welcome-card">
            {notebookLmIndexing ? (
              <>
                <p className="eyebrow">NotebookLM transfer</p>
                <h1>
                  {notebookLmImportState === "limit"
                    ? "Plan limit reached"
                    : notebookLmImportState === "error"
                    ? "We could not finish the transfer"
                    : notebookLmImportState === "done" ? "Your notebooks are indexed" : "Bringing your notebooks into Notestack"}
                </h1>
                {notebookLmLimitWarning && notebookLmImportState !== "done" && (
                  <div className="welcome-cap" role="alert">
                    <div>
                      <strong>Plan limit warning</strong>
                      <p className="muted small">{notebookLmLimitWarning.replace(/^Plan limit warning:\s*/i, "")}</p>
                    </div>
                  </div>
                )}
                <ol className="welcome-notebooklm-index-steps" aria-label="NotebookLM transfer progress">
                  <li className="done"><span>1</span><div><strong>Extension installed</strong><small>Notestack can securely receive your transfer.</small></div></li>
                  <li className="done"><span>2</span><div><strong>Notebooks transferred</strong><small>Your selected NotebookLM content is ready.</small></div></li>
                  <li className={notebookLmImportState === "done" ? "done" : notebookLmImportState === "limit" || notebookLmImportState === "error" ? "error" : "current"}>
                    <span>3</span>
                    <div>
                      <strong>{notebookLmImportState === "limit" ? "Plan limit reached" : notebookLmImportState === "done" ? "Index complete" : "Index in Notestack"}</strong>
                      <small>
                        {notebookLmImportState === "reading" && "Reading the transfer from your extension…"}
                        {notebookLmImportState === "importing" && (notebookLmLimitWarning ?? "Adding the notebooks to your searchable archive…")}
                        {notebookLmImportState === "done" && "Opening the Choose step…"}
                        {notebookLmImportState === "limit" && NOTEBOOKLM_PLAN_LIMIT_REACHED}
                        {notebookLmImportState === "error" && (error ?? "The transfer could not be completed.")}
                      </small>
                    </div>
                    {(notebookLmImportState === "reading" || notebookLmImportState === "importing") && (
                      <div className="orbit-loader orbit-loader--inline" aria-hidden="true"><span /></div>
                    )}
                  </li>
                </ol>
                {notebookLmLockedNotice}
                <div className="row">
                  {notebookLmImportState === "limit" ? (
                    <button className="btn btn-primary" onClick={backToNotebookLmSteps}>Back</button>
                  ) : notebookLmImportState === "error" ? (
                    <>
                      <button className="btn btn-primary" onClick={backToNotebookLmSteps}>Back to transfer steps</button>
                      <Link className="btn" to="/app/sources">Add content another way</Link>
                    </>
                  ) : notebookLmImportState === "done" ? (
                    <button
                      className="btn btn-primary"
                      onClick={() => {
                        setStep("goal");
                        navigate("/welcome", { replace: true });
                      }}
                    >
                      Continue to Choose
                    </button>
                  ) : (
                    <button className="btn" onClick={backToNotebookLmSteps}>Back</button>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="eyebrow">{source?.title ?? "Your archive"}</p>
                <h1>{indexingFailed ? "That did not land" : "Bringing your posts into orbit"}</h1>
                {live && <JobProgress job={live} />}
                {standardLockedNotice}
                {indexingFailed ? (
                  <div className="row">
                    <button className="btn btn-primary" onClick={() => setStep("connect")}>Try again</button>
                    <Link className="btn" to="/app/sources">Add posts another way</Link>
                  </div>
                ) : (
                  <>
                    <p className="muted">This takes a minute for big archives. While it runs, tell us what you want to do first.</p>
                    <button className="btn btn-primary" onClick={() => setStep("goal")}>Continue</button>
                  </>
                )}
              </>
            )}
          </section>
        )}

        {step === "goal" && (
          <section className="card welcome-card">
            <p className="eyebrow">{indexingDone ? (capped ? `${available} of ${found} posts indexed` : `${posts} posts indexed`) : "Still indexing in the background"}</p>
            <h1>What should we launch first?</h1>
            {lockedNotice}
            <div className="goal-grid">
              {GOALS.map((g) => (
                <button key={g.id} type="button" className={`goal${goal === g.id ? " on" : ""}`} onClick={() => setGoal(g.id)} aria-pressed={goal === g.id}>
                  <strong>{g.title}</strong>
                  <span className="muted">{g.body}</span>
                </button>
              ))}
            </div>
            {live && !indexingDone && !indexingFailed && <JobProgress job={live} compact />}
            <div className="row end">
              <button className="btn btn-primary" disabled={!goal || busy} onClick={() => setStep("ready")}>
                Next
              </button>
            </div>
          </section>
        )}

        {step === "ready" && (
          <section className="card welcome-card">
            <p className="eyebrow">Pre-flight check complete</p>
            <h1>{indexingDone ? `${capped ? available : posts} posts are in orbit` : "Almost there"}</h1>
            {!indexingDone && live && <JobProgress job={live} />}
            {lockedNotice}
            <p className="muted">
              {goal === "ask" && "We will put your whole archive in a notebook so you can start asking right away."}
              {goal === "audio" && "We will put your archive in a notebook with the audio studio ready."}
              {goal === "launch" && "Pick a post and we will build its Launch Kit."}
            </p>
            <div className="row end">
              <button className="btn" onClick={() => finish(null)}>
                Open All posts
              </button>
              <button className="btn btn-primary" disabled={!indexingDone || busy} onClick={() => finish(goal)}>
                {busy ? "Preparing..." : indexingDone ? "Launch" : "Waiting for posts..."}
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

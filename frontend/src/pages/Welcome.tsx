import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { docsApi, jobsApi, MAX_SOURCE_FILE_BYTES, MAX_SOURCE_FILE_LABEL, notebooksApi, settingsApi, sourcesApi, type NotebookLmImportResult } from "@notestack/shared/endpoints";
import type { Job, Source } from "@notestack/shared/types";
import { NotebookLmTransferButton } from "../components/NotebookLmTransferButton";
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
import { firstNotebookName } from "@notestack/shared/notebook";
import { classifyUrl, looksLikeArticle } from "@notestack/shared/urlScrapability";
import { PENDING_SOURCE_KEY } from "./Landing";

type Step = "connect" | "indexing";
type Mode = "link" | "file" | "notebooklm";
/** How a link is brought in: the site's whole feed, or just that one page. */
type LinkAs = "feed" | "url";

const MODES: { id: Mode; label: string }[] = [
  { id: "link", label: "Link" },
  { id: "file", label: "Upload files" },
  { id: "notebooklm", label: "Transfer from NotebookLM" },
];

const FILE_ACCEPT = ".md,.markdown,.txt,.vtt,.html,.htm,.pdf,text/vtt,text/markdown,text/plain,text/html,application/pdf";

const EXAMPLES = ["yourblog.com", "yourname.substack.com", "medium.com/@you"];

export const ONBOARDED_KEY = "ns_onboarded";

const tooLargeMessage = (names: string[]) =>
  `${names.slice(0, 3).join(", ")}${names.length > 3 ? " and others" : ""} ${names.length === 1 ? "is" : "are"} over ${MAX_SOURCE_FILE_LABEL}. Files can be up to ${MAX_SOURCE_FILE_LABEL}.`;

const fileRoomMessage = (room: number) =>
  room === 0
    ? "Your plan's posts are all used. Upgrade to add more."
    : `Your plan has room for ${room} ${room === 1 ? "file" : "files"}, so only the first ${room} were kept. Upgrade to add more.`;
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

/** First run: connect a blog, import an article or upload files, watch it index, then land in a new notebook holding those posts. */
export default function Welcome() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returningFromNotebookLm = searchParams.get("notebooklm") === "import";
  const [step, setStep] = useState<Step>("connect");
  const [mode, setMode] = useState<Mode>(() => notebookLmGuideWasOpen() ? "notebooklm" : "link");
  // A blog or a single article is worked out from the link (as on Sources); the hint under the box can switch it.
  const [override, setOverride] = useState<LinkAs | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const earlierJobs = useRef<string[]>([]);
  const [url, setUrl] = useState(takePending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [posts, setPosts] = useState(0);
  // Every post is in (or the NotebookLM import finished): the notebook can be named and opened.
  const [ready, setReady] = useState(false);
  // The posts that came in, and the new notebook's name: filled in from them, the writer's to change.
  const [docIds, setDocIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const sourceTitle = useRef<string | null>(null);
  const [opening, setOpening] = useState(false);
  const opened = useRef(false);
  const [extensionInstalled, setExtensionInstalled] = useState(isNotebookLmExtensionInstalled);
  const [waitingForStoreReturn, setWaitingForStoreReturn] = useState(false);
  const [notebookLmImportState, setNotebookLmImportState] = useState<"idle" | "reading" | "importing" | "done" | "limit" | "error">("idle");
  const [notebookLmImportResult, setNotebookLmImportResult] = useState<NotebookLmImportResult | null>(null);
  const [notebookLmLimitWarning, setNotebookLmLimitWarning] = useState<string | null>(null);
  const [notebookLmLaunchMessage, setNotebookLmLaunchMessage] = useState<string | null>(null);
  const notebookLmImportStarted = useRef(false);
  const autoStarted = useRef(false);
  // Posts the plan still has room for: null when it has no limit (or usage hasn't loaded; the server still refuses).
  const [fileRoom, setFileRoom] = useState<number | null>(null);

  const live = useJob(job, async (j) => {
    if (j.status !== "done") return;
    await waitForJobs(earlierJobs.current);
    const list = await docsApi.list({ limit: 5000 });
    setPosts(list.total);
    setDocIds(list.items.map((d) => d.id));
    setName(firstNotebookName(list.items, sourceTitle.current));
    setReady(true);
  });

  const { check, modal } = useSourceUrlCheck();

  const connect = async (value: string, as: LinkAs = looksLikeArticle(value) ? "url" : "feed") => {
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
    const all = Array.from(list ?? []);
    if (!all.length) return;
    const large = all.filter((f) => f.size > MAX_SOURCE_FILE_BYTES);
    const picked = all.filter((f) => f.size <= MAX_SOURCE_FILE_BYTES);
    const merged = [...files, ...picked.filter((f) => !files.some((c) => c.name === f.name && c.size === f.size))];
    // Each file becomes a post, so the list stops at the posts the plan still has room for.
    if (fileRoom !== null && merged.length > fileRoom) {
      setError(fileRoomMessage(fileRoom));
      setFiles(merged.slice(0, fileRoom));
    } else {
      setError(large.length ? tooLargeMessage(large.map((f) => f.name)) : null);
      setFiles(merged);
    }
  };

  useEffect(() => {
    if (!user) return;
    settingsApi
      .usage()
      .then((u) => setFileRoom(u.limits.indexed_posts < 0 ? null : Math.max(0, u.limits.indexed_posts - u.used.indexed_posts)))
      .catch(() => undefined);
  }, [user]);

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
        const list = await docsApi.list({ limit: 5000 }).catch(() => null);
        if (!active) return;
        if (list) {
          setPosts(list.total);
          setDocIds(list.items.map((d) => d.id));
          setName(firstNotebookName(list.items, "NotebookLM"));
        }
        try {
          sessionStorage.removeItem(NOTEBOOKLM_GUIDE_KEY);
        } catch {
          /* ignore */
        }
        // A transfer launched during onboarding always stays in onboarding. Once indexing finishes, its notebook
        // opens, even when the plan imported only part of the selection.
        continueTimer = window.setTimeout(() => setReady(true), 1100);
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

  /** The All posts notebook: where a skipped (or empty) onboarding ends, to add sources from there. */
  const toArchive = async () => {
    try {
      navigate(`/app/notebooks/${(await notebooksApi.archive()).id}`, { replace: true });
    } catch {
      navigate("/app/notebooks", { replace: true });
    }
  };

  /** A new notebook, under the name in the box, holding every post that came in; opened in place of onboarding. */
  const openNotebook = async () => {
    if (opened.current || !name.trim()) return;
    opened.current = true;
    setOpening(true);
    markOnboarded();
    if (docIds.length === 0) return toArchive();
    try {
      const nb = await notebooksApi.create(name.trim(), docIds);
      navigate(`/app/notebooks/${nb.id}`, { replace: true });
    } catch {
      navigate("/app/notebooks", { replace: true });
    }
  };

  const skip = () => {
    opened.current = true;
    markOnboarded();
    void toArchive();
  };

  if (loading) return <div className="boot"><div className="orbit-loader"><span /></div></div>;
  if (!user) return <Navigate to="/auth?mode=signup" replace />;

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
          navigate("/app/notebooks?upgrade=1", { replace: true });
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
          navigate("/app/notebooks?upgrade=1", { replace: true });
        }}
      >
        Index all {found} posts
      </button>
    </div>
  ) : null;
  const first = (user.name ?? user.email).split(/[ @]/)[0];

  const linkAs: LinkAs = override ?? (looksLikeArticle(url) ? "url" : "feed");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === "file") void upload();
    else if (mode === "link" && await check(url)) void connect(url, linkAs);
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

  const setNotebookLmGuide = (open: boolean) => selectMode(open ? "notebooklm" : "link");

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


  /** Indexed: the new notebook's name, filled in and changeable, and the button that opens it. */
  const nameForm = (
    <form
      className="welcome-name"
      onSubmit={(e) => {
        e.preventDefault();
        void openNotebook();
      }}
    >
      <label className="field">
        <span>Notebook name</span>
        <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <div className="row end">
        <button type="submit" className="btn btn-primary" disabled={opening || !name.trim()}>
          {opening ? "Opening…" : "Open my notebook"}
        </button>
      </div>
    </form>
  );

  return (
    <div className="page welcome">
      <SkyCanvas intensity={0.9} />
      <main className="welcome-wrap">
        <div className="welcome-top">
          <Logo size={36} />
          <button className="link-btn mono" onClick={skip}>
            Skip for now
          </button>
        </div>

        {step === "connect" && (
          <section className="card welcome-card">
            <p className="welcome-hello">
              Welcome aboard, <span>{first}</span>
            </p>
            <h1 className="welcome-center">Where does your writing live?</h1>
            <p className="muted welcome-center">Bring it in however suits you. We turn it into a research notebook you can question, hear and launch from.</p>
            <Tabs<Mode>
              tabs={MODES}
              value={mode}
              className="welcome-methods"
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
                    <NotebookLmTransferButton disabled={!extensionInstalled} onClick={beginNotebookLmExport} />
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
                  {mode === "link" && "Substack, Ghost, WordPress, Medium or anything with a feed, or one article. We work out which from the link."}
                  {mode === "file" && `Markdown, text, VTT transcripts, HTML or PDF: drafts, exports and posts that never had a feed. ${fileRoom === null ? "Add as many as you like." : `Your plan has room for ${fileRoom} ${fileRoom === 1 ? "file" : "files"}.`}`}
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
                      <span className="mono muted small">.md · .txt · .html · .pdf · up to {MAX_SOURCE_FILE_LABEL} each</span>
                    </label>
                  ) : (
                    <input
                      className="input"
                      autoFocus
                      placeholder="yourblog.com or an article link"
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        setOverride(null);
                      }}
                      aria-label="Blog, newsletter or article link"
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
                    {mode === "link" && linkAs === "feed" && (busy ? "Finding your feed..." : "Connect")}
                    {mode === "link" && linkAs === "url" && (busy ? "Importing..." : "Import article")}
                    {mode === "file" && (busy ? "Uploading..." : files.length === 1 ? "Upload 1 file" : `Upload ${files.length || ""} files`.replace("  ", " "))}
                  </button>
                </form>
                {mode === "link" && url.trim() && (
                  <p className="muted small source-method-help">
                    {linkAs === "feed" ? (
                      <>
                        We will pull in the whole archive and keep it in sync.{" "}
                        <button type="button" className="link-btn small" onClick={() => setOverride("url")}>Just this one page instead</button>
                      </>
                    ) : (
                      <>
                        Looks like a single article, so we will import just this page.{" "}
                        <button type="button" className="link-btn small" onClick={() => setOverride("feed")}>Connect the whole site instead</button>
                      </>
                    )}
                  </p>
                )}
                {mode === "link" && <SourceUrlHint url={url} />}
                {modal}
                {mode === "link" && !url.trim() && (
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
                        {notebookLmImportState === "done" && "Name your notebook below."}
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
                {notebookLmImportState === "done" && ready && nameForm}
                <div className="row">
                  {notebookLmImportState === "limit" ? (
                    <button className="btn btn-primary" onClick={backToNotebookLmSteps}>Back</button>
                  ) : notebookLmImportState === "error" ? (
                    <>
                      <button className="btn btn-primary" onClick={backToNotebookLmSteps}>Back to transfer steps</button>
                      <Link className="btn" to="/app/sources">Add content another way</Link>
                    </>
                  ) : notebookLmImportState === "done" ? null : (
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
                  ready ? (
                    nameForm
                  ) : (
                    <p className="muted">This takes a minute for big archives. Then name your notebook and open it.</p>
                  )
                )}
              </>
            )}
          </section>
        )}

      </main>
    </div>
  );
}

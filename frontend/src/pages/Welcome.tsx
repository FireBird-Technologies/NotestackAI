import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { docsApi, jobsApi, notebooksApi, sourcesApi } from "../api/endpoints";
import type { Job, Source } from "../api/types";
import Logo from "../components/Logo";
import SkyCanvas from "../components/SkyCanvas";
import { errorMessage, JobProgress, Tabs } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { useJob } from "../hooks/useJob";
import { PENDING_SOURCE_KEY } from "./Landing";

type Step = "connect" | "indexing" | "goal" | "ready";
type Goal = "ask" | "audio" | "launch";
type Mode = "feed" | "url" | "file";

const MODES: { id: Mode; label: string }[] = [
  { id: "feed", label: "Blog or newsletter" },
  { id: "url", label: "One article" },
  { id: "file", label: "Upload files" },
];

const FILE_ACCEPT = ".md,.markdown,.txt,.html,.htm,.pdf,text/markdown,text/plain,text/html,application/pdf";

const EXAMPLES = ["yourblog.com", "yourname.substack.com", "medium.com/@you"];

const GOALS: { id: Goal; title: string; body: string }[] = [
  { id: "ask", title: "Ask my archive", body: "Chat with everything you have written. Every answer cites the lines it came from." },
  { id: "audio", title: "Hear it as a podcast", body: "Two hosts talk through your best posts, grounded in your words." },
  { id: "launch", title: "Launch my next post", body: "Threads, LinkedIn, Notes, SEO and quote cards, in your voice." },
];

export const ONBOARDED_KEY = "ns_onboarded";

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
  const [step, setStep] = useState<Step>("connect");
  const [mode, setMode] = useState<Mode>("feed");
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
  const autoStarted = useRef(false);

  const live = useJob(job, async (j) => {
    if (j.status !== "done") return;
    await waitForJobs(earlierJobs.current);
    const list = await docsApi.list({ limit: 1 });
    setPosts(list.total);
    setStep((s) => (s === "indexing" ? "goal" : s === "goal" ? "goal" : "ready"));
  });

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

  // A URL pasted on the landing page starts connecting straight away.
  useEffect(() => {
    if (url && !autoStarted.current && user) {
      autoStarted.current = true;
      void connect(url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (loading) return <div className="boot"><div className="orbit-loader"><span /></div></div>;
  if (!user) return <Navigate to="/auth?mode=signup" replace />;

  const indexingDone = live?.status === "done";
  const indexingFailed = live?.status === "failed";
  // The ingest job lists the whole archive but indexes only the plan's limit; the rest waits behind an upgrade.
  const locked = Number(live?.result?.locked ?? 0);
  const capped = indexingDone && locked > 0;
  const available = Number(live?.result?.available ?? posts);
  const found = Number(live?.result?.found ?? posts);
  const lockedNotice = capped ? (
    <div className="welcome-cap">
      <div>
        <strong>
          We found {found} posts. The free plan indexed only your latest {available}.
        </strong>
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
  const first = (user.name ?? user.email).split(/[ @]/)[0];

  const finish = async (chosen: Goal | null) => {
    markOnboarded();
    if (!chosen || posts === 0) return navigate("/app", { replace: true });
    if (chosen === "launch") return navigate("/app/launchpad/kits", { replace: true });
    setBusy(true);
    try {
      const docs = await docsApi.list({ limit: 5000 });
      const nb = await notebooksApi.create(source?.title ? `${source.title} archive` : "My archive", docs.items.map((d) => d.id));
      navigate(chosen === "audio" ? `/app/notebooks/${nb.id}?studio=audio` : `/app/notebooks/${nb.id}`, { replace: true });
    } catch {
      navigate("/app", { replace: true });
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "file") void upload();
    else void connect(url, mode);
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
              {label}
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
              onChange={(m) => {
                setMode(m);
                setError(null);
              }}
            />
            <p className="muted small">
              {mode === "feed" && "Substack, Ghost, WordPress, Medium or anything with a feed. We find the feed, pull in your archive and keep it in sync."}
              {mode === "url" && "Any single article on the web. Add more later from Sources."}
              {mode === "file" && "Markdown, text, HTML or PDF: drafts, exports and posts that never had a feed. Add as many as you like."}
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
                      <button type="button" className="link-btn small" onClick={() => setFiles(files.filter((x) => x !== f))} aria-label={`Remove ${f.name}`}>
                        Remove
                      </button>
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
            {mode === "feed" && (
              <div className="welcome-examples mono muted">
                Try:{" "}
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" className="chip" onClick={() => setUrl(ex)}>
                    {ex}
                  </button>
                ))}
              </div>
            )}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </section>
        )}

        {step === "indexing" && (
          <section className="card welcome-card">
            <p className="eyebrow">{source?.title ?? "Your archive"}</p>
            <h1>{indexingFailed ? "That did not land" : "Bringing your posts into orbit"}</h1>
            {live && <JobProgress job={live} />}
            {lockedNotice}
            {indexingFailed ? (
              <div className="row">
                <button className="btn btn-primary" onClick={() => setStep("connect")}>
                  Try again
                </button>
                <Link className="btn" to="/app/sources">
                  Import posts another way
                </Link>
              </div>
            ) : (
              <>
                <p className="muted">This takes a minute for big archives. While it runs, tell us what you want to do first.</p>
                <button className="btn btn-primary" onClick={() => setStep("goal")}>
                  Continue
                </button>
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
                Go to Mission Control
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

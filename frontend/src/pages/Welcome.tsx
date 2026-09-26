import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { docsApi, notebooksApi, sourcesApi } from "../api/endpoints";
import type { Job, Source } from "../api/types";
import Logo from "../components/Logo";
import SkyCanvas from "../components/SkyCanvas";
import { errorMessage, JobProgress } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { useJob } from "../hooks/useJob";
import { PENDING_SOURCE_KEY } from "./Landing";

type Step = "connect" | "indexing" | "goal" | "ready";
type Goal = "ask" | "audio" | "launch";

const EXAMPLES = ["yourname.substack.com", "blog.example.com", "medium.com/@you"];

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

/** First run: connect a blog, watch it index, pick what to do first, land somewhere useful. */
export default function Welcome() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("connect");
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
    const list = await docsApi.list({ limit: 1 });
    setPosts(list.total);
    setStep((s) => (s === "indexing" ? "goal" : s === "goal" ? "goal" : "ready"));
  });

  const connect = async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sourcesApi.connect(value.trim());
      setSource(res.source);
      setJob(res.job);
      setStep("indexing");
    } catch (e) {
      setError(errorMessage(e, "We could not reach that address."));
    } finally {
      setBusy(false);
    }
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
  const first = (user.name ?? user.email).split(/[ @]/)[0];

  const finish = async (chosen: Goal | null) => {
    markOnboarded();
    if (!chosen || posts === 0) return navigate("/app", { replace: true });
    if (chosen === "launch") return navigate("/app/launch-kit", { replace: true });
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
    void connect(url);
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
            <h1>Where do you publish?</h1>
            <p className="muted">
              Paste your Substack, Ghost, Medium or blog address. We find the feed, pull in your archive and turn it into a research notebook you can
              question, hear and launch from.
            </p>
            <form onSubmit={submit} className="welcome-form">
              <input
                className="input"
                autoFocus
                placeholder="yourname.substack.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-label="Blog or Substack address"
              />
              <button className="btn btn-primary" disabled={busy || !url.trim()}>
                {busy ? "Finding your feed..." : "Connect"}
              </button>
            </form>
            <div className="welcome-examples mono muted">
              Try:{" "}
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" className="chip" onClick={() => setUrl(ex)}>
                  {ex}
                </button>
              ))}
            </div>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <p className="muted small">
              No feed? You can <Link to="/app/sources">import single articles or upload files</Link> instead.
            </p>
          </section>
        )}

        {step === "indexing" && (
          <section className="card welcome-card">
            <p className="eyebrow">{source?.title ?? "Your archive"}</p>
            <h1>{indexingFailed ? "That did not land" : "Bringing your posts into orbit"}</h1>
            {live && <JobProgress job={live} />}
            {indexingFailed ? (
              <div className="row">
                <button className="btn btn-primary" onClick={() => setStep("connect")}>
                  Try another address
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
            <p className="eyebrow">{indexingDone ? `${posts} posts indexed` : "Still indexing in the background"}</p>
            <h1>What should we launch first?</h1>
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
            <h1>{indexingDone ? `${posts} posts are in orbit` : "Almost there"}</h1>
            {!indexingDone && live && <JobProgress job={live} />}
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

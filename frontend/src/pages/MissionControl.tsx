import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { artifactsApi, docsApi, jobsApi, launchpadApi, notebooksApi, resurfaceApi, sourcesApi, type GenerateBody } from "../api/endpoints";
import type { Artifact, CalendarItem, Doc, Job, NotebookSummary, ResurfaceItem, Source } from "../api/types";
import { LaunchWindowIcon, PlanetIcon, RocketIcon, TelescopeIcon } from "../components/icons/Icons";
import { errorMessage, formatDate, JobProgress, StatusPill } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { useJobMap } from "../hooks/useJob";
import { AddSource } from "./Sources";
import { PENDING_SOURCE_KEY } from "./Landing";
import { ONBOARDED_KEY } from "./Welcome";

function onboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return true;
  }
}

type Plan = { name: string };

const JOB_LABELS: Record<string, string> = {
  ingest: "Syncing a source",
  import_url: "Importing an article",
  import_upload: "Importing a file",
  topics: "Mapping topics",
  voice_profile: "Building your writing voice",
  voice_clone: "Cloning your voice",
  resurface_scan: "Finding posts worth resharing",
  summary: "Writing a summary",
  audio_overview: "Recording an audio overview",
  video: "Making a video",
  quote_card: "Rendering a quote card",
  carousel: "Rendering a carousel",
  launch_kit: "Building a Launch Kit",
  render: "Rendering",
};

/** Home: ask the archive, one-click creation, and only the next thing worth doing. */
export default function MissionControl() {
  const { user } = useAuth();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [recent, setRecent] = useState<Artifact[]>([]);
  const [upcoming, setUpcoming] = useState<CalendarItem[]>([]);
  const [newest, setNewest] = useState<Doc | null>(null);
  const [reshare, setReshare] = useState<ResurfaceItem[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    const [s, n, p, a, c, d, r] = await Promise.all([
      sourcesApi.list(),
      notebooksApi.list(),
      api<{ plan: Plan }>("/api/billing/me"),
      artifactsApi.list({ limit: 8 }),
      launchpadApi.items({ start: new Date().toISOString(), status: "scheduled,draft" }),
      docsApi.list({ limit: 20 }),
      resurfaceApi.get().catch(() => null),
    ]);
    setSources(s);
    // First visit with nothing connected: run the guided setup once.
    if (s.length === 0 && !onboarded()) {
      navigate("/welcome", { replace: true });
      return;
    }
    setNotebooks(n);
    setPlan(p.plan);
    setRecent(a.items);
    setUpcoming(c.slice(0, 5));
    setNewest(d.items.find((x) => !x.locked) ?? null);
    setReshare((r?.evergreen ?? []).slice(0, 3));
  }, [navigate]);

  const { jobs, watch } = useJobMap(() => refresh());

  useEffect(() => {
    refresh().catch(() => setError("Could not load your dashboard. Refresh to try again."));
    jobsApi.active().then((active) => active.forEach((j) => watch(j.id, j)));
    if (started.current) return;
    started.current = true;
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(PENDING_SOURCE_KEY);
      sessionStorage.removeItem(PENDING_SOURCE_KEY);
    } catch {
      /* ignore */
    }
    if (pending) {
      sourcesApi.connect(pending).then(
        (res) => {
          watch(res.job.id, res.job);
          refresh();
        },
        (e) => setError(errorMessage(e, "Could not add that source.")),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const ask = (e: FormEvent) => {
    e.preventDefault();
    void run("ask", async () => {
      const nb = await notebooksApi.archive();
      navigate(`/app/notebooks/${nb.id}${question.trim() ? `?q=${encodeURIComponent(question.trim())}` : ""}`);
    });
  };
  const create = (key: string, body: GenerateBody) =>
    run(key, async () => {
      await artifactsApi.generate(body);
      navigate("/app/studio");
    });
  const launch = (doc: Doc) =>
    run(`kit-${doc.id}`, async () => {
      const kit = await artifactsApi.generate({ type: "launch_kit", document_id: doc.id });
      navigate(`/app/launch-kit?kit=${kit.id}`);
    });

  const totalDocs = (sources ?? []).reduce((n, s) => n + s.document_count, 0);
  const hasPosts = totalDocs > 0;
  const activeJobs = Object.values(jobs).filter((j: Job) => j.status === "queued" || j.status === "running" || j.status === "failed");
  const lastKit = recent.find((a) => a.type === "launch_kit" && a.status === "ready");
  const next: { text: string; action: ReactNode } | null = !hasPosts
    ? null
    : !lastKit && newest
      ? {
          text: `Launch your newest post, "${newest.title}", with hooks, threads and SEO in your voice.`,
          action: (
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => launch(newest)}>
              {busy === `kit-${newest.id}` ? "Launching..." : "Generate Launch Kit"}
            </button>
          ),
        }
      : lastKit && upcoming.length === 0
        ? {
            text: `Your Launch Kit for "${lastKit.title}" is ready. Put it on the calendar.`,
            action: (
              <Link className="btn btn-primary" to={`/app/launch-kit?kit=${lastKit.id}`}>
                Schedule it
              </Link>
            ),
          }
        : null;

  const first = (user?.name ?? user?.email ?? "").split(/[ @]/)[0];

  return (
    <div className="mc">
      <header className="mc-head">
        <div>
          <p className="eyebrow">Mission Control</p>
          <h1>Good to see you, {first}</h1>
        </div>
        {plan && <span className="badge">{plan.name} plan</span>}
      </header>
      {error && <p className="error-text">{error}</p>}

      {sources && !hasPosts ? (
        <section className="card mc-hero stack">
          <h2>Bring in your writing</h2>
          <p className="muted">Connect a blog or newsletter, import an article or drop in files. Everything else starts from here.</p>
          <AddSource
            onAdded={(source, job) => {
              setSources((list) => [...(list ?? []).filter((s) => s.id !== source.id), source]);
              watch(job.id, job);
            }}
          />
        </section>
      ) : (
        <>
          <section className="card mc-hero">
            <form onSubmit={ask} className="mc-ask">
              <TelescopeIcon size={22} />
              <input
                className="input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask anything about your writing: what have I said about pricing?"
                aria-label="Ask your archive"
              />
              <button className="btn btn-primary" disabled={busy !== null}>
                {busy === "ask" ? "Opening..." : "Ask"}
              </button>
            </form>
            <div className="mc-actions">
              <button className="mc-action" disabled={busy !== null || !hasPosts} onClick={() => create("audio", { type: "audio_overview", archive: true, format: "deep_dive", minutes: 6 })}>
                <PlanetIcon size={28} />
                <strong>{busy === "audio" ? "Starting..." : "Audio overview"}</strong>
                <span className="muted small">Two hosts, 6 minutes, your whole archive</span>
              </button>
              <Link className="mc-action" to="/app/videos/new">
                <LaunchWindowIcon size={28} />
                <strong>Video</strong>
                <span className="muted small">Turn a post or link into a narrated video</span>
              </Link>
              <button className="mc-action" disabled={busy !== null || !newest} onClick={() => newest && launch(newest)}>
                <RocketIcon size={28} />
                <strong>{newest && busy === `kit-${newest.id}` ? "Launching..." : "Launch newest post"}</strong>
                <span className="muted small clamp-1">{newest ? newest.title : "No indexed posts yet"}</span>
              </button>
              <Link className="mc-action" to="/app/studio">
                <span className="mc-more" aria-hidden="true">
                  +
                </span>
                <strong>More formats</strong>
                <span className="muted small">Explainers, quote cards, audiograms</span>
              </Link>
            </div>
          </section>

          {next && (
            <section className="mc-next">
              <p>{next.text}</p>
              {next.action}
            </section>
          )}
        </>
      )}

      {activeJobs.length > 0 && (
        <section className="card stack">
          <h2>In flight</h2>
          {activeJobs.map((j) => (
            <div key={j.id}>
              <p className="mono muted small">{JOB_LABELS[j.kind] ?? j.kind}</p>
              <JobProgress job={j} compact />
            </div>
          ))}
        </section>
      )}

      {hasPosts && (
        <section className="mc-stats">
          <Link to="/app/sources" className="mc-stat">
            <strong>{totalDocs}</strong>
            <span className="muted small">posts in {sources?.length} {sources?.length === 1 ? "source" : "sources"}</span>
          </Link>
          <Link to="/app/notebooks" className="mc-stat">
            <strong>{notebooks.length}</strong>
            <span className="muted small">notebooks</span>
          </Link>
          <Link to="/app/archive" className="mc-stat">
            <strong>{recent.length}</strong>
            <span className="muted small">recent launches</span>
          </Link>
          <Link to="/app/launchpad" className="mc-stat">
            <strong>{upcoming.length}</strong>
            <span className="muted small">scheduled</span>
          </Link>
        </section>
      )}

      {(recent.length > 0 || upcoming.length > 0 || reshare.length > 0) && (
        <section className="mc-grid">
          {recent.length > 0 && (
            <div className="card mc-card">
              <div className="row between">
                <h2>Recent launches</h2>
                <Link to="/app/archive" className="mono muted small-link">
                  Library
                </Link>
              </div>
              <ul className="recent-list">
                {recent.map((a) => (
                  <li key={a.id}>
                    <Link to={a.type === "launch_kit" ? `/app/launch-kit?kit=${a.id}` : a.notebook_id ? `/app/notebooks/${a.notebook_id}` : "/app/archive"}>{a.title}</Link>
                    <span className="row">
                      <span className="mono muted">{formatDate(a.created_at)}</span>
                      <StatusPill status={a.status} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="stack">
            {reshare.length > 0 && (
              <div className="card mc-card">
                <div className="row between">
                  <h2>Worth resharing</h2>
                  <Link to="/app/launchpad" className="mono muted small-link">
                    More ideas
                  </Link>
                </div>
                <ul className="recent-list">
                  {reshare.map((i) => (
                    <li key={i.id}>
                      <span>
                        <strong>{i.title}</strong>
                        {i.angle && <span className="muted small"> · {i.angle}</span>}
                      </span>
                      <button className="btn btn-small" disabled={busy !== null} onClick={() => launch(i)}>
                        {busy === `kit-${i.id}` ? "Launching..." : "Launch Kit"}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {upcoming.length > 0 && (
              <div className="card mc-card">
                <div className="row between">
                  <h2>Coming up</h2>
                  <Link to="/app/launchpad" className="mono muted small-link">
                    Calendar
                  </Link>
                </div>
                <ul className="recent-list">
                  {upcoming.map((i) => (
                    <li key={i.id}>
                      <Link to={`/app/launchpad?item=${i.id}`}>
                        <strong>{i.platform_label}</strong> <span className="muted">{i.content.slice(0, 70)}</span>
                      </Link>
                      <span className="mono muted">{formatDate(i.scheduled_at, true)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

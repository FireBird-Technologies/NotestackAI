import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { artifactsApi, jobsApi, launchpadApi, notebooksApi, sourcesApi, voiceApi } from "../api/endpoints";
import type { Artifact, CalendarItem, Job, NotebookSummary, Source } from "../api/types";
import { CheckIcon } from "../components/icons/Icons";
import { formatDate, JobProgress, StatusPill } from "../components/ui";
import { useAuth } from "../hooks/useAuth";
import { useJobMap } from "../hooks/useJob";
import { AddSource } from "./Sources";
import { PENDING_SOURCE_KEY } from "./Landing";

type Plan = { name: string };

const JOB_LABELS: Record<string, string> = {
  ingest: "Syncing a source",
  import_url: "Importing an article",
  import_upload: "Importing a file",
  topics: "Mapping topics",
  voice_profile: "Building your voice profile",
  voice_clone: "Cloning your voice",
  resurface_scan: "Scoring evergreen posts",
  summary: "Writing a summary",
  audio_overview: "Recording an audio overview",
  video: "Making a video",
  quote_card: "Rendering a quote card",
  carousel: "Rendering a carousel",
  launch_kit: "Building a Launch Kit",
  render: "Rendering",
};

export default function MissionControl() {
  const { user } = useAuth();
  const [sources, setSources] = useState<Source[]>([]);
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [recent, setRecent] = useState<Artifact[]>([]);
  const [upcoming, setUpcoming] = useState<CalendarItem[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [hasVoice, setHasVoice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const refresh = useCallback(async () => {
    const [s, n, p, a, c, v] = await Promise.all([
      sourcesApi.list(),
      notebooksApi.list(),
      api<{ plan: Plan }>("/api/billing/me"),
      artifactsApi.list({ limit: 6 }),
      launchpadApi.items({ start: new Date().toISOString(), status: "scheduled,draft" }),
      voiceApi.get(),
    ]);
    setSources(s);
    setNotebooks(n);
    setPlan(p.plan);
    setRecent(a.items);
    setUpcoming(c.slice(0, 5));
    setHasVoice(Boolean(v.profile));
  }, []);

  const { jobs, watch } = useJobMap(() => refresh());

  useEffect(() => {
    refresh().catch(() => setError("Could not reach Mission Control. Is the API running?"));
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
        (e) => setError(e instanceof Error ? e.message : "Could not add that source."),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const totalDocs = sources.reduce((n, s) => n + s.document_count, 0);
  const activeJobs = Object.values(jobs).filter((j: Job) => j.status === "queued" || j.status === "running" || j.status === "failed");
  const checklist = [
    { done: sources.length > 0 && totalDocs > 0, label: "Connect your archive", to: "/app/sources" },
    { done: hasVoice, label: "Build your voice profile", to: "/app/voice" },
    { done: notebooks.length > 0, label: "Open a research notebook", to: "/app/notebooks" },
    { done: recent.some((a) => a.type === "launch_kit"), label: "Make your first Launch Kit", to: "/app/launch-kit" },
    { done: upcoming.length > 0, label: "Schedule a launch", to: "/app/launchpad" },
  ];

  return (
    <div className="mc">
      <header className="mc-head">
        <div>
          <p className="eyebrow">Mission Control</p>
          <h1>Good to see you, {(user?.name ?? user?.email ?? "").split(/[ @]/)[0]}</h1>
        </div>
        {plan && <span className="badge">{plan.name} plan · early access</span>}
      </header>
      {error && <p className="error-text">{error}</p>}

      {checklist.some((c) => !c.done) && (
        <section className="card checklist">
          <p className="eyebrow">Pre-flight checklist</p>
          <ol>
            {checklist.map((c) => (
              <li key={c.label} className={c.done ? "done" : ""}>
                <span className="check-dot">{c.done && <CheckIcon size={14} />}</span>
                <Link to={c.to}>{c.label}</Link>
              </li>
            ))}
          </ol>
        </section>
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

      <section className="mc-grid">
        <div className="card mc-card mc-sources">
          <div className="row between">
            <h2>Sources</h2>
            <Link to="/app/sources" className="mono muted small-link">
              Manage
            </Link>
          </div>
          <AddSource
            onAdded={(source, job) => {
              setSources((list) => [...list.filter((s) => s.id !== source.id), source]);
              watch(job.id, job);
            }}
          />
          <ul className="source-list">
            {sources.map((s) => (
              <li key={s.id} className="source-row">
                <div className="source-title">
                  <strong>{s.title ?? s.feed_url}</strong>
                  <span className="mono muted">
                    {s.is_imports ? "imports" : s.platform} · {s.document_count} posts
                  </span>
                </div>
                <StatusPill status={s.sync_status} />
              </li>
            ))}
            {sources.length === 0 && <li className="muted">No sources yet. A lone satellite, waiting for signal.</li>}
          </ul>
        </div>

        <div className="card mc-card">
          <div className="row between">
            <h2>Notebooks</h2>
            <Link to="/app/notebooks" className="mono muted small-link">
              All
            </Link>
          </div>
          <p className="muted">{totalDocs} posts indexed across your sources.</p>
          <ul className="nb-list">
            {notebooks.slice(0, 6).map((n) => (
              <li key={n.id}>
                <Link to={`/app/notebooks/${n.id}`} className="nb-link">
                  {n.title}
                </Link>
                <span className="mono muted"> {n.document_count} posts</span>
              </li>
            ))}
          </ul>
          <Link className="btn" to="/app/notebooks">
            {notebooks.length ? "Open notebooks" : "Create a notebook"}
          </Link>
        </div>

        <div className="card mc-card">
          <div className="row between">
            <h2>Recent launches</h2>
            <Link to="/app/archive" className="mono muted small-link">
              Archive
            </Link>
          </div>
          {recent.length === 0 && <p className="muted">Audio overviews, videos and launch kits will show up here.</p>}
          <ul className="recent-list">
            {recent.map((a) => (
              <li key={a.id}>
                <Link to={a.type === "launch_kit" ? `/app/launch-kit?kit=${a.id}` : a.notebook_id ? `/app/notebooks/${a.notebook_id}` : "/app/archive"}>
                  {a.title}
                </Link>
                <span className="row">
                  <span className="mono muted">{formatDate(a.created_at)}</span>
                  <StatusPill status={a.status} />
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card mc-card">
          <div className="row between">
            <h2>Launchpad</h2>
            <Link to="/app/launchpad" className="mono muted small-link">
              Calendar
            </Link>
          </div>
          {upcoming.length === 0 && <p className="muted">Nothing scheduled. Quiet moon tonight.</p>}
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
      </section>
    </div>
  );
}

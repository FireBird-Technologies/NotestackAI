import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, post } from "../api/client";
import { streamSSE } from "../api/stream";
import { PENDING_SOURCE_KEY } from "./Landing";
import { useAuth } from "../hooks/useAuth";

type Job = { id: string; status: string; progress: number; message: string | null; error: string | null };
type Source = {
  id: string;
  feed_url: string;
  title: string | null;
  platform: string;
  sync_status: string;
  document_count: number;
};
type Notebook = { id: string; title: string; description: string | null };
type Plan = { name: string };
type Doc = { id: string };

export function AscentBar({ job }: { job: Job }) {
  const pct = Math.round(job.progress * 100);
  return (
    <div className="ascent" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="ascent-track">
        <div className="ascent-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="ascent-meta mono">
        <span>{job.status === "failed" ? job.error ?? "Failed" : job.message ?? "Queued for launch"}</span>
        <span>{pct}%</span>
      </div>
    </div>
  );
}

export default function MissionControl() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [sources, setSources] = useState<Source[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const refresh = useCallback(async () => {
    const [s, n, p] = await Promise.all([
      api<Source[]>("/api/sources"),
      api<Notebook[]>("/api/notebooks"),
      api<{ plan: Plan }>("/api/billing/me"),
    ]);
    setSources(s);
    setNotebooks(n);
    setPlan(p.plan);
  }, []);

  const watch = useCallback(
    (sourceId: string, job: Job) => {
      setJobs((j) => ({ ...j, [sourceId]: job }));
      streamSSE(`/api/jobs/${job.id}/events`, (_e, data) => {
        const next = data as Job;
        setJobs((j) => ({ ...j, [sourceId]: next }));
        if (next.status === "done" || next.status === "failed") refresh();
      }).catch(() => {
        /* the job row still has the final state */
      });
    },
    [refresh],
  );

  const addSource = useCallback(
    async (value: string) => {
      setError(null);
      try {
        const res = await post<{ source: Source; job: Job }>("/api/sources", { url: value });
        setSources((s) => (s.some((x) => x.id === res.source.id) ? s : [...s, res.source]));
        watch(res.source.id, res.job);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Could not add that source.");
      }
    },
    [watch],
  );

  useEffect(() => {
    refresh().catch(() => setError("Could not reach Mission Control. Is the API running?"));
    if (started.current) return;
    started.current = true;
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(PENDING_SOURCE_KEY);
      sessionStorage.removeItem(PENDING_SOURCE_KEY);
    } catch {
      /* ignore */
    }
    if (pending) addSource(pending);
  }, [refresh, addSource]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) addSource(url.trim());
    setUrl("");
  };

  const createNotebookFromAll = async () => {
    const nb = await post<Notebook>("/api/notebooks", { title: "My archive" });
    const docs = await api<Doc[]>("/api/documents");
    await post(`/api/notebooks/${nb.id}/documents`, { document_ids: docs.map((d) => d.id) });
    navigate(`/app/notebooks/${nb.id}`);
  };

  const totalDocs = sources.reduce((n, s) => n + s.document_count, 0);

  return (
    <div className="mc">
      <header className="mc-head">
        <div>
          <p className="eyebrow">Mission Control</p>
          <h1>Good to see you, {(user?.name ?? user?.email ?? "").split(/[ @]/)[0]}</h1>
        </div>
        {plan && <span className="badge">{plan.name} plan · early access</span>}
      </header>

      <section className="mc-grid">
        <div className="card mc-card mc-sources">
          <h2>Sources</h2>
          <p className="muted">Connect a Substack, Ghost, Medium or any RSS feed.</p>
          <form onSubmit={onSubmit} className="inline-form">
            <input
              className="input"
              placeholder="yourname.substack.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Feed or Substack URL"
            />
            <button className="btn btn-primary" type="submit">
              Connect
            </button>
          </form>
          {error && <p className="error-text">{error}</p>}
          <ul className="source-list">
            {sources.map((s) => (
              <li key={s.id} className="source-row">
                <div className="source-title">
                  <strong>{s.title ?? s.feed_url}</strong>
                  <span className="mono muted">
                    {s.platform} · {s.document_count} posts · {s.sync_status}
                  </span>
                </div>
                {jobs[s.id] && jobs[s.id].status !== "done" && <AscentBar job={jobs[s.id]} />}
              </li>
            ))}
            {sources.length === 0 && <li className="muted">No sources yet. A lone satellite, waiting for signal.</li>}
          </ul>
        </div>

        <div className="card mc-card">
          <h2>Notebooks</h2>
          <p className="muted">{totalDocs} posts indexed across your sources.</p>
          <ul className="nb-list">
            {notebooks.map((n) => (
              <li key={n.id}>
                <Link to={`/app/notebooks/${n.id}`} className="nb-link">
                  {n.title}
                </Link>
              </li>
            ))}
          </ul>
          <button className="btn" onClick={createNotebookFromAll} disabled={totalDocs === 0}>
            New notebook from all posts
          </button>
        </div>

        <div className="card mc-card">
          <h2>Recent launches</h2>
          <p className="muted">Audio overviews, videos and launch kits will show up here.</p>
        </div>

        <div className="card mc-card">
          <h2>Launchpad</h2>
          <p className="muted">Nothing scheduled. Quiet moon tonight.</p>
        </div>
      </section>
    </div>
  );
}

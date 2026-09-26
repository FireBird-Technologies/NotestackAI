import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { notebooksApi, topicsApi } from "../api/endpoints";
import type { Job, TopicDetail, TopicMap as TopicMapData } from "../api/types";
import { Reader } from "../components/Reader";
import { EmptyState, errorMessage, formatDate, JobProgress, Loading, PageHeader } from "../components/ui";
import { useJob } from "../hooks/useJob";

const W = 900;
const H = 620;

type P = { id: string; x: number; y: number; vx: number; vy: number; r: number };

/** Small deterministic force layout: repulsion between all nodes, springs along edges, pull to center. */
function layout(data: TopicMapData): Map<string, P> {
  const maxCount = Math.max(1, ...data.nodes.map((n) => n.post_count));
  const nodes: P[] = data.nodes.map((n, i) => {
    const a = (i / Math.max(1, data.nodes.length)) * Math.PI * 2 * 2.39996;
    const rad = 60 + (i % 7) * 30;
    return { id: n.id, x: W / 2 + Math.cos(a) * rad, y: H / 2 + Math.sin(a) * rad, vx: 0, vy: 0, r: 6 + 22 * Math.sqrt(n.post_count / maxCount) };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const maxW = Math.max(1, ...data.edges.map((e) => e.weight));
  for (let step = 0; step < 320; step++) {
    const cool = 1 - step / 320;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = 0.1;
          dy = 0.1;
          d2 = 0.02;
        }
        const minD = a.r + b.r + 26;
        const f = (2400 / d2) * (d2 < minD * minD ? 3 : 1);
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
    }
    for (const e of data.edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = 110 - 40 * (e.weight / maxW);
      const f = (d - target) * 0.02 * (0.5 + e.weight / maxW);
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.004;
      n.vy += (H / 2 - n.y) * 0.004;
      n.x += Math.max(-12, Math.min(12, n.vx)) * cool;
      n.y += Math.max(-12, Math.min(12, n.vy)) * cool;
      n.x = Math.max(n.r + 10, Math.min(W - n.r - 10, n.x));
      n.y = Math.max(n.r + 10, Math.min(H - n.r - 10, n.y));
      n.vx *= 0.6;
      n.vy *= 0.6;
    }
  }
  return byId;
}

export default function TopicMap() {
  const [data, setData] = useState<TopicMapData | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [selected, setSelected] = useState<TopicDetail | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = () => topicsApi.map().then(setData, () => setError("Could not load the topic map."));
  useEffect(() => {
    load();
  }, []);
  const live = useJob(job, (j) => {
    if (j.status === "done") load();
  });

  const positions = useMemo(() => (data ? layout(data) : new Map<string, P>()), [data]);
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    data?.edges.forEach((e) => {
      if (!m.has(e.source)) m.set(e.source, new Set());
      if (!m.has(e.target)) m.set(e.target, new Set());
      m.get(e.source)!.add(e.target);
      m.get(e.target)!.add(e.source);
    });
    return m;
  }, [data]);

  const focus = hover ?? selected?.id ?? null;
  const running = live && (live.status === "queued" || live.status === "running");

  const rebuild = async (full: boolean) => {
    setError(null);
    try {
      setJob(await topicsApi.rebuild(full));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const open = async (id: string) => setSelected(await topicsApi.get(id));

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Topic map" title="The constellations in your archive">
        <button className="btn" disabled={Boolean(running)} onClick={() => rebuild(false)}>
          {data?.has_untagged_posts ? "Map new posts" : "Refresh"}
        </button>
        <button className="btn" disabled={Boolean(running)} onClick={() => rebuild(true)}>
          Rebuild from scratch
        </button>
      </PageHeader>
      {live && (running || live.status === "failed") && <JobProgress job={live} />}
      {error && <p className="error-text">{error}</p>}
      {!data && <Loading />}
      {data && data.nodes.length === 0 && !running && (
        <EmptyState
          title="No constellations yet"
          body="Notestack reads each post and names what it is about, then links topics that appear together. New posts are mapped automatically after each sync."
          action={
            <button className="btn btn-primary" onClick={() => rebuild(false)}>
              Map my archive
            </button>
          }
        />
      )}
      {data && data.nodes.length > 0 && (
        <div className="map-layout">
          <div className="card map-canvas">
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Topic constellation">
              <defs>
                <radialGradient id="star" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#ffffff" />
                  <stop offset="55%" stopColor="#217cff" stopOpacity="0.9" />
                  <stop offset="100%" stopColor="#217cff" stopOpacity="0" />
                </radialGradient>
              </defs>
              {data.edges.map((e) => {
                const a = positions.get(e.source);
                const b = positions.get(e.target);
                if (!a || !b) return null;
                const lit = focus && (e.source === focus || e.target === focus);
                return (
                  <line
                    key={`${e.source}-${e.target}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={lit ? "#217cff" : "#ffffff"}
                    strokeOpacity={lit ? 0.9 : focus ? 0.05 : 0.14}
                    strokeWidth={lit ? 1.6 : 1}
                  />
                );
              })}
              {data.nodes.map((n) => {
                const p = positions.get(n.id)!;
                const dim = focus && focus !== n.id && !neighbors.get(focus)?.has(n.id);
                const active = selected?.id === n.id;
                return (
                  <g
                    key={n.id}
                    className="map-node"
                    opacity={dim ? 0.25 : 1}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => open(n.id)}
                    tabIndex={0}
                    role="button"
                    aria-label={`${n.name}, ${n.post_count} posts`}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && open(n.id)}
                  >
                    <circle cx={p.x} cy={p.y} r={p.r * 1.9} fill="url(#star)" opacity={active ? 0.9 : 0.45} />
                    <circle cx={p.x} cy={p.y} r={Math.max(3, p.r * 0.45)} fill="#ffffff" />
                    <text x={p.x} y={p.y + p.r + 16} textAnchor="middle" className="map-label">
                      {n.name}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
          <aside className="card map-side">
            {!selected && (
              <>
                <p className="eyebrow">{data.nodes.length} topics</p>
                <p className="muted">Click a star to see its posts. Brighter lines mean topics that appear together more often.</p>
                <ol className="topic-rank">
                  {data.nodes.slice(0, 12).map((n) => (
                    <li key={n.id}>
                      <button className="link-btn" onClick={() => open(n.id)}>
                        {n.name}
                      </button>
                      <span className="mono muted"> {n.post_count}</span>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {selected && (
              <>
                <button className="link-btn mono muted" onClick={() => setSelected(null)}>
                  All topics
                </button>
                <h2>{selected.name}</h2>
                {selected.summary && <p className="muted">{selected.summary}</p>}
                <button
                  className="btn btn-small btn-primary"
                  onClick={async () => {
                    const nb = await notebooksApi.fromTopic(selected.id);
                    navigate(`/app/notebooks/${nb.id}`);
                  }}
                >
                  Make a notebook from this topic
                </button>
                <ul className="doc-list">
                  {selected.posts.map((d) => (
                    <li key={d.id} className="doc-row">
                      <button className="link-btn doc-title" onClick={() => setReading(d.id)}>
                        {d.title}
                      </button>
                      <span className="mono muted">{formatDate(d.published_at)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        </div>
      )}
      {reading && <Reader documentId={reading} onClose={() => setReading(null)} />}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { notebooksApi, topicsApi } from "../api/endpoints";
import type { Job, TopicDetail, TopicMap as TopicMapData } from "../api/types";
import { Reader } from "../components/Reader";
import { EmptyState, errorMessage, formatDate, JobProgress, Loading, PageHeader } from "../components/ui";
import { useJob } from "../hooks/useJob";
import { playClick } from "../lib/sound";

const W = 900;
const H = 620;

type P = { id: string; x: number; y: number; vx: number; vy: number; r: number };
type View = { x: number; y: number; w: number; h: number };

const HOME: View = { x: 0, y: 0, w: W, h: H };
const MIN_W = W / 8;
const MAX_W = W * 1.6;

/** Wheel to zoom around the cursor, drag to pan, buttons and keys for the rest. */
function useZoomPan(svgRef: RefObject<SVGSVGElement>) {
  const [view, setView] = useState<View>(HOME);
  const drag = useRef<{ px: number; py: number; view: View; moved: boolean } | null>(null);

  const toSvg = useCallback(
    (clientX: number, clientY: number, v: View) => {
      const rect = svgRef.current!.getBoundingClientRect();
      return { x: v.x + ((clientX - rect.left) / rect.width) * v.w, y: v.y + ((clientY - rect.top) / rect.height) * v.h };
    },
    [svgRef],
  );

  const scaleView = (v: View, factor: number, fx: number, fy: number): View => {
    const w = Math.max(MIN_W, Math.min(MAX_W, v.w * factor));
    const h = (w / W) * H;
    // Keep the focus point fixed on screen while scaling.
    return { x: fx - ((fx - v.x) * w) / v.w, y: fy - ((fy - v.y) * h) / v.h, w, h };
  };

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((v) => scaleView(v, factor, cx ?? v.x + v.w / 2, cy ?? v.y + v.h / 2));
  }, []);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        const p = toSvg(e.clientX, e.clientY, v);
        return scaleView(v, Math.exp(Math.max(-0.4, Math.min(0.4, e.deltaY * 0.0015))), p.x, p.y);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest(".map-node")) return;
    drag.current = { px: e.clientX, py: e.clientY, view, moved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = ((e.clientX - d.px) / rect.width) * d.view.w;
    const dy = ((e.clientY - d.py) / rect.height) * d.view.h;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    setView({ ...d.view, x: d.view.x - dx, y: d.view.y - dy });
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = null;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
  };
  const onDoubleClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest(".map-node")) return;
    const p = toSvg(e.clientX, e.clientY, view);
    zoomAt(0.6, p.x, p.y);
  };
  const pan = (dx: number, dy: number) => setView((v) => ({ ...v, x: v.x + dx * v.w, y: v.y + dy * v.h }));
  const reset = () => {
    setView(HOME);
  };
  const focusOn = (x: number, y: number) =>
    setView((v) => {
      const w = Math.min(v.w, W / 2);
      const h = (w / W) * H;
      return { x: x - w / 2, y: y - h / 2, w, h };
    });

  return {
    view,
    zoomAt,
    pan,
    reset,
    focusOn,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick },
  };
}

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
  const svgRef = useRef<SVGSVGElement>(null);
  const { view, zoomAt, pan, reset, focusOn, handlers } = useZoomPan(svgRef);

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

  const open = async (id: string, center = false) => {
    playClick();
    if (center) {
      const p = positions.get(id);
      if (p) focusOn(p.x, p.y);
    }
    setSelected(await topicsApi.get(id));
  };
  const scale = view.w / W; // keeps labels and strokes a constant size on screen

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
            <div className="map-controls">
              <button className="icon-btn" onClick={() => zoomAt(0.75)} aria-label="Zoom in" title="Zoom in">
                +
              </button>
              <button className="icon-btn" onClick={() => zoomAt(1.33)} aria-label="Zoom out" title="Zoom out">
                -
              </button>
              <button className="icon-btn mono" onClick={reset} aria-label="Reset view" title="Reset view">
                1:1
              </button>
            </div>
            <p className="map-hint mono muted">Scroll to zoom · drag to pan · double click to dive in</p>
            <svg
              ref={svgRef}
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              role="img"
              aria-label="Topic constellation. Plus and minus zoom, arrow keys pan, 0 resets."
              tabIndex={0}
              className="map-svg"
              {...handlers}
              onKeyDown={(e) => {
                const step = 0.12;
                if (e.key === "+" || e.key === "=") zoomAt(0.8);
                else if (e.key === "-") zoomAt(1.25);
                else if (e.key === "0") reset();
                else if (e.key === "ArrowLeft") pan(-step, 0);
                else if (e.key === "ArrowRight") pan(step, 0);
                else if (e.key === "ArrowUp") pan(0, -step);
                else if (e.key === "ArrowDown") pan(0, step);
                else return;
                e.preventDefault();
              }}
            >
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
                    strokeWidth={(lit ? 1.6 : 1) * scale}
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
                    onDoubleClick={() => open(n.id, true)}
                    tabIndex={0}
                    role="button"
                    aria-label={`${n.name}, ${n.post_count} posts`}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && open(n.id)}
                  >
                    <circle cx={p.x} cy={p.y} r={p.r * 1.9} fill="url(#star)" opacity={active ? 0.9 : 0.45} />
                    <circle cx={p.x} cy={p.y} r={Math.max(3, p.r * 0.45)} fill="#ffffff" />
                    <text x={p.x} y={p.y + p.r + 16 * scale} textAnchor="middle" className="map-label" style={{ fontSize: 12 * scale, strokeWidth: 4 * scale }}>
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
                      <button className="link-btn" onClick={() => open(n.id, true)}>
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

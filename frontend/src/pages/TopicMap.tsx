import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { artifactsApi, notebooksApi, topicsApi } from "../api/endpoints";
import { SourcesNav } from "./Sources";
import type { Job, TopicDetail, TopicMap as TopicMapData, TopicNode } from "../api/types";
import { Reader } from "../components/Reader";
import { EmptyState, errorMessage, formatDate, JobProgress, Loading, PageHeader, Tabs } from "../components/ui";
import { useJob } from "../hooks/useJob";
import { playClick } from "../lib/sound";

// Virtual canvas. The layout runs in open space and is then fitted into this box with a margin.
const W = 1200;
const H = 780;
const PAD = 90;

type P = { id: string; x: number; y: number; vx: number; vy: number; r: number; galaxy: number };
type View = { x: number; y: number; w: number; h: number };
type ColorMode = "recency" | "momentum";

const HOME: View = { x: 0, y: 0, w: W, h: H };
const PINS_KEY = "notestack.topicmap.pins";

type Pins = Record<string, { x: number; y: number }>;

function readPins(ids: Set<string>): Pins {
  try {
    const all = JSON.parse(localStorage.getItem(PINS_KEY) || "{}") as Pins;
    return Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id)));
  } catch {
    return {};
  }
}

function writePins(pins: Pins) {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    // Storage blocked: positions just last for this visit.
  }
}
const MIN_W = W / 8;
const MAX_W = W * 1.6;

// Deterministic pseudo random, so the map looks the same on every visit.
function seeded(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Force layout with generous spacing: strong repulsion (room for labels), long constellation lines,
 * a pull toward each galaxy's centre so related topics cluster, then fitted to the canvas. */
function layout(data: TopicMapData): Map<string, P> {
  const maxCount = Math.max(1, ...data.nodes.map((n) => n.post_count));
  const nodes: P[] = data.nodes.map((n, i) => {
    const a = i * 2.39996;
    const rad = 80 + Math.sqrt(i) * 70;
    return {
      id: n.id,
      x: Math.cos(a) * rad,
      y: Math.sin(a) * rad,
      vx: 0,
      vy: 0,
      r: 5 + 20 * Math.sqrt(n.post_count / maxCount),
      galaxy: n.galaxy,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const maxW = Math.max(1, ...data.edges.map((e) => e.weight));
  const STEPS = 420;
  for (let step = 0; step < STEPS; step++) {
    const cool = 1 - step / STEPS;
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
        const minD = a.r + b.r + 90; // room for two labels side by side
        const k = a.galaxy === b.galaxy ? 7000 : 11000; // other galaxies push harder, leaving voids between them
        const f = (k / d2) * (d2 < minD * minD ? 3 : 1);
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
      const target = 190 - 70 * (e.weight / maxW);
      const f = (d - target) * 0.012 * (0.4 + e.weight / maxW);
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
    // Galaxy cohesion.
    const centers = new Map<number, { x: number; y: number; n: number }>();
    for (const n of nodes) {
      const c = centers.get(n.galaxy) ?? { x: 0, y: 0, n: 0 };
      c.x += n.x;
      c.y += n.y;
      c.n += 1;
      centers.set(n.galaxy, c);
    }
    for (const n of nodes) {
      const c = centers.get(n.galaxy)!;
      if (c.n > 1) {
        n.vx += (c.x / c.n - n.x) * 0.006;
        n.vy += (c.y / c.n - n.y) * 0.006;
      }
      n.vx += -n.x * 0.0012; // gentle gravity toward the origin
      n.vy += -n.y * 0.0012;
      n.x += Math.max(-16, Math.min(16, n.vx)) * cool;
      n.y += Math.max(-16, Math.min(16, n.vy)) * cool;
      n.vx *= 0.6;
      n.vy *= 0.6;
    }
  }
  // Fit into the canvas with a margin, keeping proportions; never enlarge a small map past 1.4x.
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const s = Math.min((W - PAD * 2) / Math.max(1, maxX - minX), (H - PAD * 2) / Math.max(1, maxY - minY), 1.4);
  const ox = (W - (maxX - minX) * s) / 2 - minX * s;
  const oy = (H - (maxY - minY) * s) / 2 - minY * s;
  for (const n of nodes) {
    n.x = n.x * s + ox;
    n.y = n.y * s + oy;
  }
  return byId;
}

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
    if ((e.target as Element).closest(".map-node, .nebula")) return;
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
  const reset = () => setView(HOME);
  const focusOn = (x: number, y: number, width = W / 2) =>
    setView(() => {
      const w = Math.max(MIN_W, Math.min(W, width));
      const h = (w / W) * H;
      return { x: x - w / 2, y: y - h / 2, w, h };
    });

  return {
    view,
    toSvg,
    zoomAt,
    pan,
    reset,
    focusOn,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick },
  };
}

// Small pieces

function Sparkline({ values, height = 36, highlightFrom }: { values: number[]; height?: number; highlightFrom?: number }) {
  const max = Math.max(1, ...values);
  const bw = 100 / values.length;
  return (
    <svg className="sparkline" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {values.map((v, i) => {
        const h = v ? Math.max(2, (v / max) * (height - 2)) : 1;
        return (
          <rect
            key={i}
            x={i * bw + bw * 0.15}
            y={height - h}
            width={bw * 0.7}
            height={h}
            rx={0.8}
            className={highlightFrom !== undefined && i >= highlightFrom ? "recent" : ""}
          />
        );
      })}
    </svg>
  );
}

const STATUS_LABEL: Record<TopicNode["status"], string> = {
  rising: "Rising",
  steady: "Steady orbit",
  dormant: "Dormant",
};

function momentumText(m: number) {
  if (!Number.isFinite(m) || m === 0) return "no recent posts";
  return m >= 1 ? `${m.toFixed(1)}x its usual share lately` : `${Math.round(m * 100)}% of its usual share lately`;
}

/** Deep field: faint background stars plus survey rings, drawn once. */
function DeepField() {
  const stars = useMemo(
    () =>
      Array.from({ length: 260 }, (_, i) => ({
        x: seeded(i + 1) * W,
        y: seeded(i + 1000) * H,
        r: 0.3 + seeded(i + 2000) * 1.1,
        o: 0.15 + seeded(i + 3000) * 0.5,
      })),
    [],
  );
  return (
    <g className="deep-field" aria-hidden="true">
      {[140, 260, 390, 520].map((r) => (
        <circle key={r} cx={W / 2} cy={H / 2} r={r} className="survey-ring" />
      ))}
      <line x1={W / 2} y1={0} x2={W / 2} y2={H} className="survey-axis" />
      <line x1={0} y1={H / 2} x2={W} y2={H / 2} className="survey-axis" />
      {stars.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#ffffff" opacity={s.o} />
      ))}
    </g>
  );
}

export default function TopicMap() {
  const [data, setData] = useState<TopicMapData | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [selected, setSelected] = useState<TopicDetail | null>(null);
  const [briefing, setBriefing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [mode, setMode] = useState<ColorMode>("recency");
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const svgRef = useRef<SVGSVGElement>(null);
  const { view, toSvg, zoomAt, pan, reset, focusOn, handlers } = useZoomPan(svgRef);
  const [pins, setPins] = useState<Pins>({});
  const [dragging, setDragging] = useState(false);
  const justDragged = useRef(false);

  const load = () => topicsApi.map().then(setData, () => setError("Could not load the topic map."));
  useEffect(() => {
    load();
  }, []);
  const live = useJob(job, (j) => {
    if (j.status === "done") load();
  });

  const positions = useMemo(() => (data?.nodes.length ? layout(data) : new Map<string, P>()), [data]);
  const placed = useMemo(() => {
    const m = new Map<string, P>();
    positions.forEach((p, id) => m.set(id, pins[id] ? { ...p, ...pins[id] } : p));
    return m;
  }, [positions, pins]);
  useEffect(() => {
    if (data) setPins(readPins(new Set(data.nodes.map((n) => n.id))));
  }, [data]);
  useEffect(() => {
    if (!dragging && data) writePins(pins);
  }, [pins, dragging, data]);
  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
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
  // Nebula for each galaxy with more than one star: centred on its members, sized to cover them.
  const nebulae = useMemo(() => {
    if (!data) return [];
    return data.galaxies
      .filter((g) => g.size > 1)
      .map((g) => {
        const pts = g.topic_ids.map((id) => placed.get(id)).filter(Boolean) as P[];
        const cx = pts.reduce((s, p) => s + p.x, 0) / Math.max(pts.length, 1);
        const cy = pts.reduce((s, p) => s + p.y, 0) / Math.max(pts.length, 1);
        const rx = Math.max(90, ...pts.map((p) => Math.abs(p.x - cx) + p.r)) + 50;
        const ry = Math.max(80, ...pts.map((p) => Math.abs(p.y - cy) + p.r)) + 45;
        return { ...g, cx, cy, rx, ry };
      });
  }, [data, placed]);

  const brightest = useMemo(
    () => new Set((data?.nodes ?? []).slice().sort((a, b) => b.post_count - a.post_count).slice(0, 3).map((n) => n.id)),
    [data],
  );
  const maxEdge = Math.max(1, ...(data?.edges ?? []).map((e) => e.weight));
  const recentBucket = useMemo(() => {
    const a = data?.archive;
    if (!a?.start || !a.end || !a.recent_from) return undefined;
    const span = +new Date(a.end) - +new Date(a.start) || 1;
    return Math.floor(((+new Date(a.recent_from) - +new Date(a.start)) / span) * 12);
  }, [data]);

  const focus = hover ?? selected?.id ?? null;
  const running = live && (live.status === "queued" || live.status === "running");
  const scale = view.w / W; // keeps labels and strokes a constant size on screen
  const zoomedIn = scale < 0.75;
  const hovered = hover ? byId.get(hover) : null;

  const rebuild = async (full: boolean) => {
    setError(null);
    try {
      if (full) setPins({});
      setJob(await topicsApi.rebuild(full));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const open = async (id: string, center = false) => {
    playClick();
    if (center) {
      const p = placed.get(id);
      if (p) focusOn(p.x, p.y);
    }
    setSelected(await topicsApi.get(id));
  };

  const startDrag = (e: ReactPointerEvent, ids: string[]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    justDragged.current = false;
    const v = view;
    const origin = toSvg(e.clientX, e.clientY, v);
    const start = Object.fromEntries(ids.map((id) => [id, placed.get(id)!]).filter(([, p]) => p)) as Record<string, P>;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const p = toSvg(ev.clientX, ev.clientY, v);
      const dx = p.x - origin.x;
      const dy = p.y - origin.y;
      if (!moved) {
        if (Math.hypot(dx, dy) < 4 * (v.w / W)) return;
        moved = true;
        setDragging(true);
      }
      setPins((prev) => {
        const next = { ...prev };
        for (const [id, s] of Object.entries(start)) next[id] = { x: s.x + dx, y: s.y + dy };
        return next;
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (moved) {
        justDragged.current = true;
        setDragging(false);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  /** A click that ends a drag is not a click. */
  const wasDrag = () => {
    const d = justDragged.current;
    justDragged.current = false;
    return d;
  };
  const resetPins = () => {
    playClick();
    setPins({});
  };
  const hasPins = Object.keys(pins).length > 0;

  const flyToGalaxy = (gid: number) => {
    const n = nebulae.find((g) => g.id === gid);
    if (n) focusOn(n.cx, n.cy, Math.max(n.rx * 2.6, (n.ry * 2.6 * W) / H));
  };

  const starColor = (n: TopicNode) => {
    if (mode === "momentum") return n.status === "rising" ? "#ffffff" : n.status === "dormant" ? "rgba(255,255,255,0.45)" : "#217cff";
    // recency: fresh topics burn white, old ones cool toward dim blue
    return n.recency > 0.75 ? "#ffffff" : n.recency > 0.4 ? "#9cc4ff" : "#217cff";
  };
  const starGlow = (n: TopicNode) =>
    mode === "momentum" ? (n.status === "rising" ? 1 : n.status === "dormant" ? 0.25 : 0.55) : 0.25 + 0.75 * n.recency;

  const galaxyCount = data ? data.galaxies.filter((g) => g.size > 1).length : 0;

  return (
    <div className="page-wrap">
      <SourcesNav />
      <PageHeader eyebrow="Topic map" title="The constellations in your archive">
        <Tabs<ColorMode>
          tabs={[
            { id: "recency", label: "Recency" },
            { id: "momentum", label: "Momentum" },
          ]}
          value={mode}
          onChange={setMode}
        />
        {data && data.nodes.length > 0 && (
          <button className={`btn btn-small${briefing ? " btn-primary" : ""}`} onClick={() => setBriefing(!briefing)} aria-pressed={briefing}>
            Briefing
          </button>
        )}
        {data?.has_untagged_posts && (
          <button className="btn btn-small" disabled={Boolean(running)} onClick={() => rebuild(false)}>
            Map new posts
          </button>
        )}
        <div className="card-menu map-menu">
          <button type="button" className="icon-btn" aria-label="Map options" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            ⋯
          </button>
          {menu && (
            <div className="card-menu-list" onMouseLeave={() => setMenu(false)}>
              <button
                type="button"
                disabled={Boolean(running)}
                onClick={() => {
                  setMenu(false);
                  rebuild(true);
                }}
              >
                Rebuild the whole map
              </button>
            </div>
          )}
        </div>
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
        <div className={`map-layout${selected || briefing ? "" : " map-full"}`}>
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
              {hasPins && (
                <button className="icon-btn mono" onClick={resetPins} aria-label="Reset star positions" title="Reset star positions">
                  ↺
                </button>
              )}
            </div>

            <div className="map-hud mono" aria-live="polite">
              {hovered ? (
                <>
                  <span className="hud-title">{hovered.name}</span>
                  <span>
                    {hovered.post_count} posts · last {formatDate(hovered.last_at)} · {STATUS_LABEL[hovered.status]}
                  </span>
                  <Sparkline values={hovered.timeline} height={18} highlightFrom={recentBucket} />
                </>
              ) : (
                <span className="muted">
                  {data.nodes.length} stars · {galaxyCount} galaxies · scroll to zoom, drag space to pan, drag stars or galaxies to move them
                </span>
              )}
            </div>

            <details className="map-legend mono" aria-label="Legend">
              <summary>Legend</summary>
              <span>
                <i className="lg-size" /> size = posts
              </span>
              {mode === "recency" ? (
                <span>
                  <i className="lg-bright" /> brighter = written about recently
                </span>
              ) : (
                <>
                  <span>
                    <i className="lg-tail" /> rising
                  </span>
                  <span>
                    <i className="lg-dormant" /> dormant
                  </span>
                </>
              )}
              <span>
                <i className="lg-line" /> lines = shared posts
              </span>
            </details>

            <svg
              ref={svgRef}
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              role="img"
              aria-label="Topic constellation. Plus and minus zoom, arrow keys pan, 0 resets."
              tabIndex={0}
              className={`map-svg${dragging ? " dragging" : ""}`}
              style={{ aspectRatio: `${W} / ${H}` }}
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
                <radialGradient id="star-glow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
                  <stop offset="30%" stopColor="#217cff" stopOpacity="0.55" />
                  <stop offset="100%" stopColor="#217cff" stopOpacity="0" />
                </radialGradient>
                <radialGradient id="nebula" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#217cff" stopOpacity="0.16" />
                  <stop offset="60%" stopColor="#217cff" stopOpacity="0.06" />
                  <stop offset="100%" stopColor="#217cff" stopOpacity="0" />
                </radialGradient>
                <radialGradient id="galaxy-core" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity="0.7" />
                  <stop offset="12%" stopColor="#ffffff" stopOpacity="0.32" />
                  <stop offset="40%" stopColor="#ffffff" stopOpacity="0.08" />
                  <stop offset="70%" stopColor="#217cff" stopOpacity="0.05" />
                  <stop offset="100%" stopColor="#217cff" stopOpacity="0" />
                </radialGradient>
                <linearGradient id="comet" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
                  <stop offset="100%" stopColor="#217cff" stopOpacity="0" />
                </linearGradient>
              </defs>

              <DeepField />

              {nebulae.map((g) => (
                <g
                  key={g.id}
                  className="nebula"
                  onPointerDown={(e) => startDrag(e, g.topic_ids)}
                  onClick={() => !wasDrag() && flyToGalaxy(g.id)}
                >
                  <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} fill="url(#nebula)" />
                  <circle cx={g.cx} cy={g.cy} r={Math.min(g.rx, g.ry) * 0.75} fill="url(#galaxy-core)" className="galaxy-core" />
                  <circle cx={g.cx} cy={g.cy} r={2.4 * scale} fill="#ffffff" className="galaxy-heart" />
                  <text
                    x={g.cx}
                    y={g.cy - g.ry + 18 * scale}
                    textAnchor="middle"
                    className="galaxy-label"
                    style={{ fontSize: 11 * scale, letterSpacing: 3 * scale }}
                  >
                    {g.name.toUpperCase()} GALAXY
                  </text>
                </g>
              ))}

              {data.edges.map((e) => {
                const a = placed.get(e.source);
                const b = placed.get(e.target);
                if (!a || !b) return null;
                const lit = focus && (e.source === focus || e.target === focus);
                const strength = e.weight / maxEdge;
                return (
                  <line
                    key={`${e.source}-${e.target}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className="constellation"
                    stroke={lit ? "#217cff" : "#ffffff"}
                    strokeOpacity={lit ? 0.95 : focus ? 0.04 : 0.08 + strength * 0.3}
                    strokeWidth={(lit ? 1.4 + strength * 2 : 0.6 + strength * 1.8) * scale}
                    strokeDasharray={strength < 0.25 && !lit ? `${3 * scale} ${4 * scale}` : undefined}
                  />
                );
              })}

              {data.nodes.map((n) => {
                const p = placed.get(n.id)!;
                const dim = focus && focus !== n.id && !neighbors.get(focus)?.has(n.id);
                const active = selected?.id === n.id;
                const color = starColor(n);
                const glow = starGlow(n);
                const showLabel =
                  zoomedIn || brightest.has(n.id) || n.post_count >= 3 || focus === n.id || active || Boolean(focus && neighbors.get(focus)?.has(n.id));
                const tail = mode === "momentum" && n.status === "rising" ? Math.min(90, 30 + n.momentum * 18) : 0;
                return (
                  <g
                    key={n.id}
                    className="map-node"
                    opacity={dim ? 0.2 : 1}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(null)}
                    onPointerDown={(e) => startDrag(e, [n.id])}
                    onClick={() => !wasDrag() && open(n.id)}
                    onDoubleClick={() => open(n.id, true)}
                    tabIndex={0}
                    role="button"
                    aria-label={`${n.name}, ${n.post_count} posts, ${STATUS_LABEL[n.status]}`}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && open(n.id)}
                  >
                    {tail > 0 && (
                      <path
                        d={`M ${p.x} ${p.y - p.r * 0.35} L ${p.x + tail} ${p.y - tail * 0.45} L ${p.x + p.r * 0.35} ${p.y + p.r * 0.1} Z`}
                        fill="url(#comet)"
                        opacity={0.8}
                      />
                    )}
                    <circle cx={p.x} cy={p.y} r={p.r * 2.1} fill="url(#star-glow)" opacity={active ? 1 : glow} />
                    {brightest.has(n.id) && (
                      <g className="spikes" stroke={color} strokeOpacity={0.55} strokeWidth={1 * scale}>
                        <line x1={p.x - p.r * 2.4} y1={p.y} x2={p.x + p.r * 2.4} y2={p.y} />
                        <line x1={p.x} y1={p.y - p.r * 2.4} x2={p.x} y2={p.y + p.r * 2.4} />
                      </g>
                    )}
                    {mode === "momentum" && n.status === "dormant" && (
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={p.r * 0.9 + 4}
                        fill="none"
                        stroke="#ffffff"
                        strokeOpacity={0.5}
                        strokeWidth={1 * scale}
                        strokeDasharray={`${2 * scale} ${3 * scale}`}
                      />
                    )}
                    <circle cx={p.x} cy={p.y} r={Math.max(2.5, p.r * 0.42)} fill={color} />
                    {active && <circle cx={p.x} cy={p.y} r={p.r + 12} className="orbit-ring" strokeWidth={1.2 * scale} />}
                    {showLabel && (
                      <text
                        x={p.x}
                        y={p.y + p.r + 18 * scale}
                        textAnchor="middle"
                        className="map-label"
                        style={{ fontSize: 12.5 * scale, strokeWidth: 4 * scale }}
                      >
                        {n.name}
                        {(zoomedIn || active) && (
                          <tspan className="map-count" dx={6 * scale}>
                            {n.post_count}
                          </tspan>
                        )}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>

          {(selected || briefing) && (
          <aside className="card map-side">
            {!selected && (
              <>
                <p className="eyebrow">Mission briefing</p>
                <p className="muted small">
                  {data.archive.posts} posts from {formatDate(data.archive.start)} to {formatDate(data.archive.end)}. Recent means since{" "}
                  {formatDate(data.archive.recent_from)}.
                </p>

                <section className="brief">
                  <h3>Galaxies</h3>
                  <ul className="brief-list">
                    {data.galaxies
                      .filter((g) => g.size > 1)
                      .slice(0, 6)
                      .map((g) => (
                        <li key={g.id}>
                          <button className="link-btn" onClick={() => flyToGalaxy(g.id)}>
                            {g.name}
                          </button>
                          <span className="mono muted">
                            {g.size} topics · {g.post_count} posts
                          </span>
                        </li>
                      ))}
                    {galaxyCount === 0 && <li className="muted small">No clusters yet. Map more posts.</li>}
                  </ul>
                </section>

                <section className="brief">
                  <h3>Rising</h3>
                  <ul className="brief-list">
                    {data.insights.rising.map((r) => (
                      <li key={r.id}>
                        <button className="link-btn" onClick={() => open(r.id, true)}>
                          {r.name}
                        </button>
                        <span className="mono brief-up">{r.momentum.toFixed(1)}x</span>
                      </li>
                    ))}
                    {data.insights.rising.length === 0 && <li className="muted small">Nothing is picking up speed right now.</li>}
                  </ul>
                </section>

                <section className="brief">
                  <h3>Dormant</h3>
                  <ul className="brief-list">
                    {data.insights.dormant.map((d) => (
                      <li key={d.id}>
                        <button className="link-btn" onClick={() => open(d.id, true)}>
                          {d.name}
                        </button>
                        <span className="mono muted">since {formatDate(d.last_at)}</span>
                      </li>
                    ))}
                    {data.insights.dormant.length === 0 && <li className="muted small">Every topic has been visited lately.</li>}
                  </ul>
                  {data.insights.dormant.length > 0 && (
                    <Link to="/app/launchpad#ideas" className="small-link mono">
                      Resurface old posts
                    </Link>
                  )}
                </section>

                <section className="brief">
                  <h3>Strongest pairings</h3>
                  <ul className="brief-list">
                    {data.insights.pairs.map((p) => (
                      <li key={`${p.a_id}-${p.b_id}`}>
                        <span>
                          <button className="link-btn" onClick={() => open(p.a_id, true)}>
                            {p.a}
                          </button>
                          <span className="muted"> + </span>
                          <button className="link-btn" onClick={() => open(p.b_id, true)}>
                            {p.b}
                          </button>
                        </span>
                        <span className="mono muted">{p.posts} posts</span>
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            )}

            {selected && (
              <>
                <button className="link-btn mono muted small" onClick={() => setSelected(null)}>
                  {briefing ? "Back to briefing" : "Close"}
                </button>
                <div className="row between">
                  <h2>{selected.name}</h2>
                  <span className={`pill mono status-${selected.status}`}>{STATUS_LABEL[selected.status]}</span>
                </div>
                {selected.summary && <p className="muted">{selected.summary}</p>}

                <dl className="star-stats">
                  <div>
                    <dt>Posts</dt>
                    <dd>{selected.post_count}</dd>
                  </div>
                  <div>
                    <dt>Recent</dt>
                    <dd>{selected.recent_posts}</dd>
                  </div>
                  <div>
                    <dt>First</dt>
                    <dd>{formatDate(selected.first_at)}</dd>
                  </div>
                  <div>
                    <dt>Last</dt>
                    <dd>{formatDate(selected.last_at)}</dd>
                  </div>
                </dl>
                <p className="mono muted small">Momentum: {momentumText(selected.momentum)}</p>

                <div className="timeline">
                  <Sparkline values={selected.timeline} height={44} highlightFrom={recentBucket} />
                  <div className="row between mono muted small">
                    <span>{formatDate(selected.timeline_start)}</span>
                    <span>{formatDate(selected.timeline_end)}</span>
                  </div>
                </div>

                {selected.related.length > 0 && (
                  <div className="stack">
                    <span className="mono muted small">Travels with</span>
                    <div className="chips">
                      {selected.related.map((r) => (
                        <button key={r.id} className="chip chip-btn" onClick={() => open(r.id, true)} title={`${r.shared_posts} shared posts`}>
                          {r.name} <span className="mono">{r.shared_posts}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="topic-actions">
                  <button
                    className="btn btn-small btn-primary"
                    disabled={acting !== null}
                    onClick={async () => {
                      setActing("audio");
                      try {
                        const nb = await notebooksApi.fromTopic(selected.id);
                        await artifactsApi.generate({ type: "audio_overview", notebook_id: nb.id, format: "deep_dive", minutes: 6 });
                        navigate(`/app/notebooks/${nb.id}`);
                      } finally {
                        setActing(null);
                      }
                    }}
                  >
                    {acting === "audio" ? "Starting..." : "Audio about this"}
                  </button>
                  {selected.posts[0] && (
                    <button className="btn btn-small" disabled={acting !== null} onClick={() => navigate(`/app/launch-kit?post=${selected.posts[0].id}`)}>
                      Launch Kit for the latest post
                    </button>
                  )}
                  <button
                    className="btn btn-small"
                    disabled={acting !== null}
                    onClick={async () => {
                      const nb = await notebooksApi.fromTopic(selected.id);
                      navigate(`/app/notebooks/${nb.id}`);
                    }}
                  >
                    Open as notebook
                  </button>
                </div>
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
          )}
        </div>
      )}
      {reading && <Reader documentId={reading} onClose={() => setReading(null)} />}
    </div>
  );
}

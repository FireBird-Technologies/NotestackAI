import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { artifactsApi } from "../api/endpoints";
import type { Artifact, MindNode } from "../api/types";
import { useJob } from "../hooks/useJob";
import { ConfirmButton, formatDate, JobProgress, Modal, StatusPill } from "./ui";
import { Reader } from "./Reader";

/* ---------- Layout: a galaxy. The centre idea, branches orbiting it, sub-themes orbiting each branch, points
   orbiting each sub-theme. Every orbit is smaller than the one above, so zooming in always reveals a new ring. ---------- */

type Placed = { node: MindNode; level: number; x: number; y: number; parent: Placed | null; angle: number; branch: number };

const RADIUS = [46, 26, 13, 4.6]; // node radius per level, in world units
const TOPIC_ORBIT = 150;
const DETAIL_ORBIT = 62;
const LABEL_PX = [24, 17, 13, 12]; // label size on screen at scale 1
const PANEL_W = 340;
const MAX_SCALE = 14;

const mindConstellationTitle = (title: string) =>
  title.replace(/^(?:Mind map|Idea Galaxy|Idea Constellation):/, "Mind Constellation:");

/* Shapes. Maps open as a Figure and the explorer lets you change it. Orbit is a ring with spokes; the others are
   freer figures joined like constellations. The seed still varies each figure's exact outline from map to map. */
export type Shape = "orbit" | "spiral" | "constellation" | "cluster";
export const SHAPES: { id: Shape; label: string }[] = [
  { id: "orbit", label: "Orbit" },
  { id: "spiral", label: "Spiral" },
  { id: "constellation", label: "Figure" },
  { id: "cluster", label: "Cluster" },
];
type Edge = { a: Placed; b: Placed; to: Placed; faint?: boolean };
const MIN_GAP = 470; // branches keep this far apart so their sub-themes and points never collide
const MIN_ROOT = 400;

function hashSeed(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 997;
}
// Every map opens as a constellation figure; the switcher changes it, and the choice is remembered per map.
export const shapeFor = (_id: string): Shape => "constellation";

function branchPoints(shape: Shape, n: number, seed: number): { x: number; y: number }[] {
  const r = (k: number) => seeded(seed * 7.13 + k);
  const orbit = orbitOf(n);
  const start = shape === "orbit" ? -Math.PI / 2 : r(1) * Math.PI * 2;
  let pts: { x: number; y: number }[] = [];
  if (shape === "orbit") {
    pts = Array.from({ length: n }, (_, i) => {
      const a = start + (2 * Math.PI * i) / Math.max(n, 1);
      return { x: Math.cos(a) * orbit, y: Math.sin(a) * orbit };
    });
  } else if (shape === "spiral") {
    const dir = r(2) > 0.5 ? 1 : -1;
    pts = Array.from({ length: n }, (_, i) => {
      const a = start + dir * i * 0.95;
      const rad = 300 + (n > 1 ? (i * (orbit + 120 - 300)) / (n - 1) : 0);
      return { x: Math.cos(a) * rad, y: Math.sin(a) * rad };
    });
  } else if (shape === "constellation") {
    if (seed % 2 === 0) {
      // a zigzag, like Cassiopeia
      pts = Array.from({ length: n }, (_, i) => ({ x: (i - (n - 1) / 2) * 380, y: (i % 2 ? 1 : -1) * (150 + r(10 + i) * 150) }));
    } else {
      // a sweeping arc with a ragged edge, like the Plough's handle
      pts = Array.from({ length: n }, (_, i) => {
        const t = n > 1 ? -1.15 + (2.3 * i) / (n - 1) : 0;
        const rad = orbit * (0.85 + r(10 + i) * 0.45);
        return { x: Math.sin(t) * rad, y: -Math.cos(t) * rad + orbit * 0.7 };
      });
    }
    const cx = pts.reduce((m, q) => m + q.x, 0) / Math.max(n, 1);
    const cy = pts.reduce((m, q) => m + q.y, 0) / Math.max(n, 1);
    pts = pts.map((q) => {
      const x = q.x - cx;
      const y = q.y - cy;
      return { x: x * Math.cos(start) - y * Math.sin(start), y: x * Math.sin(start) + y * Math.cos(start) };
    });
  } else {
    for (let i = 0; i < n; i++) {
      let best = { x: 0, y: 0 };
      for (let t = 0; t < 300; t++) {
        const a = r(100 + i * 300 + t) * Math.PI * 2;
        const d = Math.sqrt(r(101 + i * 300 + t)) * orbit * 1.25;
        const q = { x: Math.cos(a) * d, y: Math.sin(a) * d };
        best = q;
        if (Math.hypot(q.x, q.y) >= MIN_ROOT && pts.every((o) => Math.hypot(o.x - q.x, o.y - q.y) >= MIN_GAP)) break;
      }
      pts.push(best);
    }
  }
  // Push apart anything that landed too close.
  for (let it = 0; it < 200; it++) {
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[j].x - pts[i].x;
        const dy = pts[j].y - pts[i].y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < MIN_GAP) {
          const push = (MIN_GAP - d) / 2;
          pts[i].x -= (dx / d) * push;
          pts[i].y -= (dy / d) * push;
          pts[j].x += (dx / d) * push;
          pts[j].y += (dy / d) * push;
        }
      }
    }
    // The centre keeps its own clear space (checked last, so nothing pushes a star back into it).
    for (const q of pts) {
      const d0 = Math.hypot(q.x, q.y) || 1;
      if (d0 < MIN_ROOT) {
        q.x = (q.x / d0) * MIN_ROOT;
        q.y = (q.y / d0) * MIN_ROOT;
      }
    }
  }
  return pts;
}

function place(root: MindNode, shape: Shape, seed: number): { nodes: Placed[]; edges: Edge[]; extent: number } {
  const jit = (k: number) => (shape === "orbit" ? 0 : seeded(seed * 3.7 + k) - 0.5);
  const nodes: Placed[] = [];
  const edges: Edge[] = [];
  const top: Placed = { node: root, level: 0, x: 0, y: 0, parent: null, angle: 0, branch: -1 };
  nodes.push(top);
  const pts = branchPoints(shape, root.children.length, seed);
  const bps: Placed[] = [];
  root.children.forEach((b, i) => {
    const a = Math.atan2(pts[i].y, pts[i].x);
    const bp: Placed = { node: b, level: 1, x: pts[i].x, y: pts[i].y, parent: top, angle: a, branch: i };
    nodes.push(bp);
    bps.push(bp);
    const topics: Placed[] = [];
    b.children.forEach((t, j) => {
      const ta = a + (j - (b.children.length - 1) / 2) * 0.95 + jit(i * 50 + j) * 0.35;
      const tr = TOPIC_ORBIT * (1 + jit(i * 50 + j + 7) * 0.4);
      const tp: Placed = { node: t, level: 2, x: bp.x + Math.cos(ta) * tr, y: bp.y + Math.sin(ta) * tr, parent: bp, angle: ta, branch: i };
      nodes.push(tp);
      topics.push(tp);
      const details: Placed[] = [];
      t.children.forEach((d, k) => {
        const da = ta + (k - (t.children.length - 1) / 2) * 0.9 + jit(i * 500 + j * 50 + k) * 0.3;
        const dp: Placed = { node: d, level: 3, x: tp.x + Math.cos(da) * DETAIL_ORBIT, y: tp.y + Math.sin(da) * DETAIL_ORBIT, parent: tp, angle: da, branch: i };
        nodes.push(dp);
        details.push(dp);
      });
      link(edges, tp, details, shape);
    });
    link(edges, bp, topics, shape);
  });
  // Branch connections: spokes for an orbit, otherwise lines that join the stars into a figure.
  const near = (p: Placed, from: Placed[]) => [...from].sort((u, v) => Math.hypot(u.x - p.x, u.y - p.y) - Math.hypot(v.x - p.x, v.y - p.y));
  if (shape === "orbit") bps.forEach((bp) => edges.push({ a: top, b: bp, to: bp }));
  else if (shape === "spiral") {
    if (bps[0]) edges.push({ a: top, b: bps[0], to: bps[0] });
    for (let i = 1; i < bps.length; i++) edges.push({ a: bps[i - 1], b: bps[i], to: bps[i] });
  } else if (shape === "constellation") {
    for (let i = 1; i < bps.length; i++) edges.push({ a: bps[i - 1], b: bps[i], to: bps[i] });
    near(top, bps).slice(0, 2).forEach((bp) => edges.push({ a: top, b: bp, to: bp }));
    if (seed % 3 === 0 && bps.length > 3) edges.push({ a: bps[bps.length - 1], b: bps[0], to: bps[0] });
  } else {
    // cluster: a minimum spanning tree over the centre and every branch (Prim)
    const inTree = [top];
    const rest = [...bps];
    while (rest.length) {
      let best: { from: Placed; to: Placed; d: number } | null = null;
      for (const q of rest) for (const f of inTree) {
        const d = Math.hypot(q.x - f.x, q.y - f.y);
        if (!best || d < best.d) best = { from: f, to: q, d };
      }
      edges.push({ a: best!.from, b: best!.to, to: best!.to });
      inTree.push(best!.to);
      rest.splice(rest.indexOf(best!.to), 1);
    }
  }
  // Every theme stays tied to the centre: the figure lines carry the eye, and these faint spokes keep it whole.
  if (shape !== "orbit") {
    const joined = new Set(edges.filter((e) => e.a === top || e.b === top).map((e) => (e.a === top ? e.b : e.a)));
    bps.filter((bp) => !joined.has(bp)).forEach((bp) => edges.push({ a: top, b: bp, to: bp, faint: true }));
  }
  const extent = Math.max(MIN_ROOT, ...bps.map((q) => Math.hypot(q.x, q.y)));
  return { nodes, edges, extent };
}

/** An orbit fans its children out from the parent; the freer shapes thread them in a line like a constellation. */
function link(edges: Edge[], parent: Placed, kids: Placed[], shape: Shape) {
  if (shape === "orbit") kids.forEach((k) => edges.push({ a: parent, b: k, to: k }));
  else
    kids.forEach((k, i) => edges.push({ a: i === 0 ? parent : kids[i - 1], b: k, to: k }));
}

function wrap(text: string, max: number, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > max) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/[\s.,;:]*$/, "") + "...";
    return kept;
  }
  return lines;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ramp = (z: number, a: number, b: number) => clamp((z - a) / (b - a), 0, 1);
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function seeded(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
// Three star layers that drift at different speeds as the camera moves, which is what gives the depth.
const LAYERS = [
  { n: 90, parallax: 0.012, r: [0.35, 0.8], op: 0.45 },
  { n: 50, parallax: 0.035, r: [0.6, 1.3], op: 0.7 },
  { n: 16, parallax: 0.085, r: [1.2, 2.2], op: 0.95 },
].map((l, li) => ({
  ...l,
  stars: Array.from({ length: l.n }, (_, i) => {
    const k = li * 1000 + i;
    return { x: seeded(k + 1), y: seeded(k + 501), r: l.r[0] + seeded(k + 901) * (l.r[1] - l.r[0]), d: seeded(k + 1301) * 6, blue: seeded(k + 77) > 0.7 };
  }),
}));

// Themes stay inside the app palette: different strengths of the one blue. The centre is pale starlight.
const ACCENTS = ["#217cff", "#4a96ff", "#2f6fe0", "#6fb0ff", "#1f5fd0", "#8cc0ff", "#3b86f0"];
const CORE = "#bcd6ff";
const accentOf = (p: Placed) => (p.branch < 0 ? CORE : ACCENTS[p.branch % ACCENTS.length]);
const orbitOf = (n: number) => Math.max(320, 82 * n);

type Cam = { x: number; y: number; s: number };
const camTransform = (c: Cam, size: { w: number; h: number }) => `translate(${size.w / 2 - c.x * c.s} ${size.h / 2 - c.y * c.s}) scale(${c.s})`;

/* ---------- The explorer ---------- */

export function MindMapExplorer({ artifact, onClose, warp = true, startAt = "root", embedded = false, onExpand }: {
  artifact: Artifact;
  onClose: () => void;
  warp?: boolean;
  startAt?: string;
  /** Shown inside the page (a report) in a frame instead of full screen; the wheel zooms only with Ctrl or Cmd held. */
  embedded?: boolean;
  /** Embedded: the button that opens the full-screen explorer. */
  onExpand?: () => void;
}) {
  const root = artifact.content.root as MindNode | undefined;
  const storeKey = `ns_mindmap_shape_${artifact.id}`;
  const [shape, setShape] = useState<Shape>(() => {
    try {
      const saved = localStorage.getItem(storeKey) as Shape | null;
      if (saved && SHAPES.some((x) => x.id === saved)) return saved;
    } catch {
      /* no storage: use the map's own shape */
    }
    return shapeFor(artifact.id);
  });
  const seed = useMemo(() => hashSeed(artifact.id), [artifact.id]);
  const layoutData = useMemo(() => (root ? place(root, shape, seed) : { nodes: [], edges: [], extent: MIN_ROOT }), [root, shape, seed]);
  const placed = layoutData.nodes;
  const edges = layoutData.edges;
  const byId = useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 700 });
  const [focusId, setFocusId] = useState<string>(startAt);
  // The camera lives in a ref and is written straight to the DOM every frame. React only re-renders when the zoom
  // crosses a small step (labels and which rings show depend on it), so flying and panning stay smooth.
  const camRef = useRef<Cam>({ x: 0, y: 0, s: 0.1 });
  const worldRef = useRef<SVGGElement>(null);
  const starRefs = useRef<(SVGGElement | null)[]>([]);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const bucket = useRef(0);
  const [, setStep] = useState(0);
  const applyCam = useCallback((c: Cam) => {
    camRef.current = c;
    worldRef.current?.setAttribute("transform", camTransform(c, sizeRef.current));
    // Each star field is one 3x3-screen tile; the drift wraps around it (the tile is drawn again beside itself),
    // so the sky never runs out however far or deep the camera goes.
    const { w, h } = sizeRef.current;
    const wrap = (v: number, period: number) => ((v % period) + period) % period;
    starRefs.current.forEach((g, i) =>
      g?.setAttribute("transform", `translate(${wrap(-c.x * c.s * LAYERS[i].parallax, w * 3)} ${wrap(-c.y * c.s * LAYERS[i].parallax, h * 3)})`),
    );
    const b = Math.round(Math.log(c.s) * 25);
    if (b !== bucket.current) {
      bucket.current = b;
      setStep(b);
    }
  }, []);
  const anim = useRef(0);
  const drag = useRef<{ px: number; py: number; cam: Cam; moved: boolean } | null>(null);
  const [reading, setReading] = useState<{ id: string; start: number; end: number } | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const wide = size.w >= 820;
  const panelW = panelOpen && wide ? PANEL_W : 0;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Where the camera should sit to frame a node and everything orbiting it. */
  const targetFor = useCallback(
    (id: string): Cam => {
      const p = byId.get(id) ?? placed[0];
      const members = id === "root" ? placed : placed.filter((q) => {
        for (let c: Placed | null = q; c; c = c.parent) if (c === p) return true;
        return false;
      });
      const pad = id === "root" ? 70 : p.level === 3 ? 56 : 46;
      const minX = Math.min(...members.map((m) => m.x - RADIUS[m.level]));
      const maxX = Math.max(...members.map((m) => m.x + RADIUS[m.level]));
      const minY = Math.min(...members.map((m) => m.y - RADIUS[m.level]));
      const maxY = Math.max(...members.map((m) => m.y + RADIUS[m.level]));
      const halfW = Math.max((maxX - minX) / 2 + pad, 60);
      const halfH = Math.max((maxY - minY) / 2 + pad, 60);
      const freeW = size.w - panelW;
      const s = clamp(Math.min(freeW / (2 * halfW), size.h / (2 * halfH)), 0.05, MAX_SCALE);
      return { x: (minX + maxX) / 2 + panelW / 2 / s, y: (minY + maxY) / 2, s };
    },
    [byId, placed, size.w, size.h, panelW],
  );
  const fitScale = useMemo(() => targetFor("root").s, [targetFor]);

  const flyTo = useCallback((to: Cam, ms = 950) => {
    cancelAnimationFrame(anim.current);
    const from = camRef.current;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = ease(clamp((now - t0) / ms, 0, 1));
      // Scale moves geometrically so the zoom feels even; the centre follows.
      const s = from.s * Math.pow(to.s / from.s, t);
      applyCam({ s, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
      if (t < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, [applyCam]);

  const focus = useCallback(
    (id: string, ms?: number) => {
      setFocusId(id);
      flyTo(targetFor(id), ms);
    },
    [flyTo, targetFor],
  );

  // Warp in: start far out and fly to the whole constellation.
  const entered = useRef(false);
  useEffect(() => {
    if (entered.current || !placed.length || size.w < 50) return;
    entered.current = true;
    const end = targetFor(startAt);
    if (!warp) {
      applyCam(end);
      return;
    }
    applyCam({ ...end, s: end.s * 0.25 });
    flyTo(end, 1400);
  }, [placed.length, size.w, targetFor, flyTo, applyCam, warp, startAt]);

  // Reframe when the window or panel changes.
  const firstFrame = useRef(true);
  useEffect(() => {
    if (firstFrame.current) {
      firstFrame.current = false;
      return;
    }
    if (entered.current) flyTo(targetFor(focusId), 350);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelW, size.w, size.h]);

  // A new shape reshuffles every star, so fly back out to see the whole figure.
  const shapeSeen = useRef(shape);
  useEffect(() => {
    if (shapeSeen.current === shape) return;
    shapeSeen.current = shape;
    setFocusId("root");
    flyTo(targetFor("root"), 900);
    try {
      localStorage.setItem(storeKey, shape);
    } catch {
      /* fine */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  const up = useCallback(() => {
    const p = byId.get(focusId);
    if (p?.parent) focus(p.parent.node.id);
  }, [byId, focus, focusId]);

  useEffect(() => {
    if (embedded) return; // in a page the keys belong to the page (scrolling), not the map
    const onKey = (e: KeyboardEvent) => {
      if (reading) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "Backspace" || e.key === "ArrowUp") {
        e.preventDefault();
        up();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, up, reading, embedded]);

  // Wheel zooms around the cursor (a native listener, so the page behind never scrolls).
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomBy = useCallback((factor: number, sx: number, sy: number) => {
    cancelAnimationFrame(anim.current);
    const c = camRef.current;
    const s = clamp(c.s * factor, fitScale * 0.5, MAX_SCALE);
    // keep the world point under (sx, sy) fixed
    const wx = c.x + (sx - size.w / 2) / c.s;
    const wy = c.y + (sy - size.h / 2) / c.s;
    applyCam({ s, x: wx - (sx - size.w / 2) / s, y: wy - (sy - size.h / 2) / s });
  }, [fitScale, size.w, size.h, applyCam]);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (embedded && !(e.ctrlKey || e.metaKey)) return; // let the page scroll past an embedded map
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(Math.exp(clamp(-e.deltaY * 0.0018, -0.35, 0.35)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy, embedded]);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    cancelAnimationFrame(anim.current);
    drag.current = { px: e.clientX, py: e.clientY, cam: camRef.current, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      d.moved = true;
      // Capture only once it is a real drag: capturing on press would send the click to the canvas, not the star.
      svgRef.current?.setPointerCapture(e.pointerId);
    }
    if (d.moved) applyCam({ s: d.cam.s, x: d.cam.x - dx / d.cam.s, y: d.cam.y - dy / d.cam.s });
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    window.setTimeout(() => (drag.current = null), 0); // lets the click handler see `moved`
  };

  if (!root || !placed.length) return null;

  const cam = camRef.current;
  const z = cam.s / fitScale;
  const levelOp = [1, 1, ramp(z, 1.25, 1.8), ramp(z, 3.6, 5)];
  const focused = byId.get(focusId) ?? placed[0];
  const lineage = new Set<string>();
  for (let c: Placed | null = focused; c; c = c.parent) lineage.add(c.node.id);
  const inFocus = (p: Placed) => {
    if (focusId === "root") return true;
    if (lineage.has(p.node.id)) return true;
    for (let c: Placed | null = p; c; c = c.parent) if (c === focused) return true;
    return false;
  };
  const labelWorld = (level: number) => (LABEL_PX[level] * Math.pow(cam.s, 0.3)) / cam.s;
  // Declutter: at any zoom, several labels can be visible at once and sit close together on screen. A bigger or more
  // central node (lower level first, then closer to the view centre) claims its space; one whose box would then
  // overlap an already-claimed box is hidden until zooming in spreads the nodes apart.
  const hiddenLabels = (() => {
    const centerX = size.w / 2 - cam.x * cam.s;
    const centerY = size.h / 2 - cam.y * cam.s;
    const toScreen = (p: Placed) => ({ x: centerX + p.x * cam.s, y: centerY + p.y * cam.s });
    const candidates = placed
      .filter((p) => levelOp[p.level] * (inFocus(p) ? 1 : 0.28) >= 0.3)
      .map((p) => {
        const s = toScreen(p);
        const fsPx = labelWorld(p.level) * cam.s * (p.level === 0 ? 0.82 : 1);
        const text = p.level === 0 ? p.node.label.toUpperCase() : p.node.label;
        const w = Math.min(text.length, p.level >= 2 ? 16 : 14) * fsPx * 0.58;
        const r = RADIUS[p.level] * cam.s;
        const top = s.y + r * 1.35;
        return { p, box: { x1: s.x - w / 2, x2: s.x + w / 2, y1: top, y2: top + fsPx * 1.3 } };
      })
      .sort((a, b) => {
        if (a.p.level !== b.p.level) return a.p.level - b.p.level; // bigger levels (branches) win over small ones
        const da = (a.box.x1 + a.box.x2) ** 2 + (a.box.y1 + a.box.y2) ** 2;
        const db = (b.box.x1 + b.box.x2) ** 2 + (b.box.y1 + b.box.y2) ** 2;
        return da - db; // within a level, whichever sits nearer the view centre wins
      });
    const kept: { x1: number; x2: number; y1: number; y2: number }[] = [];
    const hidden = new Set<string>();
    const overlaps = (a: typeof candidates[number]["box"], b: typeof candidates[number]["box"]) =>
      a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
    for (const { p, box } of candidates) {
      if (p.node.id === focusId || kept.every((k) => !overlaps(box, k))) kept.push(box);
      else hidden.add(p.node.id);
    }
    return hidden;
  })();
  const trail: Placed[] = [];
  for (let c: Placed | null = focused; c; c = c.parent) trail.unshift(c);

  const view = (
    <div className={`mm-overlay${embedded ? " mm-embedded" : ""}`} role={embedded ? "group" : "dialog"} aria-modal={embedded ? undefined : true}
         aria-label={mindConstellationTitle(artifact.title)}>
      <div className="mm-stage" ref={wrapRef}>
        <svg
          ref={svgRef}
          className="mm-svg"
          width={size.w}
          height={size.h}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(e) => {
            const r = svgRef.current!.getBoundingClientRect();
            zoomBy(1.8, e.clientX - r.left, e.clientY - r.top);
          }}
        >
          <defs>
            <radialGradient id="mm-core">
              <stop offset="0%" stopColor="#fff" />
              <stop offset="30%" stopColor="#dbe8ff" />
              <stop offset="65%" stopColor="#7aa7ff" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#217cff" stopOpacity="0" />
            </radialGradient>
            {[...ACCENTS, CORE].map((c, i) => (
              <radialGradient key={i} id={`mm-g${i}`}>
                <stop offset="0%" stopColor={c} stopOpacity="0.95" />
                <stop offset="30%" stopColor={c} stopOpacity="0.4" />
                <stop offset="100%" stopColor={c} stopOpacity="0" />
              </radialGradient>
            ))}
          </defs>
          {LAYERS.map((layer, li) => (
            <g key={li} ref={(el) => (starRefs.current[li] = el)} aria-hidden="true">
              <use href={`#mm-sky${li}`} x={-size.w * 3} y={0} />
              <use href={`#mm-sky${li}`} x={0} y={-size.h * 3} />
              <use href={`#mm-sky${li}`} x={-size.w * 3} y={-size.h * 3} />
              <g id={`mm-sky${li}`}>
              {layer.stars.map((st, i) => (
                <circle
                  key={i}
                  cx={(st.x * 3 - 1) * size.w}
                  cy={(st.y * 3 - 1) * size.h}
                  r={st.r}
                  className={i % 5 === 0 ? "mm-star mm-twinkle" : "mm-star"}
                  style={{ opacity: layer.op, fill: st.blue ? "#a9c8ff" : "#fff", animationDelay: `${st.d}s` }}
                />
              ))}
              </g>
            </g>
          ))}
          <g ref={worldRef} transform={camTransform(cam, size)}>
            {/* nebula: a soft cloud of each theme's colour behind its cluster */}
            <circle cx={0} cy={0} r={layoutData.extent * 1.7} fill="url(#mm-g7)" opacity={0.22} pointerEvents="none" />
            {placed
              .filter((p) => p.level === 1)
              .map((p) => (
                <circle key={`n${p.node.id}`} cx={p.x} cy={p.y} r={TOPIC_ORBIT * 2.3} fill={`url(#mm-g${p.branch % ACCENTS.length})`} opacity={inFocus(p) ? 0.3 : 0.1} pointerEvents="none" />
              ))}
            {/* orbits, with a small satellite drifting around the ones in view */}
            {placed
              .filter((p) => shape === "orbit" && p.node.children.length)
              .map((p) => {
                const r = p.level === 0 ? layoutData.extent : p.level === 1 ? TOPIC_ORBIT : DETAIL_ORBIT;
                const op = levelOp[p.level + 1] * (inFocus(p) ? 1 : 0.3);
                if (op < 0.03) return null;
                const c = accentOf(p.level === 0 ? p : p);
                return (
                  <g key={`o${p.node.id}`} style={{ opacity: op }} pointerEvents="none">
                    <circle cx={p.x} cy={p.y} r={r} className="mm-orbit" style={{ stroke: p.level === 0 ? "#8fbaff" : c }} vectorEffect="non-scaling-stroke" />
                    {p.level < 3 && (
                      <circle cx={p.x + r} cy={p.y} r={p.level === 0 ? 4.5 : p.level === 1 ? 2.6 : 1.4} fill="#fff" className="mm-satellite">
                        <animateTransform attributeName="transform" type="rotate" from={`0 ${p.x} ${p.y}`} to={`360 ${p.x} ${p.y}`} dur={`${p.level === 0 ? 160 : 70 + p.level * 20}s`} repeatCount="indefinite" />
                      </circle>
                    )}
                  </g>
                );
              })}
            {/* constellation lines; the path to what you are looking at flows */}
            {edges
              .filter((e) => levelOp[e.to.level] > 0.03)
              .map((e) => {
                const live = inFocus(e.to);
                const flowing = live && focusId !== "root"; // the whole map at rest is calm solid lines; a chosen path flows
                return (
                  <line
                    key={`l${e.a.node.id}-${e.b.node.id}`}
                    x1={e.a.x}
                    y1={e.a.y}
                    x2={e.b.x}
                    y2={e.b.y}
                    className={`mm-link${flowing ? " mm-flow" : ""}`}
                    style={{ opacity: levelOp[e.to.level] * (flowing ? 0.9 : live ? 0.6 : 0.16) * (e.faint ? 0.4 : 1), stroke: accentOf(e.to) }}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            {/* deepest first so the outer rings never hide the inner ones' labels */}
            {[...placed].reverse().map((p) => {
              const op = levelOp[p.level] * (inFocus(p) ? 1 : 0.28);
              if (op < 0.02) return null;
              const r = RADIUS[p.level];
              const fs = labelWorld(p.level);
              const lines = wrap(p.level === 0 ? p.node.label.toUpperCase() : p.node.label, p.level >= 2 ? 16 : 14, 3);
              const hidden = p.node.children.length * (1 - (p.level < 3 ? levelOp[p.level + 1] : 1));
              const showNote = p.level === 3 && ramp(z, 6, 8) > 0.05 && p.node.note;
              const noteFs = Math.min(fs * 0.82, 3.4);
              const gi = p.level === 0 ? 7 : p.branch % ACCENTS.length;
              const c = accentOf(p);
              const spike = r * (p.level === 0 ? 4.6 : p.level === 1 ? 3.2 : 3);
              return (
                <g
                  key={p.node.id}
                  className={`mm-node mm-l${p.level}${p.node.id === focusId ? " is-focus" : ""}`}
                  style={{ opacity: op, pointerEvents: op > 0.3 ? "all" : "none", color: c }}
                  transform={`translate(${p.x} ${p.y})`}
                  onClick={() => {
                    if (drag.current?.moved) return;
                    focus(p.node.id);
                  }}
                  tabIndex={op > 0.3 ? 0 : -1}
                  role="button"
                  aria-label={p.node.label}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && focus(p.node.id)}
                >
                  <circle r={r * (p.level === 0 ? 4 : 3.4)} fill={`url(#mm-g${gi})`} className={p.level === 0 ? "mm-halo mm-pulse" : "mm-halo"} />
                  {p.level < 2 && (
                    <path className="mm-spike" d={`M${-spike} 0H${spike}M0 ${-spike}V${spike}`} />
                  )}
                  {p.level === 0 ? (
                    <>
                      <circle r={r * 1.75} className="mm-corona">
                        <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="90s" repeatCount="indefinite" />
                      </circle>
                      <circle r={r * 2.4} className="mm-corona mm-corona-2" />
                      <circle r={r} fill="url(#mm-core)" />
                      <circle r={r * 0.38} fill="#fff" />
                    </>
                  ) : (
                    <>
                      <circle r={r * 2} className="mm-hit" />
                      <circle r={r} className="mm-body" />
                      <circle r={r * 0.42} className="mm-spark" />
                    </>
                  )}
                  {p.node.id === focusId && <circle r={r * 2.3} className="mm-focus-ring" vectorEffect="non-scaling-stroke" />}
                  {hidden > 0.2 && p.level > 0 && (
                    <text className="mm-more" x={r * 1.1} y={-r * 1.1} fontSize={fs * 0.7} style={{ opacity: hidden / Math.max(p.node.children.length, 1) }}>
                      +{p.node.children.length}
                    </text>
                  )}
                  {!hiddenLabels.has(p.node.id) && (
                    <text className="mm-label" textAnchor="middle" fontSize={p.level === 0 ? fs * 0.82 : fs} y={r * 1.35 + fs * 1.15}>
                      {lines.map((l, i) => (
                        <tspan key={i} x={0} dy={i === 0 ? 0 : fs * 1.12}>
                          {l}
                        </tspan>
                      ))}
                    </text>
                  )}
                  {showNote && (
                    <text className="mm-note" textAnchor="middle" fontSize={noteFs} y={r * 1.35 + fs * 1.15 + lines.length * fs * 1.12 + noteFs * 0.8} style={{ opacity: ramp(z, 6, 8) }}>
                      {wrap(p.node.note, 30, 5).map((l, i) => (
                        <tspan key={i} x={0} dy={i === 0 ? 0 : noteFs * 1.2}>
                          {l}
                        </tspan>
                      ))}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        <div className="mm-vignette" aria-hidden="true" />
        <div className="mm-meteor" aria-hidden="true" />

        <header className="mm-top" style={{ right: 14 + panelW }}>
          {embedded ? (
            onExpand && (
              <button type="button" className="mm-btn" onClick={onExpand} aria-label="Open full screen" title="Open full screen">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
                </svg>
              </button>
            )
          ) : (
            <button type="button" className="mm-btn" onClick={onClose} aria-label="Close Mind Constellation">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
          <div className="mm-title">
            <strong>{mindConstellationTitle(artifact.title)}</strong>
            <nav className="mm-trail mono" aria-label="Where you are">
              {trail.map((t, i) => (
                <span key={t.node.id}>
                  {i > 0 && <span className="mm-sep"> / </span>}
                  <button type="button" className="link-btn" onClick={() => focus(t.node.id)}>
                    {t.node.label}
                  </button>
                </span>
              ))}
            </nav>
          </div>
          <div className="mm-shapes" role="group" aria-label="Shape of the map">
            {SHAPES.map((x) => (
              <button key={x.id} type="button" className={`mm-shape${shape === x.id ? " is-on" : ""}`} aria-pressed={shape === x.id} onClick={() => setShape(x.id)}>
                {x.label}
              </button>
            ))}
          </div>
          {!panelOpen && wide && (
            <button type="button" className="mm-btn mm-btn-text" onClick={() => setPanelOpen(true)}>
              Details
            </button>
          )}
        </header>

        <div className="mm-controls" role="group" aria-label="Zoom">
          <button type="button" className="mm-btn" onClick={() => zoomBy(1.6, size.w / 2 - panelW / 2, size.h / 2)} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="mm-btn" onClick={() => zoomBy(1 / 1.6, size.w / 2 - panelW / 2, size.h / 2)} aria-label="Zoom out">
            &minus;
          </button>
          <button type="button" className="mm-btn" onClick={() => focus("root")} aria-label="Show everything" title="Show everything">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <circle cx="12" cy="12" r="3" />
              <circle cx="12" cy="12" r="9" strokeDasharray="2 3" />
            </svg>
          </button>
          {focused.parent && (
            <button type="button" className="mm-btn" onClick={up} aria-label="Back out one orbit" title="Back out one orbit">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 14l5-5 5 5" />
              </svg>
            </button>
          )}
        </div>
        <p className="mm-hint mono muted">Scroll to dive in. Drag to move. Click a star to fly to it.</p>

        <aside className={`mm-panel${panelOpen ? "" : " is-closed"}`} style={{ "--c": accentOf(focused) } as CSSProperties} aria-label="Selected topic">
          <div className="mm-panel-head">
            <span className="eyebrow">{["Centre", "Theme", "Sub-theme", "Point"][focused.level]}</span>
            {wide && (
              <button type="button" className="mm-btn mm-btn-sm" onClick={() => setPanelOpen(false)} aria-label="Hide details">
                &rsaquo;
              </button>
            )}
          </div>
          <h3>{focused.node.label}</h3>
          {focused.node.note && <p className="mm-note-text">{focused.node.note}</p>}
          {focused.node.children.length > 0 && (
            <>
              <p className="mm-panel-label mono">Orbiting here</p>
              <ul className="mm-chips">
                {focused.node.children.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="mm-chip" style={{ "--c": ACCENTS[(byId.get(c.id)?.branch ?? 0) % ACCENTS.length] } as CSSProperties} onClick={() => focus(c.id)}>
                      {c.label}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {focused.node.sources.length > 0 && (
            <>
              <p className="mm-panel-label mono">From your posts</p>
              <ul className="mm-sources">
                {focused.node.sources.map((s, i) => (
                  <li key={i}>
                    <button type="button" className="link-btn" onClick={() => setReading({ id: s.document_id, start: s.line_start, end: s.line_end })}>
                      {s.title}
                    </button>
                    <span className="mono muted small">
                      {" "}
                      lines {s.line_start}
                      {s.line_end > s.line_start ? ` to ${s.line_end}` : ""}
                    </span>
                    <p className="muted small mm-quote">{s.quote.length > 200 ? `${s.quote.slice(0, 200)}...` : s.quote}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {focused.parent && (
            <button type="button" className="btn btn-small" onClick={up}>
              Back to {focused.parent.node.label}
            </button>
          )}
        </aside>
      </div>
      {reading && <Reader documentId={reading.id} highlight={{ start: reading.start, end: reading.end }} onClose={() => setReading(null)} />}
    </div>
  );
  return embedded ? view : createPortal(view, document.body);
}

/* ---------- The right-rail list: every mind map in this notebook, one row each ---------- */

export function MindMapRow({
  artifact: initial,
  autoOpen,
  onOpen,
  onRemoved,
}: {
  artifact: Artifact;
  autoOpen?: boolean;
  onOpen: (a: Artifact) => void;
  onRemoved: (id: string) => void;
}) {
  const [artifact, setArtifact] = useState(initial);
  const job = useJob(artifact.job, () => {
    artifactsApi.get(artifact.id).then((a) => {
      setArtifact(a);
      if (autoOpen && a.status === "ready") onOpen(a);
    });
  });
  const running = job && (job.status === "queued" || job.status === "running");
  const ready = artifact.status === "ready";
  const failed = artifact.status === "failed" ? (artifact.content.error as string | undefined) ?? job?.error ?? "Could not build this map." : null;
  const nodes = artifact.content.node_count as number | undefined;
  const posts = artifact.content.post_count as number | undefined;
  return (
    <div className={`mm-row${ready ? " is-ready" : ""}`}>
      <button type="button" className="mm-row-main" disabled={!ready} onClick={() => onOpen(artifact)}>
        <span className="mm-row-art" aria-hidden="true">
          <svg viewBox="0 0 40 40" width="38" height="38">
            <circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" strokeOpacity=".35" strokeDasharray="2 3" />
            <circle cx="20" cy="20" r="4" fill="currentColor" />
            <circle cx="32" cy="14" r="2.4" fill="currentColor" />
            <circle cx="9" cy="26" r="2.4" fill="currentColor" />
            <circle cx="22" cy="33" r="1.8" fill="currentColor" />
          </svg>
        </span>
        <span className="mm-row-text">
          <strong>{artifact.title.replace(/^(?:Mind map|Idea Galaxy|Idea Constellation|Mind Constellation): /, "")}</strong>
          <span className="muted small">
            {ready ? `${nodes ?? 0} stars${posts ? ` · ${posts} posts` : ""} · ` : ""}
            {formatDate(artifact.created_at)}
          </span>
        </span>
      </button>
      {!ready && !failed && <StatusPill status={running ? (job!.status === "queued" ? "queued" : "working") : artifact.status} />}
      <ConfirmButton
        className="mm-row-del"
        confirmLabel="Sure?"
        onConfirm={async () => {
          await artifactsApi.remove(artifact.id);
          onRemoved(artifact.id);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
        </svg>
        <span className="sr-only">Delete {artifact.title}</span>
      </ConfirmButton>
      {running && job && (
        <div className="mm-row-progress">
          <JobProgress job={job} compact />
        </div>
      )}
      {failed && <p className="error-text small mm-row-progress">{failed}</p>}
    </div>
  );
}

/* ---------- The "what should the map be about" dialog ---------- */

export function MindMapDialog({
  docs,
  busy,
  error,
  onClose,
  onCreate,
}: {
  docs: { id: string; title: string }[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (documentIds: string[], focus: string) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(docs.map((d) => d.id)));
  const [focus, setFocus] = useState("");
  const [open, setOpen] = useState(docs.length <= 6);
  const all = picked.size === docs.length;
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  // Portaled to <body>: inside the side pane, a transform or filter on an ancestor would centre "fixed" on the pane.
  return createPortal(
    <Modal title="Mind Constellation" onClose={onClose} wide>
      <div className="mm-dialog">
        <section>
          <h3 className="mm-dialog-h">Sources</h3>
          <button type="button" className="mm-pick-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {picked.size} of {docs.length} posts
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? "rotate(180deg)" : undefined }}>
              <path d="m7 10 5 5 5-5" />
            </svg>
          </button>
          {open && (
            <div className="mm-pick">
              <label className="mm-pick-item mm-pick-all">
                <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(docs.map((d) => d.id)))} />
                <span>Select all</span>
              </label>
              {docs.map((d) => (
                <label key={d.id} className="mm-pick-item">
                  <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
                  <span>{d.title}</span>
                </label>
              ))}
            </div>
          )}
        </section>
        <section>
          <h3 className="mm-dialog-h">What should the topic be?</h3>
          <textarea
            className="input mm-focus"
            rows={5}
            value={focus}
            maxLength={500}
            onChange={(e) => setFocus(e.target.value)}
            placeholder={'Things to try\n- Centre it on one idea (e.g. "how I price my work")\n- Focus only on the arguments I changed my mind about\n- Help me study the key concepts across these posts'}
          />
        </section>
        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || picked.size === 0} onClick={() => onCreate([...picked], focus.trim())}>
            {busy ? "Starting..." : "Generate"}
          </button>
        </div>
      </div>
    </Modal>,
    document.body,
  );
}

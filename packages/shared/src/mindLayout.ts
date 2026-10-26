/** A Mind Constellation's layout and its exports, shared by the web and mobile explorers so every star sits in the same
 * place on both (web: frontend/src/components/MindMap.tsx). */
import type { MindNode } from "./types";

/* ---------- Layout: a galaxy. The centre idea, branches orbiting it, sub-themes orbiting each branch, points
   orbiting each sub-theme. Every orbit is smaller than the one above, so zooming in always reveals a new ring. ---------- */

export type Placed = { node: MindNode; level: number; x: number; y: number; parent: Placed | null; angle: number; branch: number };

export const RADIUS = [46, 26, 13, 4.6]; // node radius per level, in world units
export const TOPIC_ORBIT = 150;
export const DETAIL_ORBIT = 62;
export const LABEL_PX = [24, 17, 13, 12]; // label size on screen at scale 1
export const MAX_SCALE = 14;

export const mindConstellationTitle = (title: string) =>
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
export type Edge = { a: Placed; b: Placed; to: Placed; faint?: boolean };
export const MIN_GAP = 470; // branches keep this far apart so their sub-themes and points never collide
export const MIN_ROOT = 400;

export function hashSeed(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 997;
}
// Every map opens as a constellation figure; the switcher changes it, and the choice is remembered per map.
export const shapeFor = (_id: string): Shape => "constellation";

export function branchPoints(shape: Shape, n: number, seed: number): { x: number; y: number }[] {
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

export function place(root: MindNode, shape: Shape, seed: number): { nodes: Placed[]; edges: Edge[]; extent: number } {
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
export function link(edges: Edge[], parent: Placed, kids: Placed[], shape: Shape) {
  if (shape === "orbit") kids.forEach((k) => edges.push({ a: parent, b: k, to: k }));
  else
    kids.forEach((k, i) => edges.push({ a: i === 0 ? parent : kids[i - 1], b: k, to: k }));
}

export function wrap(text: string, max: number, maxLines = 3): string[] {
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

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const ramp = (z: number, a: number, b: number) => clamp((z - a) / (b - a), 0, 1);
export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function seeded(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// Themes stay inside the app palette: different strengths of the one blue. The centre is pale starlight.
export const ACCENTS = ["#217cff", "#4a96ff", "#2f6fe0", "#6fb0ff", "#1f5fd0", "#8cc0ff", "#3b86f0"];
export const CORE = "#bcd6ff";
export const accentOf = (p: Placed) => (p.branch < 0 ? CORE : ACCENTS[p.branch % ACCENTS.length]);
export const orbitOf = (n: number) => Math.max(320, 82 * n);

/** The map as a Markdown outline (each star a bullet, its note under it). */
export function mapOutline(title: string, root: MindNode): string {
  const lines = [`# ${title}`, ""];
  const walk = (n: MindNode, depth: number) => {
    const pad = "  ".repeat(depth);
    lines.push(`${pad}- **${n.label}**`);
    if (n.note) lines.push(`${pad}  ${n.note.replace(/\s*\n\s*/g, " ")}`);
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(root, 0);
  return `${lines.join("\n")}\n`;
}

export const EXPORT_LABEL = [34, 22, 14, 9.5]; // label size per level, in world units: the deepest stars stay readable
export const EXPORT_FONT = "Inter, 'Helvetica Neue', Arial, sans-serif";
export const EXPORT_MAX_PX = 3600; // the picture's longer side, at most
export const xmlEscape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The whole map drawn once, every label showing: an SVG of `w` x `h` pixels. */
export function mapSvg(title: string, root: MindNode, id: string, shape: Shape): { svg: string; w: number; h: number } {
  const { nodes, edges, extent } = place(root, shape, hashSeed(id));
  const labelLines = (p: Placed) => wrap(p.level === 0 ? p.node.label.toUpperCase() : p.node.label, p.level >= 2 ? 16 : 14, 3);
  // The world's bounds, with room for each star's glow and its label under it.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of nodes) {
    const fs = EXPORT_LABEL[p.level], r = RADIUS[p.level];
    const half = Math.max(r * 2.6, (Math.max(...labelLines(p).map((l) => l.length)) * fs * 0.6) / 2);
    x0 = Math.min(x0, p.x - half);
    x1 = Math.max(x1, p.x + half);
    y0 = Math.min(y0, p.y - r * 2.6);
    y1 = Math.max(y1, p.y + r + fs * (0.4 + 1.2 * labelLines(p).length));
  }
  const pad = 90;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const titleFs = Math.max(28, (x1 - x0) * 0.022);
  const band = titleFs * 3; // the title and a line under it, above the map
  y0 -= band;
  const ww = x1 - x0, wh = y1 - y0;
  const scale = Math.min(EXPORT_MAX_PX / ww, EXPORT_MAX_PX / wh, 4);
  const w = Math.round(ww * scale), h = Math.round(wh * scale);

  const out: string[] = [];
  const grads = [...ACCENTS, CORE].map((c, i) =>
    `<radialGradient id="g${i}"><stop offset="0%" stop-color="${c}" stop-opacity="0.95"/><stop offset="30%" stop-color="${c}" stop-opacity="0.4"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x0} ${y0} ${ww} ${wh}">`);
  out.push(`<defs>${grads.join("")}</defs>`);
  out.push(`<rect x="${x0}" y="${y0}" width="${ww}" height="${wh}" fill="#04060c"/>`);
  // a sky of faint stars, then a soft cloud behind the whole map and each theme
  for (let i = 0; i < 260; i++) {
    const sx = x0 + seeded(i + 11) * ww, sy = y0 + seeded(i + 611) * wh, sr = (0.5 + seeded(i + 1211) * 1.3) / scale * 1.6;
    out.push(`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${sr.toFixed(2)}" fill="${seeded(i + 77) > 0.7 ? "#a9c8ff" : "#fff"}" opacity="${(0.25 + seeded(i + 1811) * 0.5).toFixed(2)}"/>`);
  }
  out.push(`<circle cx="0" cy="0" r="${extent * 1.7}" fill="url(#g7)" opacity="0.22"/>`);
  for (const p of nodes.filter((q) => q.level === 1)) {
    out.push(`<circle cx="${p.x}" cy="${p.y}" r="${TOPIC_ORBIT * 2.3}" fill="url(#g${p.branch % ACCENTS.length})" opacity="0.25"/>`);
  }
  // the constellation lines
  for (const e of edges) {
    const sw = [0, 2.4, 1.5, 0.9][e.to.level];
    out.push(`<line x1="${e.a.x}" y1="${e.a.y}" x2="${e.b.x}" y2="${e.b.y}" stroke="${accentOf(e.to)}" stroke-width="${sw}" stroke-linecap="round" opacity="${e.faint ? 0.2 : 0.55}"/>`);
  }
  // the stars, deepest first so the outer ones' labels stay on top
  for (const p of [...nodes].reverse()) {
    const r = RADIUS[p.level], c = accentOf(p), gi = p.level === 0 ? 7 : p.branch % ACCENTS.length;
    out.push(`<circle cx="${p.x}" cy="${p.y}" r="${r * 2.6}" fill="url(#g${gi})"/>`);
    out.push(`<circle cx="${p.x}" cy="${p.y}" r="${r * (p.level === 0 ? 0.5 : 0.55)}" fill="${p.level === 0 ? "#ffffff" : c}"/>`);
  }
  for (const p of nodes) {
    const fs = EXPORT_LABEL[p.level];
    const fill = p.level <= 1 ? "#ffffff" : p.level === 2 ? "#dbe6ff" : "#a9bbd9";
    const weight = p.level <= 1 ? 600 : 500;
    const top = p.y + RADIUS[p.level] + fs * 1.05;
    const spans = labelLines(p).map((l, i) => `<tspan x="${p.x}" y="${(top + i * fs * 1.2).toFixed(1)}">${xmlEscape(l)}</tspan>`).join("");
    out.push(`<text text-anchor="middle" font-family="${EXPORT_FONT}" font-size="${fs}" font-weight="${weight}" fill="${fill}"${p.level === 0 ? ' letter-spacing="2"' : ""}>${spans}</text>`);
  }
  // the title, above the map
  const stars = nodes.length;
  out.push(`<text x="${x0 + pad}" y="${y0 + titleFs * 1.4}" font-family="${EXPORT_FONT}" font-size="${titleFs}" font-weight="700" fill="#ffffff">${xmlEscape(title)}</text>`);
  out.push(`<text x="${x0 + pad}" y="${y0 + titleFs * 2.3}" font-family="${EXPORT_FONT}" font-size="${titleFs * 0.5}" fill="#8fa3c4">Mind Constellation · ${stars} stars · Notestack</text>`);
  out.push("</svg>");
  return { svg: out.join(""), w, h };
}

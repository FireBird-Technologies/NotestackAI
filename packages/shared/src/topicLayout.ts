import type { TopicMap } from "./types";

// The topic map's layout, shared by the web map (frontend/src/pages/TopicMap.tsx) and the mobile one, so a star sits in
// the same place on both.

// Virtual canvas. The layout runs in open space and is then fitted into this box with a margin.
export const W = 1200;
export const H = 780;
const PAD = 90;

/** The canvas a layout is fitted into. */
export type Canvas = { w: number; h: number };
/** Wide screens. */
export const WIDE: Canvas = { w: W, h: H };
/** A phone held upright: the same map stood on end, so it fills the screen instead of a cropped strip. */
export const TALL: Canvas = { w: 720, h: 1080 };

export type P = { id: string; x: number; y: number; vx: number; vy: number; r: number; galaxy: number };

// Deterministic pseudo random, so the map looks the same on every visit.
export function seeded(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Force layout with generous spacing: strong repulsion (room for labels), long constellation lines,
 * a pull toward each galaxy's centre so related topics cluster, then fitted to the canvas. */
export function layout(data: TopicMap, canvas: Canvas = WIDE): Map<string, P> {
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
  // A tall canvas with a wide map: turn it a quarter. Every distance stays the same, so the clusters do too.
  if (canvas.h > canvas.w) {
    const spanX = Math.max(...nodes.map((n) => n.x)) - Math.min(...nodes.map((n) => n.x));
    const spanY = Math.max(...nodes.map((n) => n.y)) - Math.min(...nodes.map((n) => n.y));
    if (spanX > spanY) {
      for (const n of nodes) {
        const x = n.x;
        n.x = -n.y;
        n.y = x;
      }
    }
  }
  // Fit into the canvas with a margin, keeping proportions; never enlarge a small map past 1.4x.
  const pad = Math.min(PAD, canvas.w * 0.1);
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const s = Math.min((canvas.w - pad * 2) / Math.max(1, maxX - minX), (canvas.h - pad * 2) / Math.max(1, maxY - minY), 1.4);
  // A tall canvas stretches a squarish map down to fill it (up to 1.6x): only the gaps between rows grow, which gives
  // the wide labels more room.
  const sy = canvas.h > canvas.w ? Math.max(s, Math.min((canvas.h - pad * 2) / Math.max(1, maxY - minY), s * 1.6)) : s;
  const ox = (canvas.w - (maxX - minX) * s) / 2 - minX * s;
  const oy = (canvas.h - (maxY - minY) * sy) / 2 - minY * sy;
  for (const n of nodes) {
    n.x = n.x * s + ox;
    n.y = n.y * sy + oy;
  }
  return byId;
}

/** A box on the canvas. */
export type Rect = { x: number; y: number; w: number; h: number };
/** A star that wants its name shown, most important first; `must` (the selected star) always gets one. */
export type LabelWant = { id: string; x: number; y: number; r: number; text: string; must?: boolean };
/** Where a name goes: `ax` is its centre, left or right edge (by `align`), `top` its top, in canvas units. */
export type LabelSpot = { ax: number; top: number; align: "center" | "left" | "right"; box: Rect };

/** A line of text's size in screen pixels, near enough for keeping labels apart. */
export function textBox(text: string, font: number, tracking = 0): { w: number; h: number } {
  return { w: text.length * (font * 0.56 + tracking) + 6, h: font * 1.3 };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Names that fit without touching: each tries below its star, then above, right and left, and is shown at the first
 * spot that stays on the canvas and clear of the names already placed, the other stars and `blocked` (galaxy names).
 * One that fits nowhere is left out until a zoom makes room. `unit` is canvas units per screen pixel at this zoom, so
 * a name's screen size becomes canvas size.
 */
export function placeLabels(
  wants: LabelWant[],
  { unit, font, canvas, blocked = [] }: { unit: number; font: number; canvas: Canvas; blocked?: Rect[] },
): Map<string, LabelSpot> {
  const out = new Map<string, LabelSpot>();
  const taken: Rect[] = [...blocked];
  const gap = 4 * unit;
  const stars = wants.map((s) => ({ id: s.id, box: { x: s.x - s.r * 0.6, y: s.y - s.r * 0.6, w: s.r * 1.2, h: s.r * 1.2 } }));
  for (const s of wants) {
    const size = textBox(s.text, font);
    const w = size.w * unit;
    const h = size.h * unit;
    const tries: LabelSpot[] = [
      { ax: s.x, top: s.y + s.r + gap, align: "center", box: { x: s.x - w / 2, y: s.y + s.r + gap, w, h } },
      { ax: s.x, top: s.y - s.r - gap - h, align: "center", box: { x: s.x - w / 2, y: s.y - s.r - gap - h, w, h } },
      { ax: s.x + s.r + gap, top: s.y - h / 2, align: "left", box: { x: s.x + s.r + gap, y: s.y - h / 2, w, h } },
      { ax: s.x - s.r - gap, top: s.y - h / 2, align: "right", box: { x: s.x - s.r - gap - w, y: s.y - h / 2, w, h } },
    ];
    const inside = tries.filter((t) => t.box.x >= 0 && t.box.y >= 0 && t.box.x + t.box.w <= canvas.w && t.box.y + t.box.h <= canvas.h);
    const clear = inside.find(
      (t) => !taken.some((r) => overlaps(r, t.box)) && !stars.some((o) => o.id !== s.id && overlaps(o.box, t.box)),
    );
    const spot = clear ?? (s.must ? (inside[0] ?? tries[0]) : undefined);
    if (!spot) continue;
    out.set(s.id, spot);
    taken.push(spot.box);
  }
  return out;
}

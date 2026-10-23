import type { TopicMap } from "./types";

// The topic map's layout, shared by the web map (frontend/src/pages/TopicMap.tsx) and the mobile one, so a star sits in
// the same place on both.

// Virtual canvas. The layout runs in open space and is then fitted into this box with a margin.
export const W = 1200;
export const H = 780;
const PAD = 90;

export type P = { id: string; x: number; y: number; vx: number; vy: number; r: number; galaxy: number };

// Deterministic pseudo random, so the map looks the same on every visit.
export function seeded(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Force layout with generous spacing: strong repulsion (room for labels), long constellation lines,
 * a pull toward each galaxy's centre so related topics cluster, then fitted to the canvas. */
export function layout(data: TopicMap): Map<string, P> {
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

import {
  ACCENTS,
  accentOf,
  clamp,
  CORE,
  DETAIL_ORBIT,
  hashSeed,
  LABEL_PX,
  MAX_SCALE,
  MIN_ROOT,
  mindConstellationTitle,
  place,
  type Placed,
  RADIUS,
  ramp,
  seeded,
  type Shape,
  shapeFor,
  SHAPES,
  TOPIC_ORBIT,
  wrap,
} from "@notestack/shared/mindLayout";
import type { MindNode } from "@notestack/shared/types";
import * as SecureStore from "expo-secure-store";
import { SpaceGrotesk_500Medium, SpaceGrotesk_700Bold } from "@expo-google-fonts/space-grotesk";
import {
  Canvas,
  createPicture,
  PaintStyle,
  Picture,
  type SkCanvas,
  type SkFont,
  Skia,
  type SkPaint,
  type SkPathEffect,
  type SkShader,
  StrokeJoin,
  TileMode,
  useFont,
} from "@shopify/react-native-skia";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";
import { GestureDetector, GestureHandlerRootView, useExclusiveGestures, usePanGesture, usePinchGesture, useSimultaneousGestures, useTapGesture } from "react-native-gesture-handler";
import { Easing, useDerivedValue, useSharedValue, withTiming } from "react-native-reanimated";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";

import { ChevronIcon, ExpandIcon } from "@/ui/icons";
import { type Cited, ReaderSheet } from "@/artifacts/reader";
import { colors, fonts, radius } from "@/ui/theme";

/* The Mind Constellation explorer (web: MindMap.tsx MindMapExplorer), from the same layout, so every star sits where it
   does on the web. Pinch to zoom, drag to move, tap a star to fly to it, double-tap to dive in. The details of the star in
   view sit in a sheet under the map; the shape (Orbit, Spiral, Figure, Cluster) is remembered per map.

   Drawing: Skia draws the map on the GPU for every frame, from the live camera, on the UI thread. So it is sharp at
   every step of a move, nothing re-renders while it moves, and it needs one screen-sized surface, not a bitmap per
   redraw (the old SVG drawing ran low-memory phones out of memory). */

/** The map's own data: an artifact, or a report's block (its id seeds the layout). */
export type MindMapSource = { id: string; title: string; root: MindNode };

type Cam = { x: number; y: number; s: number };
const LEVEL_NAME = ["Centre", "Theme", "Sub-theme", "Point"];

/** The shape picked for this map in the explorer, else the map's own (its picture download uses it too). */
const storeKey = (id: string) => `ns_mindmap_shape_${id.replace(/[^\w.-]/g, "_")}`;
export function savedShape(id: string): Shape {
  try {
    const v = SecureStore.getItem(storeKey(id)) as Shape | null;
    if (v && SHAPES.some((x) => x.id === v)) return v;
  } catch {
    /* no storage: the map's own shape */
  }
  return shapeFor(id);
}

/** A sky of faint stars behind the map, fixed to the screen. */
const SKY = Array.from({ length: 120 }, (_, i) => ({ x: seeded(i + 1), y: seeded(i + 501), r: 0.4 + seeded(i + 901) * 1.1, o: 0.25 + seeded(i + 1301) * 0.55, blue: seeded(i + 77) > 0.7 }));

/** Where the camera should sit to frame a node and everything orbiting it, in a box of w x h. */
function frame(placed: Placed[], p: Placed, w: number, h: number): Cam {
  const members =
    p.level === 0
      ? placed
      : placed.filter((q) => {
          for (let c: Placed | null = q; c; c = c.parent) if (c === p) return true;
          return false;
        });
  const pad = p.level === 0 ? 70 : p.level === 3 ? 56 : 46;
  const minX = Math.min(...members.map((m) => m.x - RADIUS[m.level]));
  const maxX = Math.max(...members.map((m) => m.x + RADIUS[m.level]));
  const minY = Math.min(...members.map((m) => m.y - RADIUS[m.level]));
  const maxY = Math.max(...members.map((m) => m.y + RADIUS[m.level]));
  const s = clamp(Math.min(w / (2 * Math.max((maxX - minX) / 2 + pad, 60)), h / (2 * Math.max((maxY - minY) / 2 + pad, 60))), 0.02, MAX_SCALE);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, s };
}

/** The constellation as plain data the drawing worklet can read (a star's `parent` cannot cross to the UI thread). */
type Star = { x: number; y: number; level: number; branch: number; color: string; kids: number; text: string; lines: string[]; notes: string[] };
type Scene = { stars: Star[]; edges: { a: number; b: number; to: number; faint: boolean }[]; extent: number; orbit: boolean };
/** Who is in focus: 1 per star in the focused star's family (all 1 at the centre), the focused star, and whether lines flow. */
type FocusState = { mask: number[]; idx: number; flow: number };

function sceneOf(placed: Placed[], edges: { a: Placed; b: Placed; to: Placed; faint?: boolean }[], extent: number, shape: Shape): Scene {
  const index = new Map(placed.map((p, i) => [p, i]));
  return {
    stars: placed.map((p) => {
      const text = p.level === 0 ? p.node.label.toUpperCase() : p.node.label;
      return {
        x: p.x,
        y: p.y,
        level: p.level,
        branch: p.branch,
        color: accentOf(p),
        kids: p.node.children.length,
        text,
        lines: wrap(text, p.level >= 2 ? 16 : 14, 3),
        notes: p.level === 3 && p.node.note ? wrap(p.node.note, 30, 5) : [],
      };
    }),
    edges: edges.map((e) => ({ a: index.get(e.a)!, b: index.get(e.b)!, to: index.get(e.to)!, faint: !!e.faint })),
    extent,
    orbit: shape === "orbit",
  };
}

/** Focus on one star: it, everything it descends from and everything orbiting it stay bright; the rest dims. */
function focusState(placed: Placed[], id: string): FocusState {
  const idx = placed.findIndex((p) => p.node.id === id);
  const focused = placed[idx];
  if (!focused || focused.level === 0) return { mask: placed.map(() => 1), idx: -1, flow: 0 };
  const lineage = new Set<Placed>();
  for (let c: Placed | null = focused; c; c = c.parent) lineage.add(c);
  const mask = placed.map((p) => {
    if (lineage.has(p)) return 1;
    for (let c: Placed | null = p; c; c = c.parent) if (c === focused) return 1;
    return 0;
  });
  return { mask, idx, flow: 1 };
}

/** The paints, gradients and dashes, made once and reused for every frame. Glow `i` is ACCENTS[i]; the last is CORE. */
type Kit = { paint: SkPaint; glow: SkShader[]; core: SkShader; flowDash: SkPathEffect; ringDash: SkPathEffect; medium: SkFont; bold: SkFont };

function makeKit(medium: SkFont, bold: SkFont): Kit {
  const tint = (c: string, a: number) => {
    const v = Skia.Color(c);
    v[3] = a;
    return v;
  };
  const zero = { x: 0, y: 0 };
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  return {
    paint,
    glow: [...ACCENTS, CORE].map((c) => Skia.Shader.MakeRadialGradient(zero, 1, [tint(c, 0.95), tint(c, 0.4), tint(c, 0)], [0, 0.3, 1], TileMode.Clamp)),
    core: Skia.Shader.MakeRadialGradient(zero, 1, [tint("#fff", 1), tint("#dbe8ff", 1), tint("#7aa7ff", 0.9), tint("#217cff", 0)], [0, 0.3, 0.65, 1], TileMode.Clamp),
    flowDash: Skia.PathEffect.MakeDash([6, 4]),
    ringDash: Skia.PathEffect.MakeDash([2, 6]),
    medium,
    bold,
  };
}

/**
 * The constellation for the live camera (centre cx, cy and scale s), drawn on the UI thread every frame, so it is sharp
 * at every step of a move. `t` blends the focus from `from` to `to` as the camera flies. Opacity goes on each paint,
 * never on a group, so nothing is drawn offscreen.
 */
function drawMap(canvas: SkCanvas, scene: Scene, kit: Kit, w: number, h: number, cx: number, cy: number, s: number, fit: number, from: FocusState, to: FocusState, t: number) {
  "worklet";
  const paint = kit.paint;
  const stars = scene.stars;
  const ramp01 = (v: number, a: number, b: number) => Math.max(0, Math.min(1, (v - a) / (b - a)));
  const z = s / fit;
  const levelOp = [1, 1, ramp01(z, 1.25, 1.8), ramp01(z, 3.6, 5)];
  const sx = (x: number) => w / 2 + (x - cx) * s;
  const sy = (y: number) => h / 2 + (y - cy) * s;
  const onCanvas = (x: number, y: number, r: number) => x + r > 0 && x - r < w && y + r > 0 && y - r < h;
  const focusOf = (i: number) => from.mask[i] + (to.mask[i] - from.mask[i]) * t;
  const flowOf = (i: number) => from.flow * from.mask[i] * (1 - t) + to.flow * to.mask[i] * t;
  const focusedness = (i: number) => (to.idx === i ? t : 0) + (from.idx === i ? 1 - t : 0);
  const labelPx = (level: number) => LABEL_PX[level] * Math.pow(s, 0.3) * (level === 0 ? 0.82 : 1);

  const fill = (color: string, alpha: number) => {
    paint.setShader(null);
    paint.setPathEffect(null);
    paint.setStyle(PaintStyle.Fill);
    paint.setColor(Skia.Color(color));
    paint.setAlphaf(Math.max(0, Math.min(1, alpha)));
  };
  const stroke = (color: string, alpha: number, width: number, dash: SkPathEffect | null = null) => {
    fill(color, alpha);
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(width);
    paint.setPathEffect(dash);
  };
  /** A soft radial glow: the shader is made once at radius 1, so it is scaled into place. */
  const glow = (shader: SkShader, x: number, y: number, r: number, alpha: number) => {
    if (alpha < 0.005 || r <= 0) return;
    fill("#fff", alpha);
    paint.setShader(shader);
    canvas.save();
    canvas.translate(x, y);
    canvas.scale(r, r);
    canvas.drawCircle(0, 0, 1, paint);
    canvas.restore();
    paint.setShader(null);
  };
  /** Text centred on x, its baseline at y; the centre's name is spaced out. */
  const centred = (text: string, x: number, y: number, font: SkFont, spacing: number) => {
    if (!spacing) {
      canvas.drawText(text, x - font.measureText(text).width / 2, y, paint, font);
      return;
    }
    const widths = text.split("").map((ch) => font.measureText(ch).width);
    let left = x - (widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1)) / 2;
    text.split("").forEach((ch, i) => {
      canvas.drawText(ch, left, y, paint, font);
      left += widths[i] + spacing;
    });
  };

  // A sky of faint stars, fixed to the screen.
  for (const st of SKY) {
    fill(st.blue ? "#a9c8ff" : "#fff", st.o);
    canvas.drawCircle(st.x * w + st.r, st.y * h + st.r, st.r, paint);
  }

  // Nebula: a soft cloud behind the whole map and each theme.
  glow(kit.glow[ACCENTS.length], sx(0), sy(0), scene.extent * 1.7 * s, 0.22);
  stars.forEach((p, i) => {
    const r = TOPIC_ORBIT * 2.3 * s;
    if (p.level === 1 && onCanvas(sx(p.x), sy(p.y), r)) glow(kit.glow[p.branch % ACCENTS.length], sx(p.x), sy(p.y), r, 0.1 + 0.2 * focusOf(i));
  });

  // Orbits (the Orbit shape).
  if (scene.orbit) {
    stars.forEach((p, i) => {
      if (!p.kids || p.level > 2) return;
      const r = (p.level === 0 ? scene.extent : p.level === 1 ? TOPIC_ORBIT : DETAIL_ORBIT) * s;
      const op = levelOp[p.level + 1] * (0.3 + 0.7 * focusOf(i)) * 0.3;
      if (op < 0.01 || !onCanvas(sx(p.x), sy(p.y), r)) return;
      stroke(p.level === 0 ? "#8fbaff" : p.color, op, 1);
      canvas.drawCircle(sx(p.x), sy(p.y), r, paint);
    });
  }

  // Constellation lines: those into the focused family flow (dashed).
  for (const e of scene.edges) {
    const end = stars[e.to];
    const lo = levelOp[end.level];
    if (lo <= 0.03) continue;
    const f = focusOf(e.to);
    const flow = flowOf(e.to);
    const op = lo * (0.16 + 0.44 * f + 0.3 * flow) * (e.faint ? 0.4 : 1);
    stroke(end.color, op, 1 + 0.4 * flow, flow > 0.5 ? kit.flowDash : null);
    canvas.drawLine(sx(stars[e.a].x), sy(stars[e.a].y), sx(stars[e.b].x), sy(stars[e.b].y), paint);
  }

  // Declutter, as the web: a bigger or more central star claims its label's space; one that would overlap is hidden.
  const hidden: boolean[] = [];
  const kept: number[][] = [];
  const claims: { i: number; level: number; d: number; box: number[] }[] = [];
  stars.forEach((p, i) => {
    if (levelOp[p.level] * (0.28 + 0.72 * focusOf(i)) < 0.3) return;
    const fs = labelPx(p.level);
    const bw = Math.min(p.text.length, p.level >= 2 ? 16 : 14) * fs * 0.58;
    const top = sy(p.y) + RADIUS[p.level] * s * 1.35;
    const box = [sx(p.x) - bw / 2, sx(p.x) + bw / 2, top, top + fs * 1.3];
    claims.push({ i, level: p.level, d: (box[0] + box[1] - w) ** 2 + (box[2] + box[3] - h) ** 2, box });
  });
  claims.sort((a, b) => a.level - b.level || a.d - b.d);
  for (const c of claims) {
    const [x1, x2, y1, y2] = c.box;
    if (c.i === to.idx || kept.every((k) => !(x1 < k[1] && x2 > k[0] && y1 < k[3] && y2 > k[2]))) kept.push(c.box);
    else hidden[c.i] = true;
  }

  // Stars, deepest first, so the outer stars' labels stay on top.
  for (let i = stars.length - 1; i >= 0; i--) {
    const p = stars[i];
    const op = levelOp[p.level] * (0.28 + 0.72 * focusOf(i));
    const x = sx(p.x);
    const y = sy(p.y);
    const r = RADIUS[p.level] * s;
    if (op < 0.02 || !onCanvas(x, y, Math.max(r * 4, 120))) continue;
    const fs = labelPx(p.level);
    const ff = focusedness(i);
    glow(kit.glow[p.level === 0 ? ACCENTS.length : p.branch % ACCENTS.length], x, y, r * (p.level === 0 ? 4 : 3.4), 0.8 * op);
    if (p.level < 2) {
      const spike = r * (p.level === 0 ? 4.6 : 3.2);
      stroke("#fff", 0.38 * op, 0.9);
      canvas.drawLine(x - spike, y, x + spike, y, paint);
      canvas.drawLine(x, y - spike, x, y + spike, paint);
    }
    if (p.level === 0) {
      stroke("#bcd6ff", 0.5 * op, 1, kit.ringDash);
      canvas.drawCircle(x, y, r * 1.75, paint);
      stroke("#bcd6ff", 0.3 * op, 1, kit.ringDash);
      canvas.drawCircle(x, y, r * 2.4, paint);
      glow(kit.core, x, y, r, op);
      fill("#fff", op);
      canvas.drawCircle(x, y, r * 0.38, paint);
    } else {
      // The plain star, and over it the focused look, faded by how focused it is (so a change of focus blends).
      fill(p.level === 1 ? p.color : p.level === 2 ? "#1c3f86" : "#fff", op);
      canvas.drawCircle(x, y, r, paint);
      if (p.level < 3) {
        stroke(p.level === 1 ? "#fff" : p.color, op * (1 - ff) * (p.level === 1 ? 0.7 : 1), p.level === 2 ? 1.8 : 1.5);
        canvas.drawCircle(x, y, r, paint);
      }
      if (ff > 0) {
        fill("#fff", op * ff);
        canvas.drawCircle(x, y, r, paint);
        stroke("#8fbaff", op * ff, 3);
        canvas.drawCircle(x, y, r, paint);
        stroke(p.color, op * ff, 1.5);
        canvas.drawCircle(x, y, r * 2.3, paint);
      }
      fill(p.level === 2 ? p.color : "#fff", op * (p.level === 2 ? 1 - ff : 1));
      canvas.drawCircle(x, y, r * 0.42, paint);
      if (p.level === 2 && ff > 0) {
        fill("#fff", op * ff);
        canvas.drawCircle(x, y, r * 0.42, paint);
      }
    }
    const more = p.kids * (1 - (p.level < 3 ? levelOp[p.level + 1] : 1));
    if (more > 0.2 && p.level > 0) {
      kit.medium.setSize(fs * 0.7);
      fill("#8fbaff", op * (more / Math.max(p.kids, 1)));
      canvas.drawText(`+${p.kids}`, x + r * 1.1, y - r * 1.1, paint, kit.medium);
    }
    const labelY = y + r * 1.35 + fs * 1.15;
    if (!hidden[i]) {
      const font = p.level <= 1 ? kit.bold : kit.medium;
      font.setSize(fs);
      const spacing = p.level === 0 ? fs * 0.14 : 0;
      stroke("#000", op, fs * 0.22);
      paint.setStrokeJoin(StrokeJoin.Round);
      p.lines.forEach((l, k) => centred(l, x, labelY + k * fs * 1.12, font, spacing));
      fill("#fff", op * (p.level === 3 ? 0.88 : 1));
      p.lines.forEach((l, k) => centred(l, x, labelY + k * fs * 1.12, font, spacing));
    }
    const noteOp = p.notes.length ? ramp01(z, 6, 8) : 0;
    if (noteOp > 0.05) {
      const ns = Math.min(fs * 0.82, 3.4 * s);
      kit.medium.setSize(ns);
      fill("#fff", 0.78 * op * noteOp);
      p.notes.forEach((l, k) => centred(l, x, labelY + p.lines.length * fs * 1.12 + ns * (0.8 + k * 1.2), kit.medium, 0));
    }
  }
}

/**
 * The explorer. Full screen (`onClose` shows Back), or `embedded` in a report: then it is the map at rest, and a tap or
 * its corner button opens it full screen (`onExpand`), so the report keeps scrolling under a finger.
 */
export function MindMapExplorer({ map, onClose, feedback, embedded = false, onExpand, warp = true }: {
  map: MindMapSource;
  onClose?: () => void;
  /** The thumbs, first in the top bar as on the web. */
  feedback?: ReactNode;
  embedded?: boolean;
  onExpand?: () => void;
  warp?: boolean;
}) {
  const [shape, setShape] = useState<Shape>(() => savedShape(map.id));
  const seed = useMemo(() => hashSeed(map.id), [map.id]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // A screen taller than wide (a phone held upright) gets the figure stood on end, so it fills the height.
  const tall = size.h > size.w * 1.15;
  const { nodes: placed, edges, extent } = useMemo(
    () => (map.root ? place(map.root, shape, seed, tall) : { nodes: [], edges: [], extent: MIN_ROOT }),
    [map.root, shape, seed, tall],
  );
  const byId = useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed]);
  const [focusId, setFocusId] = useState("root");
  const [sheetOpen, setSheetOpen] = useState(false);
  // The details sheet's height as drawn, shut and now: it grows by the system bar's height on Android, so the zoom
  // buttons and the map's frame go by what it measures rather than a set number.
  const [sheetShut, setSheetShut] = useState(96);
  const [sheetNow, setSheetNow] = useState(96);
  const [cite, setCite] = useState<Cited | null>(null);
  // The camera, drawn live: its centre, and its scale as a log, so a zoom moves evenly.
  const lx = useSharedValue(0);
  const ly = useSharedValue(0);
  const ls = useSharedValue(Math.log(0.1));
  // The focus as drawn: from the last one to the new one, blended by focusT as the camera flies.
  const fromF = useSharedValue<FocusState>({ mask: [], idx: -1, flow: 0 });
  const toF = useSharedValue<FocusState>({ mask: [], idx: -1, flow: 0 });
  const focusT = useSharedValue(1);
  const entered = useRef(false);
  // The map is framed above the details sheet's heading.
  const boxH = Math.max(1, size.h - (embedded ? 0 : sheetShut + 24));
  const fit = useMemo(() => (placed.length && size.w ? frame(placed, placed[0], size.w, boxH).s : 1), [placed, size.w, boxH]);
  const minS = fit * 0.5;

  const scene = useMemo(() => sceneOf(placed, edges, extent, shape), [placed, edges, extent, shape]);
  const fitS = useSharedValue(fit);
  useEffect(() => fitS.set(fit), [fit, fitS]);
  // A new layout (a new shape): every star is new, so the focus starts at the centre.
  useEffect(() => {
    const all = focusState(placed, "root");
    fromF.set(all);
    toF.set(all);
    focusT.set(1);
  }, [placed, fromF, toF, focusT]);

  const medium = useFont(SpaceGrotesk_500Medium, 14);
  const bold = useFont(SpaceGrotesk_700Bold, 14);
  const kit = useMemo(() => (medium && bold ? makeKit(medium, bold) : null), [medium, bold]);
  const { w: cw, h: ch } = size;
  const picture = useDerivedValue(
    () =>
      createPicture((canvas) => {
        if (kit && fromF.get().mask.length === scene.stars.length && toF.get().mask.length === scene.stars.length) {
          drawMap(canvas, scene, kit, cw, ch, lx.get(), ly.get(), Math.exp(ls.get()), fitS.get(), fromF.get(), toF.get(), focusT.get());
        }
      }),
    [scene, kit, cw, ch],
  );

  /**
   * Fly the camera: pan and zoom together on one gentle curve (a soft start, a long easy landing), the zoom moving
   * geometrically so it feels even. Longer trips take a little longer. A new flight takes over from wherever the camera is.
   */
  const flyTo = (to: Cam, ms?: number) => {
    const s0 = Math.exp(ls.get());
    const trip = Math.abs(Math.log(to.s) - Math.log(s0)) + Math.min(2, (Math.hypot(to.x - lx.get(), to.y - ly.get()) * Math.min(s0, to.s)) / Math.max(size.w, 1));
    const cfg = { duration: ms ?? clamp(620 + 260 * trip, 700, 1150), easing: Easing.bezier(0.45, 0, 0.2, 1) };
    // The frame sits a little above the middle, clear of the details sheet.
    const dy = embedded ? 0 : (size.h - boxH) / 2 / to.s;
    lx.set(withTiming(to.x, cfg));
    ly.set(withTiming(to.y + dy, cfg));
    ls.set(withTiming(Math.log(to.s), cfg));
    return cfg;
  };
  const focus = (id: string, ms?: number) => {
    const p = byId.get(id) ?? placed[0];
    if (!p) return;
    setFocusId(p.level === 0 ? "root" : id);
    const cfg = flyTo(frame(placed, p, size.w, boxH), ms);
    // The dimming and the focus ring blend across with the flight, rather than switching at once.
    fromF.set(toF.get());
    toF.set(focusState(placed, p.level === 0 ? "root" : id));
    focusT.set(0);
    focusT.set(withTiming(1, cfg));
  };

  // Warp in: from far out, fly to the whole constellation.
  useEffect(() => {
    if (entered.current || !placed.length || !size.w) return;
    entered.current = true;
    const end = frame(placed, placed[0], size.w, boxH);
    const dy = embedded ? 0 : (size.h - boxH) / 2 / end.s;
    const start = warp ? { ...end, s: end.s * 0.25 } : end;
    lx.set(end.x);
    ly.set(end.y + dy);
    ls.set(Math.log(start.s));
    if (warp) flyTo(end, 1400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed.length, size.w, size.h]);

  // Turned (upright or back): every star moved, so frame the whole figure again.
  const tallSeen = useRef(tall);
  useEffect(() => {
    if (tallSeen.current === tall) return;
    tallSeen.current = tall;
    if (!entered.current || !placed.length) return;
    focus("root", 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tall]);

  // A new shape moves every star: fly back out to the whole figure, and remember the choice.
  const shapeSeen = useRef(shape);
  useEffect(() => {
    if (shapeSeen.current === shape) return;
    shapeSeen.current = shape;
    setFocusId("root");
    if (placed.length) flyTo(frame(placed, placed[0], size.w, boxH));
    try {
      SecureStore.setItem(storeKey(map.id), shape);
    } catch {
      /* fine */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  const zoomBy = (factor: number, fx = size.w / 2, fy = size.h / 2) => {
    const s0 = Math.exp(ls.get());
    const s = clamp(s0 * factor, minS, MAX_SCALE);
    const wx = lx.get() + (fx - size.w / 2) / s0;
    const wy = ly.get() + (fy - size.h / 2) / s0;
    flyTo({ s, x: wx - (fx - size.w / 2) / s, y: wy - (fy - size.h / 2) / s - (embedded ? 0 : (size.h - boxH) / 2 / s) }, 260);
  };
  /** A tap picks the nearest star in view, if it is close enough to the finger. */
  const tapAt = (tx: number, ty: number) => {
    const s = Math.exp(ls.get());
    const z = s / fit;
    const levelOp = [1, 1, ramp(z, 1.25, 1.8), ramp(z, 3.6, 5)];
    let best: Placed | null = null;
    let bestD = Infinity;
    for (const p of placed) {
      if (levelOp[p.level] < 0.3) continue;
      const d = Math.hypot(size.w / 2 + (p.x - lx.get()) * s - tx, size.h / 2 + (p.y - ly.get()) * s - ty);
      if (d < Math.max(RADIUS[p.level] * s * 2, 22) && d < bestD) [best, bestD] = [p, d];
    }
    if (!best) return;
    // The star already in focus, tapped again: let it go, and pull back out to the whole constellation.
    focus(best.node.id === focusId ? "root" : best.node.id);
  };

  const pan = usePanGesture({
    enabled: !embedded,
    onUpdate: (e) => {
      "worklet";
      const s = Math.exp(ls.get());
      lx.set(lx.get() - e.changeX / s);
      ly.set(ly.get() - e.changeY / s);
    },
  });
  const pinch = usePinchGesture({
    enabled: !embedded,
    onUpdate: (e) => {
      "worklet";
      const s0 = Math.exp(ls.get());
      const s = Math.min(MAX_SCALE, Math.max(minS, s0 * e.scaleChange));
      // Keep the world point under the fingers where it is.
      const wx = lx.get() + (e.focalX - size.w / 2) / s0;
      const wy = ly.get() + (e.focalY - size.h / 2) / s0;
      lx.set(wx - (e.focalX - size.w / 2) / s);
      ly.set(wy - (e.focalY - size.h / 2) / s);
      ls.set(Math.log(s));
    },
  });
  // Taps run here, on the JS side: embedded, either opens the map full screen.
  const onDoubleTap = (x: number, y: number) => (embedded ? onExpand?.() : zoomBy(1.8, x, y));
  const onTap = (x: number, y: number) => (embedded ? onExpand?.() : tapAt(x, y));
  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    onActivate: (e) => {
      "worklet";
      scheduleOnRN(onDoubleTap, e.x, e.y);
    },
  });
  const tap = useTapGesture({
    onActivate: (e) => {
      "worklet";
      scheduleOnRN(onTap, e.x, e.y);
    },
  });
  const gestures = useSimultaneousGestures(pan, pinch, useExclusiveGestures(doubleTap, tap));

  if (!map.root || !placed.length) return null;
  const focused = byId.get(focusId) ?? placed[0];
  const trail: Placed[] = [];
  for (let c: Placed | null = focused; c; c = c.parent) trail.unshift(c);
  const up = () => focused.parent && focus(focused.parent.node.id);

  return (
    <View style={[styles.stage, embedded && styles.embedded]} onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      <GestureDetector gesture={gestures}>
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          {size.w > 0 ? (
            <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
              <Picture picture={picture} />
            </Canvas>
          ) : null}
        </View>
      </GestureDetector>

      {embedded ? (
        onExpand ? (
          <Pressable onPress={onExpand} accessibilityRole="button" accessibilityLabel="Open full screen" style={[styles.btn, styles.corner]}>
            <ExpandIcon size={16} />
          </Pressable>
        ) : null
      ) : (
        <>
          <SafeAreaView edges={["top"]} style={styles.top} pointerEvents="box-none">
            <View style={styles.topRow}>
              {/* Back first, at the left edge, as the web's */}
              {onClose ? (
                <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Back" style={styles.btn}>
                  <Svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <Path d="M19 12H5M11 18l-6-6 6-6" />
                  </Svg>
                </Pressable>
              ) : null}
              {feedback}
              <View style={styles.titleBox}>
                <Text style={styles.title} numberOfLines={1}>
                  {mindConstellationTitle(map.title)}
                </Text>
                {/* One line; a long trail ends in "..." */}
                <Text style={styles.trail} numberOfLines={1} ellipsizeMode="tail">
                  {trail.map((t, i) => (
                    <Text key={t.node.id}>
                      {i > 0 ? <Text style={styles.sep}> / </Text> : null}
                      <Text onPress={() => focus(t.node.id)} style={styles.trailLink}>
                        {t.node.label}
                      </Text>
                    </Text>
                  ))}
                </Text>
              </View>
            </View>
            <View style={styles.shapes} accessibilityLabel="Shape of the map">
              {SHAPES.map((x) => (
                <Pressable key={x.id} onPress={() => setShape(x.id)} accessibilityRole="button" accessibilityState={{ selected: shape === x.id }} style={[styles.shape, shape === x.id && styles.shapeOn]}>
                  <Text style={[styles.shapeText, shape === x.id && styles.shapeTextOn]}>{x.label}</Text>
                </Pressable>
              ))}
            </View>
          </SafeAreaView>

          <View style={[styles.controls, { bottom: sheetNow + 12 }]}>
            <Pressable onPress={() => zoomBy(1.6)} accessibilityRole="button" accessibilityLabel="Zoom in" style={styles.btn}>
              <Text style={styles.btnText}>+</Text>
            </Pressable>
            <Pressable onPress={() => zoomBy(1 / 1.6)} accessibilityRole="button" accessibilityLabel="Zoom out" style={styles.btn}>
              <Text style={styles.btnText}>−</Text>
            </Pressable>
            <Pressable onPress={() => focus("root")} accessibilityRole="button" accessibilityLabel="Show everything" style={styles.btn}>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={1.6} strokeLinecap="round">
                <Circle cx="12" cy="12" r="3" />
                <Circle cx="12" cy="12" r="9" strokeDasharray="2 3" />
              </Svg>
            </Pressable>
            {focused.parent ? (
              <Pressable onPress={up} accessibilityRole="button" accessibilityLabel="Back out one orbit" style={styles.btn}>
                <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M7 14l5-5 5 5" />
                </Svg>
              </Pressable>
            ) : null}
          </View>

          {/* The star in view: shut to its heading at first, so the map has the screen */}
          <SafeAreaView
            edges={["bottom"]}
            style={[styles.sheet, sheetOpen && { height: size.h * 0.5 }]}
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              setSheetNow(h);
              if (!sheetOpen) setSheetShut(h);
            }}>
            <Pressable onPress={() => setSheetOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: sheetOpen }} style={styles.sheetHead}>
              <View style={styles.sheetHeadText}>
                <Text style={[styles.eyebrow, { color: accentOf(focused) }]}>{LEVEL_NAME[focused.level].toUpperCase()}</Text>
                <Text style={styles.sheetTitle} numberOfLines={sheetOpen ? 3 : 1}>
                  {focused.node.label}
                </Text>
              </View>
              <View style={!sheetOpen && styles.flip}>
                <ChevronIcon size={14} />
              </View>
            </Pressable>
            {sheetOpen ? (
              <ScrollView contentContainerStyle={styles.sheetBody}>
                {focused.node.note ? <Text style={styles.note}>{focused.node.note}</Text> : null}
                {focused.node.children.length > 0 ? (
                  <>
                    <Text style={styles.panelLabel}>ORBITING HERE</Text>
                    <View style={styles.chips}>
                      {focused.node.children.map((c) => (
                        <Pressable key={c.id} onPress={() => focus(c.id)} accessibilityRole="button" style={[styles.chip, { borderColor: ACCENTS[(byId.get(c.id)?.branch ?? 0) % ACCENTS.length] }]}>
                          <Text style={styles.chipText}>{c.label}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </>
                ) : null}
                {focused.node.sources.length > 0 ? (
                  <>
                    <Text style={styles.panelLabel}>FROM YOUR POSTS</Text>
                    {focused.node.sources.map((src, i) => (
                      <View key={i} style={styles.source}>
                        <Text style={styles.sourceTitle} onPress={() => setCite({ document_id: src.document_id, title: src.title, line_start: src.line_start, line_end: src.line_end, span: src.quote })}>
                          {src.title}
                          <Text style={styles.sourceLines}>
                            {"  "}lines {src.line_start}
                            {src.line_end > src.line_start ? ` to ${src.line_end}` : ""}
                          </Text>
                        </Text>
                        <Text style={styles.quote}>{src.quote.length > 200 ? `${src.quote.slice(0, 200)}...` : src.quote}</Text>
                      </View>
                    ))}
                  </>
                ) : null}
                {focused.parent ? (
                  <Pressable onPress={up} accessibilityRole="button" style={styles.backTo}>
                    <Text style={styles.backToText}>Back to {focused.parent.node.label}</Text>
                  </Pressable>
                ) : null}
              </ScrollView>
            ) : null}
          </SafeAreaView>
          <ReaderSheet cite={cite} onClose={() => setCite(null)} />
        </>
      )}
    </View>
  );
}

/** A Mind Constellation full screen, opened from its card or a report (web: the explorer's portal). */
export function MindMapScreen({ map, visible, onClose, feedback }: { map: MindMapSource; visible: boolean; onClose: () => void; feedback?: ReactNode }) {
  return (
    <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" supportedOrientations={["portrait", "landscape"]} onRequestClose={onClose}>
      {/* A Modal is its own window on Android, outside the app's gesture root: pinch and drag need one here. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          {visible ? <MindMapExplorer map={map} onClose={onClose} feedback={feedback} /> : null}
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, overflow: "hidden", backgroundColor: "#04060c" },
  embedded: { flex: 0, height: 340, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  corner: { position: "absolute", top: 10, right: 10 },
  top: { position: "absolute", left: 0, right: 0, top: 0, paddingHorizontal: 12, gap: 8 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 6 },
  btn: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: "rgba(4, 6, 12, 0.7)" },
  btnText: { color: colors.white, fontSize: 19, lineHeight: 21 },
  titleBox: { flex: 1, minWidth: 0, marginLeft: 4 },
  title: { color: colors.white, fontFamily: fonts.displayBold, fontSize: 15.5 },
  trail: { color: colors.text2, fontFamily: fonts.mono, fontSize: 11.5 },
  trailLink: { color: colors.text2 },
  sep: { color: colors.text3 },
  shapes: { flexDirection: "row", alignSelf: "flex-start", padding: 3, gap: 2, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: "rgba(4, 6, 12, 0.7)" },
  shape: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999 },
  shapeOn: { backgroundColor: colors.blue },
  shapeText: { color: colors.text2, fontSize: 12.5, fontWeight: "500" },
  shapeTextOn: { color: colors.white },
  controls: { position: "absolute", right: 12, gap: 8 },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(6, 10, 20, 0.96)",
  },
  sheetHead: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 18, paddingVertical: 14 },
  sheetHeadText: { flex: 1, gap: 3 },
  eyebrow: { fontFamily: fonts.mono, fontSize: 11.5, letterSpacing: 2.2 },
  sheetTitle: { color: colors.white, fontFamily: fonts.displayBold, fontSize: 18, lineHeight: 24 },
  flip: { transform: [{ rotate: "180deg" }] },
  sheetBody: { paddingHorizontal: 18, paddingBottom: 24, gap: 10 },
  note: { color: colors.text, fontSize: 15, lineHeight: 22 },
  panelLabel: { color: colors.text3, fontFamily: fonts.mono, fontSize: 11.5, letterSpacing: 1.6, marginTop: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  chipText: { color: colors.white, fontSize: 13.5 },
  source: { gap: 4 },
  sourceTitle: { color: colors.white, fontSize: 14.5, textDecorationLine: "underline", textDecorationColor: colors.blue },
  sourceLines: { color: colors.text3, fontFamily: fonts.mono, fontSize: 11.5, textDecorationLine: "none" },
  quote: { color: colors.text2, fontSize: 13, lineHeight: 19 },
  backTo: { alignSelf: "flex-start", marginTop: 6, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  backToText: { color: colors.white, fontSize: 14, fontWeight: "600" },
});

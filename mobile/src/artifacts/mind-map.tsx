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
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, usePinchGesture, useSimultaneousGestures, useTapGesture } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Defs, G, Line, Path, RadialGradient, Stop, Text as SvgText, TSpan } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";

import { ChevronIcon, ExpandIcon } from "@/ui/icons";
import { type Cited, ReaderSheet } from "@/artifacts/reader";
import { colors, fonts, radius } from "@/ui/theme";

/* The Mind Constellation explorer (web: MindMap.tsx MindMapExplorer), from the same layout, so every star sits where it
   does on the web. Pinch to zoom, drag to move, tap a star to fly to it, double-tap to dive in. The details of the star in
   view sit in a sheet under the map; the shape (Orbit, Spiral, Figure, Cluster) is remembered per map.

   Drawing: the map is drawn sharp, on screen, for a settled camera. While a finger or a flight moves the camera, that
   drawing is moved and scaled to follow it, and drawn sharp again once it settles. The drawing is twice the screen each
   way, so moving it never shows an empty edge. */

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

/** The constellation drawn for one camera, in a box of 2w x 2h whose middle is the screen's middle. */
function Drawing({ placed, edges, extent, shape, cam, w, h, fit, focusId }: {
  placed: Placed[];
  edges: { a: Placed; b: Placed; to: Placed; faint?: boolean }[];
  extent: number;
  shape: Shape;
  cam: Cam;
  w: number;
  h: number;
  fit: number;
  focusId: string;
}) {
  const s = cam.s;
  const z = s / fit;
  const levelOp = [1, 1, ramp(z, 1.25, 1.8), ramp(z, 3.6, 5)];
  const sx = (x: number) => w + (x - cam.x) * s;
  const sy = (y: number) => h + (y - cam.y) * s;
  const byId = new Map(placed.map((p) => [p.node.id, p]));
  const focused = byId.get(focusId) ?? placed[0];
  const lineage = new Set<string>();
  for (let c: Placed | null = focused; c; c = c.parent) lineage.add(c.node.id);
  const inFocus = (p: Placed) => {
    if (focusId === "root" || focused.level === 0 || lineage.has(p.node.id)) return true;
    for (let c: Placed | null = p; c; c = c.parent) if (c === focused) return true;
    return false;
  };
  const onCanvas = (x: number, y: number, r: number) => x + r > 0 && x - r < w * 2 && y + r > 0 && y - r < h * 2;
  const labelPx = (level: number) => LABEL_PX[level] * Math.pow(s, 0.3);

  // Declutter, as the web: a bigger or more central star claims its label's space; one that would overlap is hidden.
  const hidden = new Set<string>();
  const kept: { x1: number; x2: number; y1: number; y2: number }[] = [];
  placed
    .filter((p) => levelOp[p.level] * (inFocus(p) ? 1 : 0.28) >= 0.3)
    .map((p) => {
      const fs = labelPx(p.level) * (p.level === 0 ? 0.82 : 1);
      const text = p.level === 0 ? p.node.label.toUpperCase() : p.node.label;
      const bw = Math.min(text.length, p.level >= 2 ? 16 : 14) * fs * 0.58;
      const top = sy(p.y) + RADIUS[p.level] * s * 1.35;
      return { p, box: { x1: sx(p.x) - bw / 2, x2: sx(p.x) + bw / 2, y1: top, y2: top + fs * 1.3 } };
    })
    .sort((a, b) => a.p.level - b.p.level || (a.box.x1 + a.box.x2 - 2 * w) ** 2 + (a.box.y1 + a.box.y2 - 2 * h) ** 2 - ((b.box.x1 + b.box.x2 - 2 * w) ** 2 + (b.box.y1 + b.box.y2 - 2 * h) ** 2))
    .forEach(({ p, box }) => {
      if (p.node.id === focusId || kept.every((k) => !(box.x1 < k.x2 && box.x2 > k.x1 && box.y1 < k.y2 && box.y2 > k.y1))) kept.push(box);
      else hidden.add(p.node.id);
    });

  return (
    <Svg width={w * 2} height={h * 2}>
      <Defs>
        <RadialGradient id="mm-core" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.3" stopColor="#dbe8ff" />
          <Stop offset="0.65" stopColor="#7aa7ff" stopOpacity={0.9} />
          <Stop offset="1" stopColor="#217cff" stopOpacity={0} />
        </RadialGradient>
        {[...ACCENTS, CORE].map((c, i) => (
          <RadialGradient key={i} id={`mm-g${i}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={c} stopOpacity={0.95} />
            <Stop offset="0.3" stopColor={c} stopOpacity={0.4} />
            <Stop offset="1" stopColor={c} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      {/* nebula: a soft cloud behind the whole map and each theme */}
      <Circle cx={sx(0)} cy={sy(0)} r={extent * 1.7 * s} fill="url(#mm-g7)" opacity={0.22} />
      {placed
        .filter((p) => p.level === 1 && onCanvas(sx(p.x), sy(p.y), TOPIC_ORBIT * 2.3 * s))
        .map((p) => (
          <Circle key={`n${p.node.id}`} cx={sx(p.x)} cy={sy(p.y)} r={TOPIC_ORBIT * 2.3 * s} fill={`url(#mm-g${p.branch % ACCENTS.length})`} opacity={inFocus(p) ? 0.3 : 0.1} />
        ))}
      {/* orbits (the Orbit shape) */}
      {shape === "orbit"
        ? placed
            .filter((p) => p.node.children.length)
            .map((p) => {
              const r = (p.level === 0 ? extent : p.level === 1 ? TOPIC_ORBIT : DETAIL_ORBIT) * s;
              const op = levelOp[p.level + 1] * (inFocus(p) ? 1 : 0.3) * 0.3;
              if (op < 0.01 || !onCanvas(sx(p.x), sy(p.y), r)) return null;
              return <Circle key={`o${p.node.id}`} cx={sx(p.x)} cy={sy(p.y)} r={r} fill="none" stroke={p.level === 0 ? "#8fbaff" : accentOf(p)} strokeWidth={1} opacity={op} />;
            })
        : null}
      {/* constellation lines */}
      {edges
        .filter((e) => levelOp[e.to.level] > 0.03)
        .map((e) => {
          const live = inFocus(e.to);
          const flowing = live && focusId !== "root";
          return (
            <Line
              key={`l${e.a.node.id}-${e.b.node.id}`}
              x1={sx(e.a.x)}
              y1={sy(e.a.y)}
              x2={sx(e.b.x)}
              y2={sy(e.b.y)}
              stroke={accentOf(e.to)}
              strokeWidth={flowing ? 1.4 : 1}
              strokeDasharray={flowing ? "6 4" : undefined}
              opacity={levelOp[e.to.level] * (flowing ? 0.9 : live ? 0.6 : 0.16) * (e.faint ? 0.4 : 1)}
            />
          );
        })}
      {/* deepest first, so the outer stars' labels stay on top */}
      {[...placed].reverse().map((p) => {
        const op = levelOp[p.level] * (inFocus(p) ? 1 : 0.28);
        const x = sx(p.x);
        const y = sy(p.y);
        const r = RADIUS[p.level] * s;
        if (op < 0.02 || !onCanvas(x, y, Math.max(r * 4, 120))) return null;
        const fs = labelPx(p.level) * (p.level === 0 ? 0.82 : 1);
        const lines = wrap(p.level === 0 ? p.node.label.toUpperCase() : p.node.label, p.level >= 2 ? 16 : 14, 3);
        const more = p.node.children.length * (1 - (p.level < 3 ? levelOp[p.level + 1] : 1));
        const noteOp = p.level === 3 && p.node.note ? ramp(z, 6, 8) : 0;
        const c = accentOf(p);
        const isFocus = p.node.id === focusId;
        const spike = r * (p.level === 0 ? 4.6 : p.level === 1 ? 3.2 : 3);
        const labelY = y + r * 1.35 + fs * 1.15;
        const label = (stroke: boolean) => (
          <SvgText
            textAnchor="middle"
            fontSize={fs}
            fontFamily={fonts.displayMedium}
            fontWeight={p.level <= 1 ? "600" : "500"}
            letterSpacing={p.level === 0 ? fs * 0.14 : 0}
            fill={p.level === 3 ? "rgba(255,255,255,0.88)" : "#fff"}
            stroke={stroke ? "#000" : undefined}
            strokeWidth={stroke ? fs * 0.22 : 0}
            strokeLinejoin="round">
            {lines.map((l, i) => (
              <TSpan key={i} x={x} y={labelY + i * fs * 1.12}>
                {l}
              </TSpan>
            ))}
          </SvgText>
        );
        return (
          <G key={p.node.id} opacity={op}>
            <Circle cx={x} cy={y} r={r * (p.level === 0 ? 4 : 3.4)} fill={`url(#mm-g${p.level === 0 ? 7 : p.branch % ACCENTS.length})`} opacity={0.8} />
            {p.level < 2 ? <Path d={`M${x - spike} ${y}H${x + spike}M${x} ${y - spike}V${y + spike}`} stroke="#fff" strokeWidth={0.9} strokeOpacity={0.38} /> : null}
            {p.level === 0 ? (
              <>
                <Circle cx={x} cy={y} r={r * 1.75} fill="none" stroke="#bcd6ff" strokeOpacity={0.5} strokeDasharray="2 6" />
                <Circle cx={x} cy={y} r={r * 2.4} fill="none" stroke="#bcd6ff" strokeOpacity={0.3} strokeDasharray="2 6" />
                <Circle cx={x} cy={y} r={r} fill="url(#mm-core)" />
                <Circle cx={x} cy={y} r={r * 0.38} fill="#fff" />
              </>
            ) : (
              <>
                <Circle
                  cx={x}
                  cy={y}
                  r={r}
                  fill={isFocus ? "#fff" : p.level === 1 ? c : p.level === 2 ? "#1c3f86" : "#fff"}
                  stroke={isFocus ? "#8fbaff" : p.level === 1 ? "rgba(255,255,255,0.7)" : p.level === 2 ? c : "none"}
                  strokeWidth={isFocus ? 3 : p.level === 2 ? 1.8 : 1.5}
                />
                <Circle cx={x} cy={y} r={r * 0.42} fill={p.level === 2 && !isFocus ? c : "#fff"} />
              </>
            )}
            {isFocus ? <Circle cx={x} cy={y} r={r * 2.3} fill="none" stroke={c} strokeWidth={1.5} /> : null}
            {more > 0.2 && p.level > 0 ? (
              <SvgText x={x + r * 1.1} y={y - r * 1.1} fontSize={fs * 0.7} fill="#8fbaff" opacity={more / Math.max(p.node.children.length, 1)}>
                +{p.node.children.length}
              </SvgText>
            ) : null}
            {!hidden.has(p.node.id) ? (
              <>
                {label(true)}
                {label(false)}
              </>
            ) : null}
            {noteOp > 0.05 ? (
              <SvgText textAnchor="middle" fontSize={Math.min(fs * 0.82, 3.4 * s)} fill="rgba(255,255,255,0.78)" opacity={noteOp}>
                {wrap(p.node.note, 30, 5).map((l, i) => (
                  <TSpan key={i} x={x} y={labelY + lines.length * fs * 1.12 + Math.min(fs * 0.82, 3.4 * s) * (0.8 + i * 1.2)}>
                    {l}
                  </TSpan>
                ))}
              </SvgText>
            ) : null}
          </G>
        );
      })}
    </Svg>
  );
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
  const { nodes: placed, edges, extent } = useMemo(() => (map.root ? place(map.root, shape, seed) : { nodes: [], edges: [], extent: MIN_ROOT }), [map.root, shape, seed]);
  const byId = useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [focusId, setFocusId] = useState("root");
  const [cam, setCam] = useState<Cam>({ x: 0, y: 0, s: 0.1 });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cite, setCite] = useState<Cited | null>(null);
  // The live camera (the settled one is `cam`): its centre, and its scale as a log, so a zoom moves evenly.
  const lx = useSharedValue(0);
  const ly = useSharedValue(0);
  const ls = useSharedValue(Math.log(0.1));
  const entered = useRef(false);
  // The map is framed above the details sheet's heading.
  const boxH = Math.max(1, size.h - (embedded ? 0 : 120));
  const fit = useMemo(() => (placed.length && size.w ? frame(placed, placed[0], size.w, boxH).s : 1), [placed, size.w, boxH]);
  const minS = fit * 0.5;

  const settle = () => setCam({ x: lx.get(), y: ly.get(), s: Math.exp(ls.get()) });
  // The settled camera is drawn sharp; the drawing follows the live one until it settles.
  const follow = useAnimatedStyle(() => {
    const s = Math.exp(ls.get());
    return {
      transform: [{ translateX: (cam.x - lx.get()) * s }, { translateY: (cam.y - ly.get()) * s }, { scale: s / cam.s }],
    };
  });

  /** Fly the camera (eased; the scale moves geometrically, so the zoom feels even), then draw it sharp. */
  const flyTo = (to: Cam, ms = 950) => {
    const cfg = { duration: ms, easing: Easing.inOut(Easing.cubic) };
    // The frame sits a little above the middle, clear of the details sheet.
    const dy = embedded ? 0 : (size.h - boxH) / 2 / to.s;
    lx.set(withTiming(to.x, cfg));
    ly.set(withTiming(to.y + dy, cfg));
    ls.set(
      withTiming(Math.log(to.s), cfg, (done) => {
        "worklet";
        if (done) scheduleOnRN(settle);
      }),
    );
  };
  const focus = (id: string, ms?: number) => {
    const p = byId.get(id) ?? placed[0];
    if (!p) return;
    setFocusId(p.level === 0 ? "root" : id);
    flyTo(frame(placed, p, size.w, boxH), ms);
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
    setCam({ x: end.x, y: end.y + dy, s: start.s });
    if (warp) flyTo(end, 1400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed.length, size.w, size.h]);

  // A new shape moves every star: fly back out to the whole figure, and remember the choice.
  const shapeSeen = useRef(shape);
  useEffect(() => {
    if (shapeSeen.current === shape) return;
    shapeSeen.current = shape;
    setFocusId("root");
    if (placed.length) flyTo(frame(placed, placed[0], size.w, boxH), 900);
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
    if (best) focus(best.node.id);
  };

  const pan = usePanGesture({
    enabled: !embedded,
    onUpdate: (e) => {
      "worklet";
      const s = Math.exp(ls.get());
      lx.set(lx.get() - e.changeX / s);
      ly.set(ly.get() - e.changeY / s);
    },
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(settle);
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
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(settle);
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
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {SKY.map((st, i) => (
          <View key={i} style={[styles.sky, { left: `${st.x * 100}%`, top: `${st.y * 100}%`, width: st.r * 2, height: st.r * 2, borderRadius: st.r, opacity: st.o, backgroundColor: st.blue ? "#a9c8ff" : "#fff" }]} />
        ))}
      </View>
      <GestureDetector gesture={gestures}>
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          {size.w > 0 ? (
            <Animated.View style={[{ position: "absolute", left: -size.w / 2, top: -size.h / 2, width: size.w * 2, height: size.h * 2 }, follow]} pointerEvents="none">
              <Drawing placed={placed} edges={edges} extent={extent} shape={shape} cam={cam} w={size.w} h={size.h} fit={fit} focusId={focusId} />
            </Animated.View>
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

          <View style={[styles.controls, { bottom: (sheetOpen ? size.h * 0.5 : 96) + 12 }]}>
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
          <SafeAreaView edges={["bottom"]} style={[styles.sheet, sheetOpen && { height: size.h * 0.5 }]}>
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
      <SafeAreaProvider>
      {visible ? <MindMapExplorer map={map} onClose={onClose} feedback={feedback} /> : null}
    </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, overflow: "hidden", backgroundColor: "#04060c" },
  embedded: { flex: 0, height: 340, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  sky: { position: "absolute" },
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

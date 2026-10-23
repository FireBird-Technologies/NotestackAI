import { H, seeded, W, type P } from "@notestack/shared/topicLayout";
import type { TopicMap, TopicNode } from "@notestack/shared/types";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { GestureDetector, usePanGesture, usePinchGesture, useSimultaneousGestures } from "react-native-gesture-handler";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { colors, fonts } from "@/theme";
import { formatDate } from "@/ui";

export type ColorMode = "recency" | "momentum";

export const STATUS_LABEL: Record<TopicNode["status"], string> = {
  rising: "Rising",
  steady: "Steady orbit",
  dormant: "Dormant",
};

/** How far the map zooms in and out from where it opens (the web's MIN_W and MAX_W). */
const MAX_ZOOM = 8;
const MIN_ZOOM = 1 / 1.6;

/**
 * The constellation, as the web's SVG map (frontend/src/pages/TopicMap.tsx), drawn with views on a W x H virtual canvas.
 * Pinch to zoom, drag to pan, tap a star. Labels keep their size on screen as the canvas scales.
 */
export function StarMap({
  data,
  placed,
  mode,
  selectedId,
  focusId,
  onSelect,
  height,
}: {
  data: TopicMap;
  placed: Map<string, P>;
  mode: ColorMode;
  selectedId: string | null;
  /** A star to fly to (from the briefing); the map centres on it when this changes. */
  focusId: { id: string; at: number } | null;
  onSelect: (id: string) => void;
  height: number;
}) {
  const [box, setBox] = useState({ w: 0, h: height });
  const [zoomedIn, setZoomedIn] = useState(false);
  const [legend, setLegend] = useState(false);
  const zoom = useSharedValue(1);
  const ox = useSharedValue(0);
  const oy = useSharedValue(0);
  const base = useSharedValue(1);

  // Opens as the web does on a phone: the map's full height, cropped at the sides around its centre.
  const home = (w: number, h: number) => {
    const z = h / H;
    return { z, x: (w - W * z) / 2, y: 0 };
  };
  const onLayout = (e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    if (w === box.w && h === box.h) return;
    setBox({ w, h });
    const at = home(w, h);
    base.set(at.z);
    zoom.set(at.z);
    ox.set(at.x);
    oy.set(at.y);
  };

  /** Zoom by a factor around a point in the box (its centre by default), animated. */
  const zoomBy = (factor: number, fx = box.w / 2, fy = box.h / 2) => {
    const next = Math.min(base.get() * MAX_ZOOM, Math.max(base.get() * MIN_ZOOM, zoom.get() * factor));
    const f = next / zoom.get();
    ox.set(withTiming(fx - (fx - ox.get()) * f));
    oy.set(withTiming(fy - (fy - oy.get()) * f));
    zoom.set(withTiming(next));
  };
  const reset = () => {
    const at = home(box.w, box.h);
    zoom.set(withTiming(at.z));
    ox.set(withTiming(at.x));
    oy.set(withTiming(at.y));
  };

  // Fly to a star picked in the briefing: centred, at twice the opening zoom.
  useEffect(() => {
    const p = focusId ? placed.get(focusId.id) : undefined;
    if (!p || !box.w) return;
    const z = Math.max(zoom.get(), base.get() * 2);
    zoom.set(withTiming(z));
    ox.set(withTiming(box.w / 2 - p.x * z));
    oy.set(withTiming(box.h / 2 - p.y * z));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  const pan = usePanGesture({
    onUpdate: (e) => {
      "worklet";
      ox.set(ox.get() + e.changeX);
      oy.set(oy.get() + e.changeY);
    },
  });
  const pinch = usePinchGesture({
    onUpdate: (e) => {
      "worklet";
      const next = Math.min(base.get() * MAX_ZOOM, Math.max(base.get() * MIN_ZOOM, zoom.get() * e.scaleChange));
      const f = next / zoom.get();
      ox.set(e.focalX - (e.focalX - ox.get()) * f);
      oy.set(e.focalY - (e.focalY - oy.get()) * f);
      zoom.set(next);
    },
  });
  const gestures = useSimultaneousGestures(pan, pinch);

  // Zoomed in past a third, every star shows its name (the web's zoomedIn).
  useAnimatedReaction(
    () => zoom.get() / base.get() > 1.33,
    (now, before) => {
      if (now !== before) scheduleOnRN(setZoomedIn, now);
    },
  );

  const canvas = useAnimatedStyle(() => ({
    transform: [{ translateX: ox.get() }, { translateY: oy.get() }, { scale: zoom.get() }],
  }));

  const byId = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data]);
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of data.edges) {
      if (!m.has(e.source)) m.set(e.source, new Set());
      if (!m.has(e.target)) m.set(e.target, new Set());
      m.get(e.source)!.add(e.target);
      m.get(e.target)!.add(e.source);
    }
    return m;
  }, [data]);
  // A glow for each galaxy with more than one star: centred on its members, sized to cover them.
  const nebulae = useMemo(
    () =>
      data.galaxies
        .filter((g) => g.size > 1)
        .map((g) => {
          const pts = g.topic_ids.map((id) => placed.get(id)).filter(Boolean) as P[];
          const cx = pts.reduce((s, p) => s + p.x, 0) / Math.max(pts.length, 1);
          const cy = pts.reduce((s, p) => s + p.y, 0) / Math.max(pts.length, 1);
          const rx = Math.max(90, ...pts.map((p) => Math.abs(p.x - cx) + p.r)) + 50;
          const ry = Math.max(80, ...pts.map((p) => Math.abs(p.y - cy) + p.r)) + 45;
          return { ...g, cx, cy, rx, ry };
        }),
    [data, placed],
  );
  const brightest = useMemo(
    () => new Set([...data.nodes].sort((a, b) => b.post_count - a.post_count).slice(0, 3).map((n) => n.id)),
    [data],
  );
  const maxEdge = Math.max(1, ...data.edges.map((e) => e.weight));
  const focus = selectedId;
  const galaxyCount = nebulae.length;

  return (
    <View style={[styles.box, { height }]} onLayout={onLayout}>
      <GestureDetector gesture={gestures}>
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          <Animated.View style={[styles.canvas, canvas]}>
            <DeepField />
            {nebulae.map((g) => (
              <View key={g.id} pointerEvents="none">
                <View
                  style={{
                    position: "absolute",
                    left: g.cx - g.rx,
                    top: g.cy - g.ry,
                    width: g.rx * 2,
                    height: g.ry * 2,
                    borderRadius: Math.max(g.rx, g.ry),
                    backgroundImage:
                      "radial-gradient(ellipse closest-side, rgba(33,124,255,0.16) 0%, rgba(33,124,255,0.06) 60%, rgba(33,124,255,0) 100%)",
                  }}
                />
                <Disc
                  x={g.cx}
                  y={g.cy}
                  r={Math.min(g.rx, g.ry) * 0.75}
                  image="radial-gradient(closest-side, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.32) 12%, rgba(255,255,255,0.08) 40%, rgba(33,124,255,0.05) 70%, rgba(33,124,255,0) 100%)"
                />
                <ScaledLabel zoom={zoom} x={g.cx} y={g.cy - g.ry + 14} style={styles.galaxyLabel}>
                  {`${g.name.toUpperCase()} GALAXY`}
                </ScaledLabel>
              </View>
            ))}

            {data.edges.map((e) => {
              const a = placed.get(e.source);
              const b = placed.get(e.target);
              if (!a || !b) return null;
              const lit = Boolean(focus && (e.source === focus || e.target === focus));
              const strength = e.weight / maxEdge;
              return (
                <Line
                  key={`${e.source}-${e.target}`}
                  a={a}
                  b={b}
                  color={lit ? colors.blue : "#ffffff"}
                  opacity={lit ? 0.95 : focus ? 0.04 : 0.08 + strength * 0.3}
                  width={lit ? 1.4 + strength * 2 : 0.6 + strength * 1.8}
                  dashed={strength < 0.25 && !lit}
                />
              );
            })}

            {data.nodes.map((n) => {
              const p = placed.get(n.id);
              if (!p) return null;
              const near = Boolean(focus && neighbors.get(focus)?.has(n.id));
              const dim = Boolean(focus && focus !== n.id && !near);
              const active = selectedId === n.id;
              const showLabel = zoomedIn || brightest.has(n.id) || n.post_count >= 3 || active || near;
              return (
                <Star
                  key={n.id}
                  node={n}
                  p={p}
                  mode={mode}
                  bright={brightest.has(n.id)}
                  dim={dim}
                  active={active}
                  label={showLabel}
                  count={zoomedIn || active}
                  zoom={zoom}
                  onPress={() => onSelect(n.id)}
                />
              );
            })}
          </Animated.View>
        </View>
      </GestureDetector>

      {/* The readout and controls sit over the map, as on the web. */}
      <View style={styles.hud} pointerEvents="none">
        {selectedId && byId.get(selectedId) ? (
          <Text style={styles.hudText}>
            <Text style={styles.hudTitle}>{byId.get(selectedId)!.name}</Text>
            {"\n"}
            {byId.get(selectedId)!.post_count} posts · last {formatDate(byId.get(selectedId)!.last_at)} ·{" "}
            {STATUS_LABEL[byId.get(selectedId)!.status]}
          </Text>
        ) : (
          <Text style={styles.hudText}>
            {data.nodes.length} stars · {galaxyCount} galaxies · pinch to zoom, drag to pan, tap a star for its posts
          </Text>
        )}
      </View>
      <View style={styles.controls}>
        <Pressable onPress={() => zoomBy(1.33)} accessibilityRole="button" accessibilityLabel="Zoom in" style={styles.control}>
          <Text style={styles.controlText}>+</Text>
        </Pressable>
        <Pressable onPress={() => zoomBy(0.75)} accessibilityRole="button" accessibilityLabel="Zoom out" style={styles.control}>
          <Text style={styles.controlText}>-</Text>
        </Pressable>
        <Pressable onPress={reset} accessibilityRole="button" accessibilityLabel="Reset view" style={styles.control}>
          <Text style={[styles.controlText, styles.mono]}>1:1</Text>
        </Pressable>
      </View>
      <View style={styles.legendWrap}>
        {legend ? (
          <View style={styles.legend}>
            <Text style={styles.legendLine}>● size = posts</Text>
            {mode === "recency" ? (
              <Text style={styles.legendLine}>● brighter = written about recently</Text>
            ) : (
              <>
                <Text style={styles.legendLine}>➚ rising</Text>
                <Text style={styles.legendLine}>◌ dormant</Text>
              </>
            )}
            <Text style={styles.legendLine}>— lines = shared posts</Text>
          </View>
        ) : null}
        <Pressable onPress={() => setLegend((l) => !l)} accessibilityRole="button" style={styles.legendButton}>
          <Text style={styles.legendButtonText}>Legend</Text>
        </Pressable>
      </View>
    </View>
  );
}

function starColor(n: TopicNode, mode: ColorMode) {
  if (mode === "momentum") return n.status === "rising" ? "#ffffff" : n.status === "dormant" ? "rgba(255,255,255,0.45)" : colors.blue;
  // Recency: fresh topics burn white, old ones cool toward dim blue.
  return n.recency > 0.75 ? "#ffffff" : n.recency > 0.4 ? "#9cc4ff" : colors.blue;
}

function starGlow(n: TopicNode, mode: ColorMode) {
  return mode === "momentum" ? (n.status === "rising" ? 1 : n.status === "dormant" ? 0.25 : 0.55) : 0.25 + 0.75 * n.recency;
}

const STAR_GLOW =
  "radial-gradient(closest-side, rgba(255,255,255,0.9) 0%, rgba(33,124,255,0.55) 30%, rgba(33,124,255,0) 100%)";

function Star({
  node: n,
  p,
  mode,
  bright,
  dim,
  active,
  label,
  count,
  zoom,
  onPress,
}: {
  node: TopicNode;
  p: P;
  mode: ColorMode;
  bright: boolean;
  dim: boolean;
  active: boolean;
  label: boolean;
  count: boolean;
  zoom: SharedValue<number>;
  onPress: () => void;
}) {
  const color = starColor(n, mode);
  const core = Math.max(2.5, p.r * 0.42);
  const tail = mode === "momentum" && n.status === "rising" ? Math.min(90, 30 + n.momentum * 18) : 0;
  const hit = Math.max(p.r * 2.4, 22);
  return (
    <View style={{ opacity: dim ? 0.2 : 1 }}>
      {tail > 0 ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: p.x,
            top: p.y - p.r * 0.3,
            width: tail,
            height: p.r * 0.6,
            borderRadius: p.r,
            opacity: 0.8,
            transformOrigin: "0% 50%",
            transform: [{ rotate: "-24deg" }],
            backgroundImage: "linear-gradient(to right, rgba(255,255,255,0.85), rgba(33,124,255,0))",
          }}
        />
      ) : null}
      <Disc x={p.x} y={p.y} r={p.r * 2.1} image={STAR_GLOW} opacity={active ? 1 : starGlow(n, mode)} />
      {bright ? (
        <>
          <Line a={{ x: p.x - p.r * 2.4, y: p.y }} b={{ x: p.x + p.r * 2.4, y: p.y }} color={color} opacity={0.55} width={1} />
          <Line a={{ x: p.x, y: p.y - p.r * 2.4 }} b={{ x: p.x, y: p.y + p.r * 2.4 }} color={color} opacity={0.55} width={1} />
        </>
      ) : null}
      {mode === "momentum" && n.status === "dormant" ? (
        <Ring x={p.x} y={p.y} r={p.r * 0.9 + 4} color="rgba(255,255,255,0.5)" dashed />
      ) : null}
      <Disc x={p.x} y={p.y} r={core} color={color} />
      {active ? <Ring x={p.x} y={p.y} r={p.r + 12} color={colors.blue} /> : null}
      {label ? (
        <ScaledLabel zoom={zoom} x={p.x} y={p.y + p.r + 6} style={styles.starLabel}>
          {n.name}
          {count ? <Text style={styles.starCount}>{`  ${n.post_count}`}</Text> : null}
        </ScaledLabel>
      ) : null}
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${n.name}, ${n.post_count} posts, ${STATUS_LABEL[n.status]}`}
        style={{ position: "absolute", left: p.x - hit / 2, top: p.y - hit / 2, width: hit, height: hit, borderRadius: hit }}
      />
    </View>
  );
}

/** Text placed on the canvas at (x, y), centred, keeping its size on screen however far the canvas is zoomed. */
function ScaledLabel({
  zoom,
  x,
  y,
  style,
  children,
}: {
  zoom: SharedValue<number>;
  x: number;
  y: number;
  style: object;
  children: React.ReactNode;
}) {
  const counter = useAnimatedStyle(() => ({ transform: [{ scale: 1 / zoom.get() }] }));
  return (
    <Animated.View pointerEvents="none" style={[styles.labelBox, { left: x - 150, top: y }, counter]}>
      <Text style={style} numberOfLines={1}>
        {children}
      </Text>
    </Animated.View>
  );
}

function Disc({ x, y, r, color, image, opacity = 1 }: { x: number; y: number; r: number; color?: string; image?: string; opacity?: number }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: r,
        opacity,
        backgroundColor: color,
        backgroundImage: image,
      }}
    />
  );
}

function Ring({ x, y, r, color, dashed }: { x: number; y: number; r: number; color: string; dashed?: boolean }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: r,
        borderWidth: 1.2,
        borderColor: color,
        borderStyle: dashed ? "dashed" : "solid",
      }}
    />
  );
}

/** A straight line between two canvas points: a thin view, centred on the midpoint and turned to the angle. */
function Line({
  a,
  b,
  color,
  opacity,
  width,
  dashed,
}: {
  a: { x: number; y: number };
  b: { x: number; y: number };
  color: string;
  opacity: number;
  width: number;
  dashed?: boolean;
}) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: (a.x + b.x) / 2 - len / 2,
        top: (a.y + b.y) / 2 - width / 2,
        width: len,
        height: dashed ? 0 : width,
        opacity,
        backgroundColor: dashed ? undefined : color,
        borderTopWidth: dashed ? width : 0,
        borderColor: color,
        borderStyle: dashed ? "dashed" : "solid",
        transform: [{ rotate: `${angle}rad` }],
      }}
    />
  );
}

/** Faint background stars plus survey rings, drawn once. */
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
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {[140, 260, 390, 520].map((r) => (
        <Ring key={r} x={W / 2} y={H / 2} r={r} color="rgba(255,255,255,0.05)" />
      ))}
      <View style={[styles.axis, { left: W / 2, top: 0, width: 1, height: H }]} />
      <View style={[styles.axis, { left: 0, top: H / 2, width: W, height: 1 }]} />
      {stars.map((s, i) => (
        <Disc key={i} x={s.x} y={s.y} r={s.r} color="#ffffff" opacity={s.o} />
      ))}
    </View>
  );
}

/** Bars of posts over time, the recent stretch highlighted (web Sparkline). */
export function Sparkline({ values, height = 44, highlightFrom }: { values: number[]; height?: number; highlightFrom?: number }) {
  const max = Math.max(1, ...values);
  return (
    <View style={[styles.spark, { height }]}>
      {values.map((v, i) => (
        <View
          key={i}
          style={[
            styles.sparkBar,
            {
              height: v ? Math.max(2, (v / max) * (height - 2)) : 1,
              backgroundColor: highlightFrom !== undefined && i >= highlightFrom ? colors.blue : "rgba(255,255,255,0.3)",
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: "hidden", borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: "#05070b" },
  canvas: { position: "absolute", left: 0, top: 0, width: W, height: H, transformOrigin: "0 0" },
  axis: { position: "absolute", backgroundColor: "rgba(255,255,255,0.04)" },
  labelBox: { position: "absolute", width: 300, alignItems: "center", transformOrigin: "50% 0%" },
  starLabel: {
    color: colors.white,
    fontSize: 12.5,
    fontWeight: "500",
    textShadowColor: "#000",
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 0 },
  },
  starCount: { color: colors.blue, fontFamily: fonts.mono, fontSize: 11 },
  galaxyLabel: { color: "rgba(156,196,255,0.85)", fontFamily: fonts.mono, fontSize: 11, letterSpacing: 3 },
  hud: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 70,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(33,124,255,0.25)",
    backgroundColor: "rgba(5,7,11,0.85)",
  },
  hudText: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 19 },
  hudTitle: { color: colors.text, fontSize: 14 },
  controls: {
    position: "absolute",
    top: 12,
    right: 12,
    paddingVertical: 4,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(5,7,11,0.9)",
  },
  control: { width: 46, height: 44, alignItems: "center", justifyContent: "center" },
  controlText: { color: colors.text, fontSize: 20, fontWeight: "600" },
  mono: { fontFamily: fonts.mono, fontSize: 14 },
  legendWrap: { position: "absolute", right: 12, bottom: 12, alignItems: "flex-end", gap: 6 },
  legend: { padding: 10, gap: 4, borderRadius: 10, backgroundColor: "rgba(5,7,11,0.92)", borderWidth: 1, borderColor: colors.line },
  legendLine: { color: colors.text2, fontFamily: fonts.mono, fontSize: 12 },
  legendButton: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, backgroundColor: "rgba(5,7,11,0.92)" },
  legendButtonText: { color: colors.text2, fontFamily: fonts.mono, fontSize: 14, letterSpacing: 1 },
  spark: { flexDirection: "row", alignItems: "flex-end", gap: 2 },
  sparkBar: { flex: 1, borderRadius: 1 },
});

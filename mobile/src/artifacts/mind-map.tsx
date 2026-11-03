import {
  ACCENTS,
  accentOf,
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
  seeded,
  type Shape,
  shapeFor,
  SHAPES,
  TOPIC_ORBIT,
  wrap,
} from "@notestack/shared/mindLayout";
import type { MindNode } from "@notestack/shared/types";
import * as SecureStore from "expo-secure-store";
import { type ComponentRef, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { MIND_MAP_PAGE } from "@/artifacts/mind-map-page";
import { ChevronIcon, ExpandIcon } from "@/ui/icons";
import { type Cited, ReaderSheet } from "@/artifacts/reader";
import { colors, fonts, radius } from "@/ui/theme";

/* The Mind Constellation explorer (web: MindMap.tsx MindMapExplorer), from the same layout, so every star sits where it
   does on the web. Pinch to zoom, drag to move, tap a star to fly to it, double-tap to dive in. The details of the star in
   view sit in a sheet under the map; the shape (Orbit, Spiral, Figure, Cluster) is remembered per map.

   Drawing: a <canvas> in a WebView (mind-map-page.ts), redrawn by the browser on the GPU every frame while the map
   moves, so it is sharp at every step of a flight; the camera, gestures and flights run in that page. Its memory is one
   screen-sized canvas: the old SVG drawing made a bitmap four times the screen on every move, which ran low-memory
   phones out of memory. (No native graphics library: Skia's build ran the store build machine out of memory.) */

/** The map's own data: an artifact, or a report's block (its id seeds the layout). */
export type MindMapSource = { id: string; title: string; root: MindNode };

const LEVEL_NAME = ["Centre", "Theme", "Sub-theme", "Point"];

/** The shape picked for this map in the explorer, else the map's own (its picture download uses it too). */
const storeKey = (id: string) =>
  `ns_mindmap_shape_${id.replace(/[^\w.-]/g, "_")}`;
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
const SKY = Array.from({ length: 120 }, (_, i) => ({
  x: seeded(i + 1),
  y: seeded(i + 501),
  r: 0.4 + seeded(i + 901) * 1.1,
  o: 0.25 + seeded(i + 1301) * 0.55,
  blue: seeded(i + 77) > 0.7,
}));

/** Everything a star frames: itself and all that orbits it (the centre frames the whole map). */
function membersOf(placed: Placed[], p: Placed): Placed[] {
  if (p.level === 0) return placed;
  return placed.filter((q) => {
    for (let c: Placed | null = q; c; c = c.parent) if (c === p) return true;
    return false;
  });
}

/** The constellation as plain data for the drawing page, with each star's parent and the box it frames. */
function sceneOf(
  placed: Placed[],
  edges: { a: Placed; b: Placed; to: Placed; faint?: boolean }[],
  extent: number,
  shape: Shape,
) {
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
        parent: p.parent ? index.get(p.parent)! : -1,
        text,
        lines: wrap(text, p.level >= 2 ? 16 : 14, 3),
        notes: p.level === 3 && p.node.note ? wrap(p.node.note, 30, 5) : [],
      };
    }),
    // minX, maxX, minY, maxY of what each star frames, edges included by each member's own radius.
    boxes: placed.map((p) => {
      const m = membersOf(placed, p);
      return [
        Math.min(...m.map((q) => q.x - RADIUS[q.level])),
        Math.max(...m.map((q) => q.x + RADIUS[q.level])),
        Math.min(...m.map((q) => q.y - RADIUS[q.level])),
        Math.max(...m.map((q) => q.y + RADIUS[q.level])),
      ];
    }),
    edges: edges.map((e) => ({
      a: index.get(e.a)!,
      b: index.get(e.b)!,
      to: index.get(e.to)!,
      faint: !!e.faint,
    })),
    extent,
    orbit: shape === "orbit",
    consts: {
      RADIUS,
      LABEL_PX,
      TOPIC_ORBIT,
      DETAIL_ORBIT,
      MAX_SCALE,
      ACCENTS,
      CORE,
      SKY,
    },
  };
}

/**
 * The explorer. Full screen (`onClose` shows Back), or `embedded` in a report: then it is the map at rest, and a tap or
 * its corner button opens it full screen (`onExpand`), so the report keeps scrolling under a finger.
 */
export function MindMapExplorer({
  map,
  onClose,
  feedback,
  embedded = false,
  onExpand,
  warp = true,
}: {
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
  const {
    nodes: placed,
    edges,
    extent,
  } = useMemo(
    () =>
      map.root
        ? place(map.root, shape, seed, tall)
        : { nodes: [], edges: [], extent: MIN_ROOT },
    [map.root, shape, seed, tall],
  );
  const byId = useMemo(
    () => new Map(placed.map((p) => [p.node.id, p])),
    [placed],
  );
  const [focusId, setFocusId] = useState("root");
  const [sheetOpen, setSheetOpen] = useState(false);
  // The details sheet's height as drawn, shut and now: it grows by the system bar's height on Android, so the zoom
  // buttons and the map's frame go by what it measures rather than a set number.
  const [sheetShut, setSheetShut] = useState(96);
  const [sheetNow, setSheetNow] = useState(96);
  const [cite, setCite] = useState<Cited | null>(null);

  // The drawing page: it owns the camera and the gestures; this side sends it the map and what to show, and hears taps.
  const page = useRef<ComponentRef<typeof WebView>>(null);
  const [ready, setReady] = useState(false);
  const send = (msg: object) =>
    page.current?.injectJavaScript(
      `window.__mm && window.__mm(${JSON.stringify(msg)}); true;`,
    );
  const scene = useMemo(
    () => sceneOf(placed, edges, extent, shape),
    [placed, edges, extent, shape],
  );
  const indexOf = useMemo(
    () => new Map(placed.map((p, i) => [p.node.id, i])),
    [placed],
  );

  // The details sheet's height (the map is framed above it), then the map itself: a new one flies out to everything.
  useEffect(() => {
    if (ready)
      send({ layout: { sheetH: embedded ? 0 : sheetShut, embedded, warp } });
  }, [ready, sheetShut, embedded, warp]);
  useEffect(() => {
    // The page starts every map at its centre and says so ({ focused: -1 }), so the sheet follows. Not before the stage
    // is measured: the first layout (0 by 0) is laid out wide, and an upright phone's would replace it mid flight.
    if (ready && placed.length && size.w > 0) send({ scene });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, scene, size.w > 0]);

  /** Fly to a star (the centre shows everything): from the trail, the chips, Back to, and the buttons. */
  const focus = (id: string) => {
    const p = byId.get(id) ?? placed[0];
    if (!p) return;
    setFocusId(p.level === 0 ? "root" : id);
    send({ focus: p.level === 0 ? -1 : (indexOf.get(id) ?? -1) });
  };
  const zoomBy = (factor: number) => send({ zoom: factor });
  /** The page's word: listening, or a tap moved the focus (a focused star tapped again lets go: everything). */
  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as {
        ready?: boolean;
        focused?: number;
      };
      if (msg.ready) setReady(true);
      if (msg.focused !== undefined)
        setFocusId(
          msg.focused < 0 ? "root" : (placed[msg.focused]?.node.id ?? "root"),
        );
    } catch {
      /* not ours */
    }
  };

  // A new shape moves every star: fly back out to the whole figure, and remember the choice.
  const shapeSeen = useRef(shape);
  useEffect(() => {
    if (shapeSeen.current === shape) return;
    shapeSeen.current = shape;
    setFocusId("root");
    try {
      SecureStore.setItem(storeKey(map.id), shape);
    } catch {
      /* fine */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  if (!map.root || !placed.length) return null;
  const focused = byId.get(focusId) ?? placed[0];
  const trail: Placed[] = [];
  for (let c: Placed | null = focused; c; c = c.parent) trail.unshift(c);
  const up = () => focused.parent && focus(focused.parent.node.id);

  return (
    <View
      style={[styles.stage, embedded && styles.embedded]}
      onLayout={(e) =>
        setSize({
          w: e.nativeEvent.layout.width,
          h: e.nativeEvent.layout.height,
        })
      }
    >
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents={embedded ? "none" : "auto"}
      >
        <WebView
          ref={page}
          source={{ html: MIND_MAP_PAGE }}
          originWhitelist={["*"]}
          onMessage={onMessage}
          style={styles.page}
          containerStyle={styles.page}
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          setBuiltInZoomControls={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          // A fresh page if the system reclaims the WebView's process, rather than a blank map.
          onContentProcessDidTerminate={() => {
            page.current?.reload();
          }}
          onRenderProcessGone={() => {
            page.current?.reload();
          }}
        />
      </View>
      {/* In a report the map is at rest: a tap opens it full screen, and a drag scrolls the report. */}
      {embedded ? (
        <Pressable
          onPress={onExpand}
          accessibilityRole="button"
          accessibilityLabel="Open the map full screen"
          style={StyleSheet.absoluteFill}
        />
      ) : null}

      {embedded ? (
        onExpand ? (
          <Pressable
            onPress={onExpand}
            accessibilityRole="button"
            accessibilityLabel="Open full screen"
            style={[styles.btn, styles.corner]}
          >
            <ExpandIcon size={16} />
          </Pressable>
        ) : null
      ) : (
        <>
          <SafeAreaView
            edges={["top"]}
            style={styles.top}
            pointerEvents="box-none"
          >
            <View style={styles.topRow}>
              {/* Back first, at the left edge, as the web's */}
              {onClose ? (
                <Pressable
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Back"
                  style={styles.btn}
                >
                  <Svg
                    width={15}
                    height={15}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#fff"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
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
                <Text
                  style={styles.trail}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {trail.map((t, i) => (
                    <Text key={t.node.id}>
                      {i > 0 ? <Text style={styles.sep}> / </Text> : null}
                      <Text
                        onPress={() => focus(t.node.id)}
                        style={styles.trailLink}
                      >
                        {t.node.label}
                      </Text>
                    </Text>
                  ))}
                </Text>
              </View>
            </View>
            <View style={styles.shapes} accessibilityLabel="Shape of the map">
              {SHAPES.map((x) => (
                <Pressable
                  key={x.id}
                  onPress={() => setShape(x.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: shape === x.id }}
                  style={[styles.shape, shape === x.id && styles.shapeOn]}
                >
                  <Text
                    style={[
                      styles.shapeText,
                      shape === x.id && styles.shapeTextOn,
                    ]}
                  >
                    {x.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </SafeAreaView>

          <View style={[styles.controls, { bottom: sheetNow + 12 }]}>
            <Pressable
              onPress={() => zoomBy(1.6)}
              accessibilityRole="button"
              accessibilityLabel="Zoom in"
              style={styles.btn}
            >
              <Text style={styles.btnText}>+</Text>
            </Pressable>
            <Pressable
              onPress={() => zoomBy(1 / 1.6)}
              accessibilityRole="button"
              accessibilityLabel="Zoom out"
              style={styles.btn}
            >
              <Text style={styles.btnText}>−</Text>
            </Pressable>
            <Pressable
              onPress={() => focus("root")}
              accessibilityRole="button"
              accessibilityLabel="Show everything"
              style={styles.btn}
            >
              <Svg
                width={16}
                height={16}
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                strokeWidth={1.6}
                strokeLinecap="round"
              >
                <Circle cx="12" cy="12" r="3" />
                <Circle cx="12" cy="12" r="9" strokeDasharray="2 3" />
              </Svg>
            </Pressable>
            {focused.parent ? (
              <Pressable
                onPress={up}
                accessibilityRole="button"
                accessibilityLabel="Back out one orbit"
                style={styles.btn}
              >
                <Svg
                  width={16}
                  height={16}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#fff"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
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
            }}
          >
            <Pressable
              onPress={() => setSheetOpen((o) => !o)}
              accessibilityRole="button"
              accessibilityState={{ expanded: sheetOpen }}
              style={styles.sheetHead}
            >
              <View style={styles.sheetHeadText}>
                <Text style={[styles.eyebrow, { color: accentOf(focused) }]}>
                  {LEVEL_NAME[focused.level].toUpperCase()}
                </Text>
                <Text
                  style={styles.sheetTitle}
                  numberOfLines={sheetOpen ? 3 : 1}
                >
                  {focused.node.label}
                </Text>
              </View>
              <View style={!sheetOpen && styles.flip}>
                <ChevronIcon size={14} />
              </View>
            </Pressable>
            {sheetOpen ? (
              <ScrollView contentContainerStyle={styles.sheetBody}>
                {focused.node.note ? (
                  <Text style={styles.note}>{focused.node.note}</Text>
                ) : null}
                {focused.node.children.length > 0 ? (
                  <>
                    <Text style={styles.panelLabel}>ORBITING HERE</Text>
                    <View style={styles.chips}>
                      {focused.node.children.map((c) => (
                        <Pressable
                          key={c.id}
                          onPress={() => focus(c.id)}
                          accessibilityRole="button"
                          style={[
                            styles.chip,
                            {
                              borderColor:
                                ACCENTS[
                                  (byId.get(c.id)?.branch ?? 0) % ACCENTS.length
                                ],
                            },
                          ]}
                        >
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
                        <Text
                          style={styles.sourceTitle}
                          onPress={() =>
                            setCite({
                              document_id: src.document_id,
                              title: src.title,
                              line_start: src.line_start,
                              line_end: src.line_end,
                              span: src.quote,
                            })
                          }
                        >
                          {src.title}
                          <Text style={styles.sourceLines}>
                            {"  "}lines {src.line_start}
                            {src.line_end > src.line_start
                              ? ` to ${src.line_end}`
                              : ""}
                          </Text>
                        </Text>
                        <Text style={styles.quote}>
                          {src.quote.length > 200
                            ? `${src.quote.slice(0, 200)}...`
                            : src.quote}
                        </Text>
                      </View>
                    ))}
                  </>
                ) : null}
                {focused.parent ? (
                  <Pressable
                    onPress={up}
                    accessibilityRole="button"
                    style={styles.backTo}
                  >
                    <Text style={styles.backToText}>
                      Back to {focused.parent.node.label}
                    </Text>
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
export function MindMapScreen({
  map,
  visible,
  onClose,
  feedback,
}: {
  map: MindMapSource;
  visible: boolean;
  onClose: () => void;
  feedback?: ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      animationType="fade"
      presentationStyle="fullScreen"
      supportedOrientations={["portrait", "landscape"]}
      onRequestClose={onClose}
    >
      {/* A Modal is its own window on Android, outside the app's gesture root: pinch and drag need one here. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          {visible ? (
            <MindMapExplorer map={map} onClose={onClose} feedback={feedback} />
          ) : null}
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, overflow: "hidden", backgroundColor: "#04060c" },
  page: { flex: 1, backgroundColor: "transparent" },
  embedded: {
    flex: 0,
    height: 340,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  corner: { position: "absolute", top: 10, right: 10 },
  top: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    paddingHorizontal: 12,
    gap: 8,
  },
  topRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 6 },
  btn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(4, 6, 12, 0.7)",
  },
  btnText: { color: colors.white, fontSize: 19, lineHeight: 21 },
  titleBox: { flex: 1, minWidth: 0, marginLeft: 4 },
  title: { color: colors.white, fontFamily: fonts.displayBold, fontSize: 15.5 },
  trail: { color: colors.text2, fontFamily: fonts.mono, fontSize: 11.5 },
  trailLink: { color: colors.text2 },
  sep: { color: colors.text3 },
  shapes: {
    flexDirection: "row",
    alignSelf: "flex-start",
    padding: 3,
    gap: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(4, 6, 12, 0.7)",
  },
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
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  sheetHeadText: { flex: 1, gap: 3 },
  eyebrow: { fontFamily: fonts.mono, fontSize: 11.5, letterSpacing: 2.2 },
  sheetTitle: {
    color: colors.white,
    fontFamily: fonts.displayBold,
    fontSize: 18,
    lineHeight: 24,
  },
  flip: { transform: [{ rotate: "180deg" }] },
  sheetBody: { paddingHorizontal: 18, paddingBottom: 24, gap: 10 },
  note: { color: colors.text, fontSize: 15, lineHeight: 22 },
  panelLabel: {
    color: colors.text3,
    fontFamily: fonts.mono,
    fontSize: 11.5,
    letterSpacing: 1.6,
    marginTop: 4,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { color: colors.white, fontSize: 13.5 },
  source: { gap: 4 },
  sourceTitle: {
    color: colors.white,
    fontSize: 14.5,
    textDecorationLine: "underline",
    textDecorationColor: colors.blue,
  },
  sourceLines: {
    color: colors.text3,
    fontFamily: fonts.mono,
    fontSize: 11.5,
    textDecorationLine: "none",
  },
  quote: { color: colors.text2, fontSize: 13, lineHeight: 19 },
  backTo: {
    alignSelf: "flex-start",
    marginTop: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  backToText: { color: colors.white, fontSize: 14, fontWeight: "600" },
});

import { contents, KIND_LABEL, timelineKey } from "@notestack/shared/report";
import type { Citation, FlashcardData, MindNode, ReportBlock, ReportSuggestion } from "@notestack/shared/types";
import * as WebBrowser from "expo-web-browser";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { useAnimatedReaction, useAnimatedScrollHandler, useAnimatedStyle, useDerivedValue, useSharedValue } from "react-native-reanimated";
import Svg, { Line } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";

import { FlashcardDeck } from "@/artifacts/flashcards";
import { ChevronIcon } from "@/ui/icons";
import { InfographicFrame } from "@/artifacts/infographic";
import { Markdown } from "@/ui/markdown";
import { MindMapExplorer, MindMapScreen } from "@/artifacts/mind-map";
import { QuizRunner, useQuiz } from "@/artifacts/quiz";
import { colors, fonts, gutter, radius } from "@/ui/theme";
import { PillButton } from "@/ui/widgets";

import { ReportPlot } from "./plot";

/** What the owner can do to a report: add a suggested visual, or remove one (web: ReportEditor). */
export type ReportEditor = {
  onAdd: (s: ReportSuggestion) => void;
  onRemove: (blockId: string) => void;
  /** The suggestions being built right now, by id, with what each job is doing. */
  adding?: Record<string, { message?: string | null }>;
  /** The block being removed right now. */
  removing?: string | null;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

function Heading({ children }: { children: string }) {
  return (
    <Text style={styles.h} accessibilityRole="header">
      {children}
    </Text>
  );
}

function MindMapBlock({ block, artifactId }: { block: Extract<ReportBlock, { type: "mind_map" }>; artifactId: string }) {
  const [open, setOpen] = useState(false);
  // The map's own tree, seeded by the report and the block, as the web.
  const map = useMemo(() => ({ id: `${artifactId}:${block.id}`, title: block.title ?? "Mind Constellation", root: block.root as MindNode }), [artifactId, block]);
  return (
    <View style={styles.block}>
      <MindMapExplorer map={map} embedded warp={false} onExpand={() => setOpen(true)} />
      <Text style={styles.hint}>Tap the map to open it full screen, then pinch, drag and tap a star to read it.</Text>
      <MindMapScreen map={map} visible={open} onClose={() => setOpen(false)} />
    </View>
  );
}

function QuizBlock({ block }: { block: Extract<ReportBlock, { type: "quiz" }> }) {
  const state = useQuiz(block.questions);
  return (
    <View style={styles.block}>
      <Heading>{block.title || "Test yourself"}</Heading>
      <QuizRunner questions={block.questions} state={state} />
    </View>
  );
}

function InfographicBlock({ block }: { block: Extract<ReportBlock, { type: "infographic" }> }) {
  const [width, setWidth] = useState(0);
  const html = block.html_landscape || block.html;
  return (
    <View style={styles.block}>
      {block.title ? <Heading>{block.title}</Heading> : null}
      {html ? (
        <View style={styles.frame} onLayout={(e) => setWidth(e.nativeEvent.layout.width - 2)}>
          {width > 0 ? <InfographicFrame html={html} width={width} layout={block.html_landscape ? "landscape" : "portrait"} /> : null}
        </View>
      ) : block.status === "failed" || block.status === "missing" ? (
        <Text style={styles.muted}>{block.status === "missing" ? "This infographic was deleted." : "This infographic could not be made."}</Text>
      ) : (
        <View style={styles.building}>
          <ActivityIndicator size="small" color={colors.blue} />
          <Text style={styles.muted}>Writing the infographic...</Text>
        </View>
      )}
    </View>
  );
}

function TimelineBlock({ block }: { block: Extract<ReportBlock, { type: "timeline" }> }) {
  const supplied = block.title?.trim();
  const title = !supplied || /^(source\s+)?timeline$/i.test(supplied) ? "Timeline" : supplied;
  return (
    <View style={[styles.block, styles.panel]}>
      <View style={styles.panelHead}>
        <View style={styles.panelHeadText}>
          <Text style={styles.panelEyebrow}>● VERIFIED SOURCE CHRONOLOGY</Text>
          <Heading>{title}</Heading>
          <Text style={styles.muted}>
            {block.events.length} verified milestone{block.events.length === 1 ? "" : "s"}
          </Text>
        </View>
        <Text style={styles.kind}>Timeline</Text>
      </View>
      <View style={styles.timeline}>
        {block.events.map((event, i) => {
          // A year used as both the label and the date shows once.
          const showTitle = timelineKey(event.title) !== timelineKey(event.when) || !event.detail;
          return (
            <View key={`${event.when}-${event.title}-${i}`} style={styles.event}>
              <View style={styles.tlRail}>
                <View style={styles.tlNode} />
                {i < block.events.length - 1 ? <View style={styles.railLine} /> : null}
              </View>
              <View style={styles.eventBody}>
                <Text style={styles.when}>{event.when}</Text>
                <View style={styles.eventCard}>
                  {showTitle ? <Text style={styles.eventTitle}>{event.title}</Text> : null}
                  {event.detail ? <Text style={styles.body}>{event.detail}</Text> : null}
                </View>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function Block({ block, citations, artifactId, onCite }: { block: ReportBlock; citations: Citation[]; artifactId: string; onCite: (c: Citation) => void }) {
  switch (block.type) {
    case "prose":
      return <Markdown text={block.text} citations={citations} onCite={onCite} reportHeadings />;
    case "callout":
      return (
        <View style={styles.callout}>
          {block.title ? <Text style={styles.calloutTitle}>{block.title}</Text> : null}
          <Text style={styles.body}>{block.text}</Text>
        </View>
      );
    case "key_terms":
      return (
        <View style={styles.block}>
          <Heading>{block.title || "Key terms"}</Heading>
          {block.terms.map((t) => (
            <View key={t.term} style={styles.term}>
              <Text style={styles.termName}>{t.term}</Text>
              <Text style={styles.body}>{t.definition}</Text>
            </View>
          ))}
        </View>
      );
    case "table":
      return (
        <View style={styles.block}>
          {block.title ? <Heading>{block.title}</Heading> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.table}>
              <View style={[styles.tr, styles.th]}>
                {block.headers.map((h, i) => (
                  <Text key={i} style={[styles.td, styles.thText]}>
                    {h}
                  </Text>
                ))}
              </View>
              {block.rows.map((r, i) => (
                <View key={i} style={styles.tr}>
                  {r.map((c, j) => (
                    <Text key={j} style={styles.td}>
                      {c}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      );
    case "timeline":
      return <TimelineBlock block={block} />;
    case "plot":
      return <ReportPlot block={block} />;
    case "mind_map":
      return <MindMapBlock block={block} artifactId={artifactId} />;
    case "flashcards":
      return (
        <View style={styles.block}>
          <Heading>{block.title || "Flashcards"}</Heading>
          <FlashcardDeck cards={block.cards as FlashcardData[]} />
        </View>
      );
    case "quiz":
      return <QuizBlock block={block} />;
    case "infographic":
      return <InfographicBlock block={block} />;
    default:
      return null;
  }
}

type SourceRow = { title: string; url?: string | null; document_id?: string };

/** What the report was made from, folded away at its end: the prompt, each post once (a link when it has an address),
 * and how many chats (web: SourcesSection). */
function SourcesSection({ content, onCite }: { content: Record<string, any>; onCite: (c: Citation) => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rows = (content.sources ?? []) as SourceRow[];
  const chats = Number(content.chat_count ?? content.source?.chat_ids?.length ?? 0);
  const prompt = typeof content.instructions === "string" ? content.instructions.trim() : "";
  const cites = (content.citations ?? []) as Citation[];
  if (!rows.length && !chats) return null;
  const citedBy = (r: SourceRow) => cites.filter((c) => (r.document_id ? c.document_id === r.document_id : c.title === r.title));
  const needle = filter.trim().toLowerCase();
  const shown = needle ? rows.filter((r) => r.title.toLowerCase().includes(needle)) : rows;
  const label = `${prompt ? "View prompt and " : "View "}${rows.length} source${rows.length === 1 ? "" : "s"}${chats > 0 ? ` and ${chats} chat${chats === 1 ? "" : "s"}` : ""}`;
  return (
    <View style={styles.sources}>
      <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={[styles.toggle, open && styles.toggleOpen]}>
        <Text style={styles.toggleText}>{label}</Text>
        <View style={open && styles.flip}>
          <ChevronIcon size={14} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.sourcesPanel}>
          {prompt ? (
            <View style={styles.gap6}>
              <Text style={styles.sub}>PROMPT</Text>
              <Text style={styles.body}>{prompt}</Text>
            </View>
          ) : null}
          <View style={styles.gap6}>
            <Text style={styles.sub}>SOURCES · {rows.length}</Text>
            {rows.length > 8 ? (
              <TextInput style={styles.filter} value={filter} onChangeText={setFilter} placeholder="Filter sources" placeholderTextColor={colors.text3} accessibilityLabel="Filter sources" />
            ) : null}
            {shown.map((r) => (
              <View key={r.document_id ?? r.title} style={styles.srcRow}>
                <Text style={styles.srcN}>{pad2(rows.indexOf(r) + 1)}</Text>
                <Text
                  style={[styles.srcTitle, r.url && styles.srcLink]}
                  onPress={r.url ? () => void WebBrowser.openBrowserAsync(r.url!, { controlsColor: colors.blue }) : undefined}
                  accessibilityRole={r.url ? "link" : undefined}>
                  {r.title}
                  {r.url ? " ↗" : ""}
                </Text>
                {citedBy(r).map((c) => (
                  <Pressable key={c.marker} onPress={() => onCite(c)} accessibilityRole="button" style={styles.num}>
                    <Text style={styles.numText}>{c.marker}</Text>
                  </Pressable>
                ))}
              </View>
            ))}
            {chats > 0 && !needle ? (
              <View style={styles.srcRow}>
                <Text style={styles.srcN}>+</Text>
                <Text style={styles.srcTitle}>
                  {chats} notebook chat{chats === 1 ? "" : "s"}
                </Text>
              </View>
            ) : null}
            {shown.length === 0 ? <Text style={styles.muted}>No source matches &quot;{filter}&quot;.</Text> : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** The rail beside the report: dashes, as the web's repeating gradient. */
function Dashes({ height }: { height: number }) {
  return (
    <Svg width={2} height={height} style={StyleSheet.absoluteFill}>
      <Line x1={1} y1={0} x2={1} y2={height} stroke={colors.lineStrong} strokeWidth={2} strokeDasharray="6 6" />
    </Svg>
  );
}

/**
 * A report's blocks, in order, as the web's report page on a phone (web: ReportView): the page's own head first, then
 * the blocks beside a rail that fills as the reader goes down, with a ship at where they are; each section opens with
 * its waypoint, lit once it is reached.
 */
export function ReportView({ content, artifactId, onCite, editor, header }: {
  content: Record<string, any>;
  artifactId: string;
  onCite: (c: Citation) => void;
  editor?: ReportEditor;
  /** The page's head (back, title, actions), scrolled with the report as on the web. */
  header?: ReactNode;
}) {
  const blocks = useMemo(() => (content.blocks ?? []) as ReportBlock[], [content.blocks]);
  const suggestions = (content.suggestions ?? []) as ReportSuggestion[];
  const citations = (content.citations ?? []) as Citation[];
  const hasSources = ((content.sources ?? []) as unknown[]).length > 0 || Number(content.chat_count ?? content.source?.chat_ids?.length ?? 0) > 0;
  const toc = useMemo(() => contents(blocks, hasSources), [blocks, hasSources]);
  const tops = useRef(new Map<string, number>());
  const [railH, setRailH] = useState(0);
  const [active, setActive] = useState(-1);
  const stop = (id: string) => toc.findIndex((t) => t.id === id);

  // The rail follows the scroll on the UI thread, every frame: the fill and the ship never step or trail.
  const scrollY = useSharedValue(0);
  const viewH = useSharedValue(0);
  const artY = useSharedValue(0);
  const artH = useSharedValue(0);
  const stops = useSharedValue<number[]>([]); // where each waypoint starts, in the article
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.set(e.contentOffset.y);
    viewH.set(e.layoutMeasurement.height);
  });
  // As the web: how far down the report the reader is, measured a little under the top of the screen.
  const progress = useDerivedValue(() => {
    const vh = viewH.get();
    const top = artY.get() - scrollY.get();
    return Math.max(0, Math.min(1, (vh * 0.45 - top) / Math.max(artH.get() - vh * 0.4, 1)));
  });
  const fill = useAnimatedStyle(() => ({ height: progress.get() * Math.max(artH.get() - 6, 0) }));
  const ship = useAnimatedStyle(() => ({ transform: [{ translateY: progress.get() * Math.max(artH.get() - 6, 0) }] }));
  // The last waypoint whose start has passed that line is reached; only a change reaches React.
  useAnimatedReaction(
    () => {
      const line = scrollY.get() + viewH.get() * 0.45 - artY.get();
      let now = -1;
      stops.get().forEach((y, i) => {
        if (y >= 0 && y <= line) now = i;
      });
      return now;
    },
    (now, before) => {
      if (now !== before) scheduleOnRN(setActive, now);
    },
  );
  const placeStop = (id: string, y: number) => {
    tops.current.set(id, y);
    stops.set(toc.map((t) => tops.current.get(t.id) ?? -1));
  };

  return (
    <Animated.ScrollView style={styles.fill} contentContainerStyle={styles.page} scrollEventThrottle={16} keyboardShouldPersistTaps="handled" onScroll={onScroll}>
      {header}
      <View
        style={styles.article}
        onLayout={(e) => {
          artY.set(e.nativeEvent.layout.y);
          artH.set(e.nativeEvent.layout.height);
          setRailH(Math.max(e.nativeEvent.layout.height - 6, 0));
        }}>
        {blocks.map((b) => {
          const n = stop(b.id);
          const reached = n >= 0 && n <= active;
          return (
            <View key={b.id} style={[styles.slot, n >= 0 && styles.stop]} onLayout={(e) => placeStop(b.id, e.nativeEvent.layout.y)}>
              {n >= 0 ? (
                <>
                  <View style={[styles.node, reached && styles.nodeReached]} />
                  <Text style={[styles.waypointLabel, reached && styles.waypointReached]}>WAYPOINT {pad2(n + 1)}</Text>
                </>
              ) : null}
              <Block block={b} citations={citations} artifactId={artifactId} onCite={onCite} />
              {editor && b.type !== "prose" ? (
                <Pressable onPress={() => editor.onRemove(b.id)} disabled={!!editor.removing} accessibilityRole="button" style={styles.remove}>
                  {editor.removing === b.id ? (
                    <View style={styles.building}>
                      <ActivityIndicator size="small" color={colors.text2} />
                      <Text style={styles.removeText}>Removing...</Text>
                    </View>
                  ) : (
                    <Text style={styles.removeText}>Remove this {KIND_LABEL[b.type as keyof typeof KIND_LABEL]?.toLowerCase() ?? "visual"}</Text>
                  )}
                </Pressable>
              ) : null}
              {editor
                ? suggestions
                    .filter((s) => s.after_block_id === b.id)
                    .map((s) => {
                      const progressNow = editor.adding?.[s.id];
                      return (
                        <View key={s.id} style={[styles.suggestion, progressNow && styles.suggestionBuilding]}>
                          <View style={styles.gap6}>
                            <Text style={styles.suggestionTitle}>Suggested: {KIND_LABEL[s.kind]}</Text>
                            <Text style={styles.muted}>{s.brief}</Text>
                            {!progressNow && s.why ? <Text style={[styles.muted, styles.small]}>{s.why}</Text> : null}
                          </View>
                          {progressNow ? (
                            <View style={styles.building}>
                              <ActivityIndicator size="small" color={colors.blue} />
                              <Text style={styles.muted}>{progressNow.message || `Building the ${KIND_LABEL[s.kind].toLowerCase()}...`}</Text>
                            </View>
                          ) : (
                            <PillButton small title="Add" onPress={() => editor.onAdd(s)} />
                          )}
                        </View>
                      );
                    })
                : null}
            </View>
          );
        })}
        <View onLayout={(e) => placeStop("sources", e.nativeEvent.layout.y)}>
          <SourcesSection content={content} onCite={onCite} />
        </View>
        {/* Last, so the ship passes over the waypoints' nodes, never under them */}
        <View style={styles.rail} pointerEvents="none">
          {railH > 0 ? <Dashes height={railH} /> : null}
          <Animated.View style={[styles.railFill, fill]} />
          <Animated.View style={[styles.ship, ship]} />
        </View>
      </View>
    </Animated.ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  page: { paddingHorizontal: gutter * 1.25, paddingBottom: gutter * 4 },
  // The blocks beside the rail (web: .rp, .rp-path, .rp-node)
  article: { position: "relative", paddingLeft: 40, paddingTop: 6 },
  rail: { position: "absolute", left: 11, top: 6, bottom: 0, width: 2, zIndex: 10, elevation: 10 },
  railFill: { width: 2, backgroundColor: colors.blue, shadowColor: colors.blue, shadowOpacity: 0.8, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
  ship: {
    position: "absolute",
    left: -6,
    width: 14,
    height: 14,
    top: -7,
    borderRadius: 7,
    backgroundColor: colors.white,
    shadowColor: colors.white,
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  slot: { gap: 20, marginBottom: 22 },
  stop: { marginBottom: 24 },
  node: { position: "absolute", left: -36, top: 0, width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: colors.lineStrong, backgroundColor: colors.black, zIndex: 3 },
  nodeReached: { borderColor: colors.blue, backgroundColor: colors.blue, shadowColor: colors.blue, shadowOpacity: 0.9, shadowRadius: 7, shadowOffset: { width: 0, height: 0 } },
  waypointLabel: { color: colors.text3, fontFamily: fonts.mono, fontSize: 11.5, letterSpacing: 1.9, marginTop: 1 },
  waypointReached: { color: colors.blue },
  block: { gap: 12 },
  h: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 20, lineHeight: 26 },
  body: { color: colors.text, fontSize: 15.5, lineHeight: 23 },
  muted: { color: colors.text2, fontSize: 14.5, lineHeight: 21 },
  small: { fontSize: 13 },
  hint: { color: colors.text3, fontSize: 12.5 },
  gap6: { gap: 6 },
  callout: { gap: 6, padding: 14, borderRadius: radius.sm + 2, borderLeftWidth: 3, borderLeftColor: colors.blue, backgroundColor: colors.blue10 },
  calloutTitle: { color: colors.white, fontSize: 15.5, fontWeight: "700" },
  term: { gap: 3, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  termName: { color: colors.white, fontSize: 15.5, fontWeight: "700" },
  table: { borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  tr: { flexDirection: "row" },
  th: { backgroundColor: colors.surface2 },
  td: { width: 170, padding: 10, color: colors.text, fontSize: 13.5, lineHeight: 19, borderBottomWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  thText: { fontWeight: "700" },
  panel: { padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: "rgba(33, 124, 255, 0.25)", backgroundColor: "rgba(33, 124, 255, 0.04)" },
  panelHead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  panelHeadText: { flex: 1, gap: 4 },
  panelEyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.6 },
  kind: { color: colors.text2, fontFamily: fonts.mono, fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  timeline: { gap: 0 },
  event: { flexDirection: "row", gap: 12 },
  tlRail: { width: 12, alignItems: "center" },
  tlNode: { width: 10, height: 10, borderRadius: 5, marginTop: 4, backgroundColor: colors.blue, borderWidth: 2, borderColor: "#9cc2ff" },
  railLine: { flex: 1, width: 2, backgroundColor: "rgba(33, 124, 255, 0.35)" },
  eventBody: { flex: 1, gap: 6, paddingBottom: 16 },
  when: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5 },
  eventCard: { gap: 4, padding: 12, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  eventTitle: { color: colors.white, fontSize: 15, fontWeight: "700" },
  frame: { borderRadius: radius.sm + 2, overflow: "hidden", borderWidth: 1, borderColor: colors.line },
  building: { flexDirection: "row", alignItems: "center", gap: 8 },
  remove: { alignSelf: "flex-start" },
  removeText: { color: colors.text2, fontSize: 13.5, textDecorationLine: "underline" },
  suggestion: { gap: 12, padding: 14, borderRadius: radius.sm + 2, borderWidth: 1, borderStyle: "dashed", borderColor: "rgba(33, 124, 255, 0.5)" },
  suggestionBuilding: { borderStyle: "solid", backgroundColor: colors.blue10 },
  suggestionTitle: { color: colors.white, fontSize: 15, fontWeight: "700" },
  sources: { gap: 12, marginTop: 6 },
  toggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.lineStrong },
  toggleOpen: { borderColor: "rgba(33, 124, 255, 0.6)" },
  toggleText: { flex: 1, color: colors.white, fontSize: 15, fontWeight: "500" },
  flip: { transform: [{ rotate: "180deg" }] },
  sourcesPanel: { gap: 16 },
  sub: { color: colors.text3, fontFamily: fonts.mono, fontSize: 11.5, letterSpacing: 1.6 },
  filter: { color: colors.text, fontSize: 15, paddingHorizontal: 12, paddingVertical: 9, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface },
  srcRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, flexWrap: "wrap" },
  srcN: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, lineHeight: 21, minWidth: 20 },
  srcTitle: { flex: 1, color: colors.text, fontSize: 14.5, lineHeight: 21 },
  srcLink: { textDecorationLine: "underline", textDecorationColor: colors.blue },
  num: { minWidth: 24, height: 22, paddingHorizontal: 6, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.blue10 },
  numText: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12 },
});

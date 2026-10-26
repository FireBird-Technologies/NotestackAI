import { sourceSummary } from "@notestack/shared/create-options";
import type { Artifact } from "@notestack/shared/types";
import { StatusBar } from "expo-status-bar";
import { type ReactNode, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { SHARE_WHAT, ShareDialog } from "@/card-dialogs";
import { CloseIcon, CollapseIcon, ExpandIcon, LandscapeIcon, PortraitIcon, ShareIcon } from "@/icons";
import { colors, fonts, gutter, radius } from "@/theme";
import { pageStyles } from "@/widgets";

export type Layout = "landscape" | "portrait";
const PAGE = { landscape: { w: 2260, h: 1600 }, portrait: { w: 1600, h: 2260 } };

/** The page's HTML zoomed to `width` points; `zoomable` lets a pinch enlarge it (full screen). No scripts run in it. */
function pageDoc(html: string, width: number, layout: Layout, zoomable: boolean): string {
  const viewport = zoomable ? "width=device-width,initial-scale=1,maximum-scale=6,user-scalable=yes" : "width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no";
  const head = `<meta name="viewport" content="${viewport}"><style>html{zoom:${width / PAGE[layout].w};-webkit-text-size-adjust:100%;text-size-adjust:100%}html,body{overflow:hidden}</style>`;
  return html.includes("<head>") ? html.replace("<head>", `<head>${head}`) : head + html;
}

/** The infographic's page (HTML from our own template, every word escaped), scaled to `width` (web: InfographicFrame). */
export function InfographicFrame({ html, width, layout, zoomable = false }: { html: string; width: number; layout: Layout; zoomable?: boolean }) {
  const source = useMemo(() => ({ html: pageDoc(html, width, layout, zoomable), baseUrl: "about:blank" }), [html, width, layout, zoomable]);
  return (
    <View style={{ width, height: (width * PAGE[layout].h) / PAGE[layout].w }}>
      <WebView
        source={source}
        originWhitelist={["*"]}
        javaScriptEnabled={false}
        onShouldStartLoadWithRequest={(r) => r.url === "about:blank" || r.url.startsWith("data:")}
        scrollEnabled={zoomable}
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        setBuiltInZoomControls={zoomable}
        setDisplayZoomControls={false}
        style={styles.web}
        containerStyle={styles.web}
      />
    </View>
  );
}

/** The landscape page in its card, as a preview that opens the viewer (web: InfographicBody's thumbnail). */
export function InfographicThumb({ artifact, onOpen }: { artifact: Artifact; onOpen: () => void }) {
  const [width, setWidth] = useState(0);
  const html = artifact.content?.html_landscape as string | undefined;
  if (!html) return null;
  return (
    <View style={styles.thumb} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 ? <InfographicFrame html={html} width={width} layout="landscape" /> : null}
      <Pressable style={StyleSheet.absoluteFill} onPress={onOpen} accessibilityRole="button" accessibilityLabel="Open the infographic" />
    </View>
  );
}

/** The page full screen, as large as fits either way up, and pinch to look closer. */
function FullView({ html, layout, onClose }: { html: string; layout: Layout; onClose: () => void }) {
  const win = useWindowDimensions();
  const ratio = PAGE[layout].w / PAGE[layout].h;
  const width = Math.min(win.width, win.height * ratio);
  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" supportedOrientations={["portrait", "landscape"]} onRequestClose={onClose}>
      <SafeAreaProvider>
      <StatusBar hidden />
      <View style={styles.full}>
        <InfographicFrame html={html} width={width} layout={layout} zoomable />
        <SafeAreaView edges={["top", "right"]} style={styles.fullExit} pointerEvents="box-none">
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Exit full screen" style={styles.round}>
            <CollapseIcon size={18} />
          </Pressable>
        </SafeAreaView>
      </View>
    </SafeAreaProvider>
    </Modal>
  );
}

/**
 * One infographic in a popup (web: InfographicViewer): "View prompt" and the page's shape on top; the thumbs and the
 * download on the left of the row under it, share and full screen on its right; then the whole page.
 */
export function InfographicViewer({ artifact, visible, onClose, feedback, download }: {
  artifact: Artifact;
  visible: boolean;
  onClose: () => void;
  /** The card's thumbs and its download menu, as the web viewer shows them. */
  feedback?: ReactNode;
  download?: ReactNode;
}) {
  const [info, setInfo] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [full, setFull] = useState(false);
  const [layout, setLayout] = useState<Layout>("landscape"); // wide to start with; tall is one tap away
  const [width, setWidth] = useState(0);
  const c = artifact.content ?? {};
  const prompt = String(c.prompt ?? "").trim();
  const html = (layout === "landscape" ? c.html_landscape : c.html) as string | undefined;
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={pageStyles.sheet} edges={["top", "bottom"]}>
        <View style={pageStyles.sheetHead}>
          <Text style={[pageStyles.sheetTitle, styles.title]} numberOfLines={2}>
            {artifact.title}
          </Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <CloseIcon size={20} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={pageStyles.sheetBody}>
          <View style={styles.barTop}>
            <Pressable onPress={() => setInfo((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: info }} style={({ pressed }) => [styles.pill, info && styles.pillOn, pressed && styles.pressed]}>
              <Text style={styles.pillText}>View prompt</Text>
            </Pressable>
            <View style={styles.layouts} accessibilityRole="radiogroup" accessibilityLabel="Page shape">
              {(["landscape", "portrait"] as const).map((l) => (
                <Pressable
                  key={l}
                  onPress={() => setLayout(l)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: layout === l }}
                  accessibilityLabel={l === "landscape" ? "Landscape" : "Portrait"}
                  style={[styles.layout, layout === l && styles.layoutOn]}>
                  {l === "landscape" ? <LandscapeIcon size={16} color={layout === l ? colors.white : colors.text2} /> : <PortraitIcon size={16} color={layout === l ? colors.white : colors.text2} />}
                </Pressable>
              ))}
            </View>
          </View>
          <View style={styles.barActions}>
            <View style={styles.group}>
              {feedback}
              {download}
            </View>
            <View style={styles.group}>
              <Pressable onPress={() => setSharing(true)} accessibilityRole="button" accessibilityLabel="Share" style={({ pressed }) => [styles.round, pressed && styles.pressed]}>
                <ShareIcon size={15} />
              </Pressable>
              <Pressable onPress={() => setFull(true)} disabled={!html} accessibilityRole="button" accessibilityLabel="Full screen" style={({ pressed }) => [styles.round, pressed && styles.pressed]}>
                <ExpandIcon size={15} />
              </Pressable>
            </View>
          </View>
          {info ? (
            <View style={styles.info} accessibilityLabel="Prompt and sources">
              <Pressable onPress={() => setInfo(false)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={styles.infoClose}>
                <CloseIcon size={18} color={colors.text2} />
              </Pressable>
              <Text style={styles.eyebrow}>PROMPT</Text>
              <Text style={styles.infoText}>{prompt || "None. It was made from the sources as a whole."}</Text>
              <Text style={styles.eyebrow}>MADE FROM</Text>
              <Text style={styles.infoText}>{sourceSummary(c.source)}</Text>
            </View>
          ) : null}
          <View style={styles.stage} onLayout={(e) => setWidth(e.nativeEvent.layout.width - 2)}>
            {html && width > 0 ? <InfographicFrame key={layout} html={html} width={width} layout={layout} /> : null}
          </View>
        </ScrollView>
      </SafeAreaView>
      {full && html ? <FullView html={html} layout={layout} onClose={() => setFull(false)} /> : null}
      <ShareDialog artifactId={artifact.id} what={SHARE_WHAT.infographic ?? "infographic"} visible={sharing} onClose={() => setSharing(false)} />
    </Modal>
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: "transparent" },
  title: { flex: 1, marginRight: 12 },
  thumb: { borderRadius: radius.sm + 2, overflow: "hidden", borderWidth: 1, borderColor: colors.line },
  barTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  pill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  pillOn: { borderColor: "rgba(33, 124, 255, 0.6)", backgroundColor: colors.blue10 },
  pillText: { color: colors.white, fontSize: 14.5, fontWeight: "600" },
  pressed: { opacity: 0.7 },
  layouts: { flexDirection: "row", padding: 3, gap: 2, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  layout: { width: 36, height: 30, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  layoutOn: { backgroundColor: colors.blue },
  barActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  group: { flexDirection: "row", alignItems: "center", gap: 5 },
  round: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: "rgba(0, 0, 0, 0.5)" },
  infoClose: { position: "absolute", top: 12, right: 12, zIndex: 1, padding: 4 },
  info: { gap: 6, padding: 14, paddingRight: 44, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 2.5 },
  infoText: { color: colors.text, fontSize: 15, lineHeight: 22, marginBottom: 4 },
  stage: { borderRadius: radius.sm + 2, overflow: "hidden", borderWidth: 1, borderColor: colors.line },
  full: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.black },
  fullExit: { position: "absolute", top: 0, right: 0, padding: gutter },
});

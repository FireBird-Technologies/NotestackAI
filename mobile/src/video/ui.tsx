import RNSlider from "@react-native-community/slider";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ChevronIcon } from "@/ui/icons";
import { colors, fonts, radius } from "@/ui/theme";

/* The pieces the video editor's panels share (web: the vw-* styles in styles/videos.css and video/parts.tsx). */

/**
 * Calls `fn` every `intervalMs` until `until(result)` is true (web: hooks/usePoll). Calls never overlap, it pauses
 * while the app is in the background, and it backs off after errors. Change `key` to restart it; a new key reads as a
 * fresh start in the same render.
 */
export function usePoll<T>(
  fn: (() => Promise<T>) | null,
  { intervalMs, until, key }: { intervalMs: number; until: (t: T) => boolean; key?: unknown },
): { data: T | null; error: unknown; done: boolean } {
  const [result, setResult] = useState<{ key: unknown; data: T | null; error: unknown; done: boolean } | null>(null);
  const fnRef = useRef(fn);
  const untilRef = useRef(until);
  useEffect(() => {
    fnRef.current = fn;
    untilRef.current = until;
  });
  const enabled = fn !== null;

  useEffect(() => {
    if (!enabled) return;
    const runKey = key;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      if (stopped) return;
      if (AppState.currentState !== "active") {
        timer = setTimeout(tick, intervalMs);
        return;
      }
      try {
        const next = await fnRef.current!();
        if (stopped) return;
        failures = 0;
        const done = untilRef.current(next);
        setResult({ key: runKey, data: next, error: null, done });
        if (done) return;
      } catch (e) {
        if (stopped) return;
        failures += 1;
        setResult((r) => ({ key: runKey, data: r !== null && r.key === runKey ? r.data : null, error: e, done: false }));
      }
      timer = setTimeout(tick, intervalMs * Math.min(2 ** failures, 8));
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, intervalMs, key]);

  const mine = enabled && result !== null && result.key === key ? result : null;
  return { data: mine?.data ?? null, error: mine?.error ?? null, done: mine?.done ?? false };
}

/** The web's thin range input: blue up to the handle. */
export function Slider({ value, min, max, step = 1, disabled, onChange, label }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  label: string;
}) {
  return (
    <RNSlider
      value={value}
      minimumValue={min}
      maximumValue={max}
      step={step}
      disabled={disabled}
      onValueChange={(v) => onChange(Math.round(v / step) * step)}
      minimumTrackTintColor={colors.blue}
      maximumTrackTintColor={colors.lineStrong}
      thumbTintColor={colors.white}
      accessibilityLabel={label}
      style={[styles.slider, disabled && styles.off]}
    />
  );
}

/** A clip, muted and looping (web: a <video muted loop>): still until `playing`, its first frame showing. */
export function ClipView({ uri, playing, style }: { uri: string; playing: boolean; style?: object }) {
  const player = useVideoPlayer(uri, (p) => {
    p.muted = true;
    p.loop = true;
  });
  useEffect(() => {
    if (playing) player.play();
    else player.pause();
  }, [playing, player]);
  return <VideoView player={player} style={[styles.fill, style]} contentFit="cover" nativeControls={false} />;
}

/** One image or clip in a tile: a clip plays while it is tapped on (the web's hover). */
export function MediaThumb({ uri, kind, poster, style }: { uri: string; kind: string; poster?: string; style?: object }) {
  const [playing, setPlaying] = useState(false);
  if (kind !== "video") return <Image source={{ uri }} style={[styles.fill, style]} contentFit="cover" />;
  return (
    <Pressable style={[styles.fill, style]} onPress={() => setPlaying((p) => !p)} accessibilityRole="button" accessibilityLabel={playing ? "Pause the clip" : "Play the clip"}>
      {playing || !poster ? <ClipView uri={uri} playing={playing} /> : <Image source={{ uri: poster }} style={styles.fill} contentFit="cover" />}
    </Pressable>
  );
}

/** The editor's tab row: pills that share the row, and scroll sideways if they must (web: Tabs on a phone). */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
      {tabs.map((t) => (
        <Pressable key={t.id} onPress={() => onChange(t.id)} accessibilityRole="tab" accessibilityState={{ selected: value === t.id }} style={[styles.tab, value === t.id && styles.tabOn]}>
          <Text style={[styles.tabText, value === t.id && styles.tabTextOn]}>{t.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** "Scenes 1–5", a group of five that opens on a tap (web: .vw-group-head). */
export function GroupHead({ label, open, onPress, note }: { label: string; open: boolean; onPress: () => void; note?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.groupHead}>
      <Text style={styles.groupLabel}>
        {label}
        {note && !open ? <Text style={styles.muted}> · {note}</Text> : null}
      </Text>
      <View style={open && styles.flip}>
        <ChevronIcon size={16} />
      </View>
    </Pressable>
  );
}

/** A scene's number in a round badge. */
export function NumBadge({ n }: { n: number }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{n}</Text>
    </View>
  );
}

/** A small label: grey, or green once done ("Scene", "Audio"). */
export function StatePill({ label, ok }: { label: string; ok: boolean }) {
  return <Text style={[styles.pill, ok && styles.pillOk]}>{label}</Text>;
}

export function Spinner() {
  return <ActivityIndicator size="small" color={colors.blue} />;
}

/** The web's .vw-label: a small grey caps label over a field. */
export function Label({ children }: { children: ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

/** Groups of five, in order: what the scene lists, images and voiceovers page through. */
export function inFives<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += 5) out.push(list.slice(i, i + 5));
  return out;
}

export const clock = (seconds: number) => {
  const t = Math.max(0, Math.round(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

export const vstyles = StyleSheet.create({
  card: { gap: 12, padding: 16, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(12, 12, 14, 0.92)" },
  h2: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 22, lineHeight: 28 },
  h3: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 18, lineHeight: 24 },
  body: { color: colors.text, fontSize: 15, lineHeight: 22 },
  muted: { color: colors.text2, fontSize: 14, lineHeight: 20 },
  small: { fontSize: 13, lineHeight: 18 },
  strong: { color: colors.text, fontWeight: "700" },
  mono: { fontFamily: fonts.mono },
  accent: { color: colors.blue, fontWeight: "700" },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  end: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8, flexWrap: "wrap" },
  input: {
    color: colors.text,
    fontSize: 15.5,
    lineHeight: 21,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  area: { minHeight: 96, textAlignVertical: "top" },
  stack: { gap: 12 },
});

const styles = StyleSheet.create({
  fill: { width: "100%", height: "100%", backgroundColor: "#111" },
  slider: { width: "100%", height: 36 },
  off: { opacity: 0.4 },
  tabs: { gap: 6, padding: 4, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  tabOn: { backgroundColor: colors.blue },
  tabText: { color: colors.text2, fontSize: 14, fontWeight: "600" },
  tabTextOn: { color: colors.white },
  groupHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  groupLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  muted: { color: colors.text3, fontWeight: "400", fontSize: 13 },
  flip: { transform: [{ rotate: "180deg" }] },
  badge: { minWidth: 26, height: 26, paddingHorizontal: 6, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: colors.blue10, borderWidth: 1, borderColor: "rgba(33, 124, 255, 0.4)" },
  badgeText: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5 },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden", borderWidth: 1, borderColor: colors.line, color: colors.text3, fontSize: 11.5 },
  pillOk: { borderColor: "rgba(60, 200, 120, 0.45)", color: "#5fe0a0" },
  label: { color: colors.text3, fontFamily: fonts.mono, fontSize: 11.5, letterSpacing: 1.4, textTransform: "uppercase" },
});

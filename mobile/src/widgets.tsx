import type { Job } from "@notestack/shared/types";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, fonts, radius } from "@/theme";

/** A status word in a pill, coloured by tone as the web's StatusPill: ok, bad, warn or busy. */
export function StatusPill({ status }: { status: string }) {
  const tone = ["ready", "ok", "done", "posted", "reminded", "connected"].includes(status)
    ? "ok"
    : ["failed", "error"].includes(status)
      ? "bad"
      : ["paused", "expired", "revoked", "disconnected"].includes(status)
        ? "warn"
        : "busy";
  return (
    <View style={[styles.pill, styles[tone]]}>
      <Text style={[styles.pillText, { color: TONE_TEXT[tone] }]}>{status.toUpperCase()}</Text>
    </View>
  );
}

const TONE_TEXT = { ok: colors.text, bad: colors.danger, warn: "#f5b041", busy: colors.blue };

/** A running job's progress: a thin bar, its message and the percent, or the error when it failed (web JobProgress). */
export function JobProgress({ job }: { job: Job }) {
  const pct = Math.round((job.status === "done" ? 1 : job.progress) * 100);
  const failed = job.status === "failed";
  const label = failed
    ? (job.error ?? "Failed")
    : job.status === "queued"
      ? (job.message ?? "Queued for launch")
      : (job.message ?? "Working");
  return (
    <View
      style={styles.progress}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: pct }}>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${failed ? 100 : pct}%` }, failed && styles.fillFailed]} />
      </View>
      <View style={styles.progressMeta}>
        <Text style={[styles.mono, failed && styles.failedText]} numberOfLines={2}>
          {label}
        </Text>
        {!failed ? <Text style={styles.mono}>{pct}%</Text> : null}
      </View>
    </View>
  );
}

/** Previous and next page buttons around "Page n of m" (web Pager). Hidden when there is only one page. */
export function Pager({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  if (pages <= 1) return null;
  const arrow = (dir: -1 | 1) => {
    const disabled = dir < 0 ? page <= 0 : page >= pages - 1;
    return (
      <Pressable
        onPress={() => onChange(page + dir)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={dir < 0 ? "Previous page" : "Next page"}
        style={[styles.pageButton, disabled && styles.off]}>
        <SymbolView
          name={{ ios: dir < 0 ? "chevron.left" : "chevron.right", android: dir < 0 ? "chevron_left" : "chevron_right" }}
          size={15}
          tintColor={colors.text}
          weight="semibold"
        />
      </Pressable>
    );
  };
  return (
    <View style={styles.pager}>
      {arrow(-1)}
      <Text style={styles.mono}>
        Page {page + 1} of {pages}
      </Text>
      {arrow(1)}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, borderWidth: 1 },
  ok: { borderColor: "rgba(33, 124, 255, 0.6)", backgroundColor: colors.blue10 },
  bad: { borderColor: "rgba(255, 107, 107, 0.6)", backgroundColor: "rgba(255, 107, 107, 0.08)" },
  warn: { borderColor: "rgba(245, 176, 65, 0.6)", backgroundColor: "rgba(245, 176, 65, 0.08)" },
  busy: { borderColor: "rgba(33, 124, 255, 0.4)", backgroundColor: "transparent" },
  pillText: { fontFamily: fonts.mono, fontSize: 12, letterSpacing: 0.5 },
  progress: { gap: 6 },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2, backgroundColor: colors.blue },
  fillFailed: { backgroundColor: colors.danger },
  progressMeta: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  mono: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5, flexShrink: 1 },
  failedText: { color: colors.danger },
  pager: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 18, paddingTop: 12 },
  pageButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  off: { opacity: 0.35 },
});

/** Radius shared by the cards on the signed-in pages. */
export const CARD_RADIUS = radius.md + 2;

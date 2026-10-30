import type { Job } from "@notestack/shared/types";
import { SymbolView } from "expo-symbols";
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import { Pressable } from "@/ui/pressable";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import { Starfield } from "@/shell/starfield";
import { colors, fonts, gutter, radius } from "@/ui/theme";

/** The busy pill breathes, as the web's (pill-pulse). */
const pulse = { "0%": { opacity: 1 }, "50%": { opacity: 0.5 }, "100%": { opacity: 1 } };

/** A status word in a pill, coloured by tone as the web's StatusPill: ok, bad, warn or busy (dashed, pulsing). */
export function StatusPill({ status }: { status: string }) {
  const tone = ["ready", "ok", "done", "posted", "reminded", "connected"].includes(status)
    ? "ok"
    : ["failed", "error"].includes(status)
      ? "bad"
      : ["paused", "expired", "revoked", "disconnected"].includes(status)
        ? "warn"
        : "busy";
  return (
    <Animated.View
      style={[
        styles.pill,
        styles[tone],
        tone === "busy" && { animationName: pulse, animationDuration: "1.6s", animationTimingFunction: "ease-in-out", animationIterationCount: "infinite" },
      ]}>
      <Text style={[styles.pillText, { color: TONE_TEXT[tone] }]}>{status.toUpperCase()}</Text>
    </Animated.View>
  );
}

const TONE_TEXT = { ok: colors.white, bad: colors.black, warn: "#ffd257", busy: colors.text2 };

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
        <View style={[styles.fill, { width: `${failed ? 100 : Math.max(pct, 2)}%` }, failed && styles.fillFailed]}>
          {!failed ? <View style={styles.head} /> : null}
        </View>
      </View>
      <View style={styles.progressMeta}>
        <Text style={[styles.progressText, styles.progressLabel, failed && styles.failedText]} numberOfLines={2}>
          {label}
        </Text>
        {!failed ? <Text style={styles.progressText}>{pct}%</Text> : null}
      </View>
    </View>
  );
}

/**
 * The progress bar's look while there is no progress to show yet (something just asked for): the glowing fill and its
 * head sweep along the track, over and over. `label` sits under it, as JobProgress's message does.
 */
export function FlowBar({ label }: { label: string }) {
  const [trackW, setTrackW] = useState(0);
  const at = useSharedValue(0);
  useEffect(() => {
    at.set(withRepeat(withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.quad) }), -1, false));
  }, [at]);
  const comet = useAnimatedStyle(() => ({ transform: [{ translateX: -trackW * 0.35 + at.get() * trackW * 1.35 }] }));
  return (
    <View style={styles.progress} accessibilityRole="progressbar" accessibilityLabel={label}>
      <View style={[styles.track, styles.trackClip]} onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}>
        <Animated.View style={[styles.fill, styles.comet, comet]}>
          <View style={styles.head} />
        </Animated.View>
      </View>
      <Text style={[styles.progressText, styles.progressLabel]} numberOfLines={2}>
        {label}
      </Text>
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
  pill: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  ok: { borderColor: "rgba(33, 124, 255, 0.6)", backgroundColor: colors.blue10 },
  bad: { borderColor: colors.white, backgroundColor: colors.white },
  warn: { borderColor: "rgba(255, 196, 0, 0.55)", backgroundColor: "rgba(255, 196, 0, 0.12)" },
  busy: { borderColor: colors.lineStrong, borderStyle: "dashed", backgroundColor: "transparent" },
  pillText: { fontFamily: fonts.mono, fontSize: 11.5, letterSpacing: 0.6 },
  progress: { gap: 8 },
  // The web's "ascent": a blue trail that brightens to a glowing white head.
  track: { height: 6, borderRadius: 3, backgroundColor: colors.surface2 },
  fill: {
    height: 6,
    borderRadius: 3,
    backgroundImage: "linear-gradient(90deg, rgba(33, 124, 255, 0.1), #217cff)",
    boxShadow: "0 0 12px rgba(33, 124, 255, 0.6)",
  },
  trackClip: { overflow: "hidden" },
  comet: { position: "absolute", left: 0, top: 0, width: "35%" },
  fillFailed: { backgroundImage: "none", backgroundColor: colors.white, boxShadow: "none", opacity: 0.6 },
  // A small bright block the track's height (the web's dot, clipped by its track to a rectangle).
  head: {
    position: "absolute",
    right: 0,
    top: 0,
    width: 9,
    height: 6,
    borderRadius: 1.5,
    backgroundColor: colors.white,
    boxShadow: "0 0 10px #ffffff, 0 0 18px #217cff",
  },
  progressMeta: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  progressText: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 },
  progressLabel: { flex: 1 },
  mono: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5, flexShrink: 1 },
  failedText: { color: colors.white },
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

/** A page sheet over the screen (the web's modals): a title, a close button and a scrolling body. `onDismissed` runs
 * once it has finished sliding away (iOS), the moment the screen behind it may change. */
export function Sheet({ visible, title, onClose, onDismissed, children }: { visible: boolean; title: string; onClose: () => void; onDismissed?: () => void; children: ReactNode }) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose} onDismiss={onDismissed}>
      <SafeAreaView style={pageStyles.sheet} edges={["top", "bottom"]}>
        <View style={pageStyles.sheetHead}>
          <Text style={pageStyles.sheetTitle}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <SymbolView name={{ ios: "xmark", android: "close" }} size={18} tintColor={colors.text} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={pageStyles.sheetBody} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/** A small window in the middle of the screen (the web's Modal on a phone): a title, a close button and its body. */
export function Dialog({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable silent style={pageStyles.dialogBackdrop} onPress={onClose}>
        <Pressable silent style={pageStyles.dialog} onPress={() => {}}>
          <View style={pageStyles.dialogHead}>
            <Text style={pageStyles.sheetTitle}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <SymbolView name={{ ios: "xmark", android: "close" }} size={17} tintColor={colors.text2} />
            </Pressable>
          </View>
          <View style={pageStyles.dialogBody}>{children}</View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** A signed-in page: the night sky behind a scrolling column (as Sources and Library). */
export function Page({ children, refresh }: { children: ReactNode; refresh?: React.ReactElement }) {
  return (
    <View style={pageStyles.fill}>
      <Starfield />
      <ScrollView contentContainerStyle={pageStyles.column} keyboardShouldPersistTaps="handled" refreshControl={refresh}>
        {children}
      </ScrollView>
    </View>
  );
}

/** The web's PageHeader: a blue mono eyebrow over the page title, with optional actions under it. */
export function PageHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <View style={pageStyles.head}>
      <Text style={pageStyles.eyebrow}>{eyebrow}</Text>
      <Text style={pageStyles.title} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

/** A dark card; `title` adds its heading, `aside` sits at the heading's right (a "Saved" note, a count). */
export function Section({
  title,
  kicker,
  aside,
  children,
  style,
}: {
  title?: string;
  kicker?: string;
  aside?: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[pageStyles.card, style]}>
      {kicker ? <Text style={pageStyles.kicker}>{kicker}</Text> : null}
      {title ? (
        <View style={pageStyles.cardHead}>
          <Text style={pageStyles.cardTitle}>{title}</Text>
          {aside}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** A rounded pill button as the web's .btn: outline by default, primary (blue) or danger. */
export function PillButton({
  title,
  onPress,
  variant = "outline",
  busy,
  disabled,
  small,
  icon,
}: {
  title: string;
  onPress: () => void;
  variant?: "outline" | "primary" | "danger";
  busy?: boolean;
  disabled?: boolean;
  small?: boolean;
  icon?: ReactNode;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      style={({ pressed }) => [
        pageStyles.pill,
        small && pageStyles.pillSmall,
        variant === "primary" && pageStyles.pillPrimary,
        variant === "danger" && pageStyles.pillDanger,
        off && pageStyles.pillOff,
        pressed && pageStyles.pressed,
      ]}>
      {busy ? <ActivityIndicator size="small" color={colors.white} /> : icon}
      <Text style={[pageStyles.pillText, small && pageStyles.pillTextSmall, variant === "danger" && pageStyles.dangerText]}>
        {title}
      </Text>
    </Pressable>
  );
}

export type MenuItem = { label: string; icon?: ReactNode; danger?: boolean; onPress: () => void };

/**
 * A small menu under its button (the web's FloatingMenu): opens below the button, to the left of its right edge, and
 * above it when there is no room below. A tap outside closes it; picking an item closes it, then runs it.
 */
export function PopMenu({
  label,
  items,
  disabled,
  style,
  children,
}: {
  label: string;
  items: MenuItem[];
  disabled?: boolean;
  style?: StyleProp<ViewStyle> | ((s: { pressed: boolean }) => StyleProp<ViewStyle>);
  children: ReactNode;
}) {
  const anchor = useRef<ComponentRef<typeof View>>(null);
  const [at, setAt] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const win = useWindowDimensions();
  const open = () => anchor.current?.measureInWindow((x, y, w, h) => setAt({ x, y, w, h }));
  // The item picked, run once the menu has gone: iOS can't show a browser, sheet, dialog or alert while this
  // menu's own window is still closing (it would hang behind it).
  const picked = useRef<(() => void) | null>(null);
  const runPicked = () => {
    const run = picked.current;
    picked.current = null;
    run?.();
  };
  const close = () => {
    setAt(null);
    setSize(null);
  };
  const place = (() => {
    if (!at || !size) return { opacity: 0, top: 0, left: 0 };
    const below = at.y + at.h + 6 + size.height <= win.height - 8;
    return {
      top: below ? at.y + at.h + 6 : Math.max(8, at.y - 6 - size.height),
      left: Math.max(8, Math.min(at.x + at.w - size.width, win.width - size.width - 8)),
    };
  })();
  return (
    <>
      <View ref={anchor} collapsable={false}>
        <Pressable onPress={open} disabled={disabled} hitSlop={4} accessibilityRole="button" accessibilityLabel={label} style={style}>
          {children}
        </Pressable>
      </View>
      <Modal
        visible={at !== null}
        transparent
        animationType="fade"
        onRequestClose={close}
        onDismiss={runPicked}
        supportedOrientations={["portrait", "landscape"]}>
        <Pressable silent style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close menu" />
        <View
          style={[pageStyles.popMenu, place]}
          accessibilityRole="menu"
          onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
          {items.map((item) => (
            <Pressable
              key={item.label}
              accessibilityRole="menuitem"
              onPress={() => {
                picked.current = item.onPress;
                close();
                // Android has no onDismiss: its menu closes in place, so the item can run straight away.
                if (Platform.OS !== "ios") runPicked();
              }}
              style={({ pressed }) => [pageStyles.popItem, pressed && pageStyles.popItemPressed]}>
              {item.icon}
              <Text style={[pageStyles.popLabel, item.danger && pageStyles.popDanger]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </Modal>
    </>
  );
}

/** Ask before something that cannot be undone (the web's ConfirmButton), then run it. */
export function confirm(title: string, action: string, run: () => void, message?: string) {
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: action, style: "destructive", onPress: run },
  ]);
}

/** Used against a limit, as a labelled bar (the web Settings Meter). A negative limit is unlimited. */
export function Meter({ label, used, limit, unit }: { label: string; used: number; limit: number; unit: string }) {
  const unlimited = limit < 0;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  return (
    <View style={pageStyles.meter}>
      <View style={pageStyles.meterHead}>
        <Text style={pageStyles.meterLabel}>{label}</Text>
        <Text style={pageStyles.meterValue}>
          {used} / {unlimited ? "unlimited" : limit}
          {unit ? ` ${unit}` : ""}
        </Text>
      </View>
      <View style={pageStyles.track}>
        <View style={[pageStyles.bar, { width: `${unlimited ? 4 : Math.max(pct, 2)}%` }]} />
      </View>
    </View>
  );
}

export const pageStyles = StyleSheet.create({
  dialogBackdrop: { flex: 1, justifyContent: "center", padding: 20, backgroundColor: "rgba(0, 0, 0, 0.65)" },
  dialog: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.black, overflow: "hidden" },
  dialogHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 20, paddingBottom: 14 },
  dialogBody: { gap: 14, paddingHorizontal: 20, paddingBottom: 20 },
  fill: { flex: 1, backgroundColor: colors.black },
  column: { padding: gutter * 1.25, paddingBottom: gutter * 3, gap: 14 },
  head: { gap: 10, marginBottom: 4 },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 3, textTransform: "uppercase" },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  card: {
    gap: 12,
    padding: gutter * 1.25,
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(12, 12, 12, 0.92)",
  },
  kicker: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 2.5 },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  cardTitle: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 21, flexShrink: 1 },
  body: { color: colors.text2, fontSize: 16, lineHeight: 23 },
  mono: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    alignSelf: "flex-start",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  pillSmall: { paddingHorizontal: 14, paddingVertical: 7 },
  pillPrimary: { backgroundColor: colors.blue, borderColor: colors.blue },
  pillDanger: { borderColor: "rgba(255, 107, 107, 0.55)" },
  pillOff: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
  pillText: { color: colors.white, fontSize: 16, fontWeight: "600" },
  pillTextSmall: { fontSize: 14.5 },
  dangerText: { color: colors.danger },
  meter: { gap: 6 },
  meterHead: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  meterLabel: { color: colors.text, fontSize: 15.5 },
  meterValue: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13 },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" },
  bar: { height: 4, borderRadius: 2, backgroundColor: colors.blue },
  input: {
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  label: { color: colors.text2, fontSize: 14, fontWeight: "500" },
  link: { color: colors.text, textDecorationLine: "underline", textDecorationColor: colors.blue },
  sheet: { flex: 1, backgroundColor: "#0a0a0a" },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: gutter * 1.25,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  sheetTitle: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 22 },
  sheetBody: { padding: gutter * 1.25, paddingBottom: gutter * 3, gap: 14 },
  popMenu: {
    position: "absolute",
    minWidth: 220,
    padding: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.black,
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  popItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 6 },
  popItemPressed: { backgroundColor: colors.surface2 },
  popLabel: { color: colors.white, fontSize: 16, fontWeight: "500" },
  popDanger: { color: "#ff8a8a" },
});

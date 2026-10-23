import { ApiError } from "@notestack/shared/client";
import { artifactsApi, shareApi, videosApi } from "@notestack/shared/endpoints";
import type { Artifact } from "@notestack/shared/types";
import { SymbolView } from "expo-symbols";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { Alert, Pressable, Share, StyleSheet, Text, View } from "react-native";

import { colors, fonts, gutter } from "@/theme";
import { ErrorText, formatDate } from "@/ui";
import { CARD_RADIUS, JobProgress } from "@/widgets";

const SITE = "https://notestack.ai";

/** What can be launched as a post (web: components/launchpad/PostButton.tsx). */
const POSTABLE = new Set(["video", "quote_card", "carousel", "summary", "launch_kit", "slide_deck", "report", "infographic", "upload"]);

/** What can be shared by link (web: components/ShareDialog.tsx). */
const SHAREABLE = new Set(["report", "infographic", "audio_overview", "video", "slide_deck", "flashcards", "quiz", "mind_map"]);

function canPost(a: Artifact): boolean {
  if (a.type === "audio_overview") return a.status === "ready";
  if (!POSTABLE.has(a.type)) return false;
  if (a.provider === "blog2video") return a.status === "ready" || Boolean((a.content as { video_url?: string } | null)?.video_url);
  return a.status === "ready";
}

function canShare(a: Artifact): boolean {
  return SHAREABLE.has(a.type) && (a.status === "ready" || (a.type === "video" && Boolean(a.url)));
}

/** Still being made: the list asks again until it is ready or failed. */
export function isMaking(a: Artifact): boolean {
  return a.status !== "ready" && a.status !== "failed" && a.status !== "draft" && a.status !== "review";
}

function statusOf(a: Artifact): { label: string; tone: "done" | "busy" | "failed" } {
  if (a.status === "failed") return { label: "Failed", tone: "failed" };
  if (a.status !== "ready") return { label: "Generating", tone: "busy" };
  return { label: "Ready", tone: "done" };
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds) return "";
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

/** The type chip's colours, as the web's .type-chip: blue, with audio in purple and quote cards in amber. */
const CHIP: Record<string, { color: string; border: string; background: string }> = {
  audio_overview: { color: "#c084fc", border: "rgba(168, 85, 247, 0.4)", background: "rgba(168, 85, 247, 0.12)" },
  quote_card: { color: "#fbbf24", border: "rgba(245, 158, 11, 0.4)", background: "rgba(245, 158, 11, 0.12)" },
};
const BLUE_CHIP = { color: colors.blue, border: "rgba(33, 124, 255, 0.35)", background: colors.blue10 };

/** Open something on the web app (the in-app browser) until the app has its own screen for it. */
const openWeb = (path: string) => WebBrowser.openBrowserAsync(`${SITE}${path}`, { controlsColor: colors.blue });

/** One made thing as a card (web: components/ArtifactRow.tsx): its type, title, status and date, with Launch, Share
 * and delete. */
export function ArtifactCard({
  artifact: a,
  onRemoved,
  onChanged,
}: {
  artifact: Artifact;
  onRemoved: (id: string) => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState("");
  const [sharing, setSharing] = useState(false);
  const st = statusOf(a);
  const chip = CHIP[a.type] ?? BLUE_CHIP;
  const editorVideo = a.provider === "blog2video";
  // A deck's title starts "Slide deck: ", which its chip already says.
  const title = a.type === "slide_deck" ? a.title.replace(/^Slide deck: /, "") : a.title;
  const meta = [
    a.created_at ? formatDate(a.created_at, true) : null,
    a.content?.duration_s ? formatDuration(a.content.duration_s) : null,
    a.content?.aspect_ratio ? (a.content.aspect_ratio === "portrait" ? "Portrait" : "Landscape") : null,
  ].filter(Boolean);

  const open = () => openWeb(editorVideo ? `/app/videos/${a.id}` : `/app/artifacts/${a.id}`);

  const share = async () => {
    setSharing(true);
    setError("");
    try {
      const existing = await shareApi.get(a.id);
      const info = existing.shared ? existing : await shareApi.create(a.id);
      if (info.url) await Share.share({ url: info.url, message: info.url, title: a.title });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not make a share link. Try again.");
    } finally {
      setSharing(false);
    }
  };

  const remove = () =>
    Alert.alert(`Delete ${a.type_label.toLowerCase()}?`, a.title, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            // A video made in the Videos editor is removed from there too.
            await (editorVideo ? videosApi.remove(a.id) : artifactsApi.remove(a.id));
            onRemoved(a.id);
          } catch (e) {
            setError(e instanceof ApiError ? e.message : "Could not delete it. Try again.");
          }
        },
      },
    ]);

  const retry = async () => {
    setError("");
    try {
      await artifactsApi.retry(a.id);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not retry. Try again.");
    }
  };

  return (
    <View style={styles.card}>
      <Pressable onPress={open} accessibilityRole="link" style={({ pressed }) => [styles.main, pressed && styles.pressed]}>
        <View style={[styles.chip, { borderColor: chip.border, backgroundColor: chip.background }]}>
          <Text style={[styles.chipText, { color: chip.color }]}>{a.type_label.toUpperCase()}</Text>
        </View>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.status}>
          <View style={[styles.dot, styles[st.tone]]} />
          <Text style={styles.statusText}>{st.label}</Text>
        </View>
        {meta.length ? <Text style={styles.meta}>{meta.join("     ")}</Text> : null}
      </Pressable>

      {a.job && isMaking(a) ? <JobProgress job={a.job} /> : null}
      {a.status === "failed" && a.content?.error ? <ErrorText>{String(a.content.error)}</ErrorText> : null}
      <ErrorText>{error}</ErrorText>

      <View style={styles.actions}>
        {canPost(a) ? (
          <Pressable
            style={styles.button}
            accessibilityRole="button"
            onPress={() => openWeb(a.type === "audio_overview" ? `/app/artifacts/${a.id}` : `/app/launchpad`)}>
            <Text style={styles.buttonText}>Launch</Text>
          </Pressable>
        ) : null}
        {canShare(a) ? (
          <Pressable style={[styles.button, sharing && styles.off]} disabled={sharing} accessibilityRole="button" onPress={share}>
            <SymbolView name={{ ios: "square.and.arrow.up", android: "share" }} size={16} tintColor={colors.text} />
            <Text style={styles.buttonText}>{sharing ? "Sharing..." : "Share"}</Text>
          </Pressable>
        ) : null}
        {a.status === "failed" ? (
          <Pressable style={styles.button} accessibilityRole="button" onPress={retry}>
            <Text style={styles.buttonText}>Retry</Text>
          </Pressable>
        ) : null}
        <View style={styles.spacer} />
        <Pressable onPress={remove} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Delete ${a.title}`}>
          <SymbolView name={{ ios: "trash", android: "delete" }} size={19} tintColor={colors.text3} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 14,
    padding: gutter * 1.25,
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(12, 12, 12, 0.92)",
  },
  main: { gap: 12 },
  pressed: { opacity: 0.75 },
  chip: { alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, borderWidth: 1 },
  chipText: { fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 1.5 },
  title: { color: colors.text, fontSize: 19, fontWeight: "600" },
  status: { flexDirection: "row", alignItems: "center", gap: 10 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  done: { backgroundColor: colors.blue },
  busy: { backgroundColor: "#f5b041" },
  failed: { backgroundColor: colors.danger },
  statusText: { color: colors.text2, fontSize: 17 },
  meta: { color: colors.text3, fontSize: 16 },
  actions: { flexDirection: "row", alignItems: "center", gap: 10 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  buttonText: { color: colors.text, fontSize: 16, fontWeight: "600" },
  off: { opacity: 0.5 },
  spacer: { flex: 1 },
});

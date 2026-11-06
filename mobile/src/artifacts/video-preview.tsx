import { ApiError } from "@notestack/shared/client";
import { videosApi } from "@notestack/shared/endpoints";
import type { Artifact } from "@notestack/shared/types";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { RenderVideoDialog } from "@/launchpad/render-dialog";
import { isWebUrl, LivePlayer, Mp4Player, PlayerCrashDialog } from "@/video/live-player";
import { CloseIcon } from "@/ui/icons";
import { colors, fonts, gutter } from "@/ui/theme";
import { ErrorText } from "@/ui";
import { pageStyles } from "@/ui/widgets";

/** The player without its speed and captions controls (blog2video's `hide` option, as the web's PreviewFrame). */
function playerUrl(src: string): string {
  try {
    const u = new URL(src);
    u.searchParams.set("hide", "speed,captions");
    return u.toString();
  } catch {
    return src;
  }
}

/**
 * A blog2video video's live player, full screen (web: VideoCard's preview modal and PreviewFrame). The preview link is
 * made the first time it is asked for. The player says nothing when it is ready, so the loader stays a moment after the
 * page loads, while it draws its first frame. Turning the phone plays it wide.
 *
 * The live player can run the phone out of memory. When it crashes, this offers the MP4 instead (rendering it first if
 * there is none); Cancel loads the live player again, and another crash asks again.
 */
export function VideoPreview({ artifact, visible, onClose, onChanged }: { artifact: Artifact; visible: boolean; onClose: () => void; onChanged?: () => void }) {
  const [preview, setPreview] = useState<string | null>((artifact.content?.preview_url as string | undefined) ?? null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<"live" | "crashed" | "rendering" | "mp4">("live");
  const [attempt, setAttempt] = useState(0); // a new number loads a new live player
  const [progress, setProgress] = useState(false); // the render's progress dialog is open
  const [renderedUrl, setRenderedUrl] = useState<string | null>(null);
  const renderStarted = useRef(false); // started here and not yet seen to end; outlives closing the screen
  const mp4 = renderedUrl ?? [artifact.content?.video_url, artifact.url].find(isWebUrl) ?? null;

  const playLive = () => {
    setLoaded(false);
    setReady(false);
    setAttempt((n) => n + 1);
    setView("live");
  };

  // Waiting on a render with no dialog open: when it ends, play the MP4, or go back to the live player if it failed.
  const refresh = useRef(onChanged);
  useEffect(() => {
    refresh.current = onChanged;
  });
  useEffect(() => {
    if (!visible || view !== "rendering" || progress) return;
    let live = true;
    const check = async () => {
      try {
        const s = await videosApi.status(artifact.id);
        if (!live || s.artifact_status === "rendering") return;
        live = false;
        clearInterval(timer);
        renderStarted.current = false;
        refresh.current?.();
        if (isWebUrl(s.video_url)) {
          setRenderedUrl(s.video_url);
          setView("mp4");
        } else {
          setLoaded(false);
          setReady(false);
          setAttempt((n) => n + 1);
          setView("live");
        }
      } catch {
        // a missed poll: try again on the next one
      }
    };
    const timer = setInterval(() => void check(), 4000);
    void check();
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [visible, view, progress, artifact.id]);

  useEffect(() => {
    if (!visible || preview) return;
    let live = true;
    (async () => {
      try {
        const got = (await videosApi.get(artifact.id)) as { preview_url?: string | null };
        if (!got.preview_url) throw new Error("The preview is not available yet.");
        if (live) setPreview(got.preview_url);
      } catch (e) {
        if (live) setError(e instanceof ApiError || e instanceof Error ? e.message : "The preview could not be opened.");
      }
    })();
    return () => {
      live = false;
    };
  }, [visible, preview, artifact.id]);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => setReady(true), 1500);
    return () => clearTimeout(t);
  }, [loaded]);

  const close = () => {
    setLoaded(false);
    setReady(false);
    setError("");
    setView("live");
    setProgress(false);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" supportedOrientations={["portrait", "landscape"]} onRequestClose={close}>
      <SafeAreaProvider>
      <SafeAreaView style={[pageStyles.sheet, styles.fill]} edges={["top", "bottom", "left", "right"]}>
        <View style={styles.head}>
          <Text style={styles.title} numberOfLines={1}>
            {artifact.title}
          </Text>
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <CloseIcon size={22} />
          </Pressable>
        </View>
        <View style={styles.stage}>
          {preview && visible && view === "live" ? (
            <LivePlayer
              key={attempt}
              uri={playerUrl(preview)}
              onLoadEnd={() => setLoaded(true)}
              onCrash={() => setView(artifact.status === "rendering" || renderStarted.current ? "rendering" : "crashed")}
            />
          ) : null}
          {view === "mp4" && mp4 ? <Mp4Player uri={mp4} /> : null}
          {view === "rendering" ? (
            <View style={styles.wait} accessibilityRole="progressbar" accessibilityLabel="Rendering the video">
              <ActivityIndicator color={colors.blue} />
              <Text style={styles.waitText}>Rendering. The MP4 will play here when it&apos;s ready.</Text>
            </View>
          ) : null}
          {view === "live" && !ready && !error ? (
            <View style={styles.wait} accessibilityRole="progressbar" accessibilityLabel="Loading the video">
              <ActivityIndicator color={colors.blue} />
              <Text style={styles.waitText}>Loading the video</Text>
            </View>
          ) : null}
          {error ? (
            <View style={styles.wait}>
              <ErrorText>{error}</ErrorText>
            </View>
          ) : null}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
      {view === "crashed" && mp4 ? <PlayerCrashDialog hasMp4 onCancel={playLive} onPrimary={() => setView("mp4")} /> : null}
      {(view === "crashed" && !mp4) || progress ? (
        <RenderVideoDialog
          video={{ id: artifact.id, title: artifact.title, rendering: false }}
          onClose={() => {
            // Mid-render or after it, the check above takes over; before one was started, this is Cancel.
            if (progress) setProgress(false);
            else playLive();
          }}
          onRendered={() => onChanged?.()}
          watch={{
            onStarted: () => {
              renderStarted.current = true;
              setProgress(true);
              setView("rendering");
              onChanged?.();
            },
            onWatch: () => setProgress(false),
          }}
        />
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { backgroundColor: colors.black },
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: gutter * 1.25, paddingVertical: 12 },
  title: { flex: 1, color: colors.text, fontFamily: fonts.displayBold, fontSize: 19 },
  stage: { flex: 1, justifyContent: "center" },
  player: { flex: 1, backgroundColor: colors.black },
  wait: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center", gap: 10, padding: gutter, backgroundColor: colors.black },
  waitText: { color: colors.text2, fontSize: 15 },
});

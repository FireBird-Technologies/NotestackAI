import { ApiError } from "@notestack/shared/client";
import { useEvent } from "expo";
import { useVideoPlayer, VideoView } from "expo-video";
import { useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";

import { ErrorText } from "@/ui";
import { colors, gutter } from "@/ui/theme";
import { Dialog, pageStyles, PillButton } from "@/ui/widgets";

export const isWebUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u);

export const CRASH_TITLE = "Video stopped playing";
export const CRASH_BODY = "The video player is memory heavy and crashed because your phone ran out of memory.";

/** Why a render could not start, in words for the crash dialogs. */
export function renderStartError(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) return "Another change is still running on this video, try again in a moment.";
  return e instanceof Error && e.message ? e.message : "Could not start the render. Try again.";
}

/**
 * blog2video's live player. It runs inside the phone's web process, and iOS ends that process when the page uses too much
 * memory, which leaves a blank page. `onCrash` says so. The system can also reclaim the process while the app is in the
 * background, which is no fault of the player: then it just starts again. To reload after a crash, change the `key`.
 */
export function LivePlayer({ uri, onCrash, onLoadEnd }: { uri: string; onCrash: () => void; onLoadEnd?: () => void }) {
  const [restarts, setRestarts] = useState(0);
  const gone = () => {
    if (AppState.currentState === "active") onCrash();
    else setRestarts((n) => n + 1);
  };
  return (
    <WebView
      key={restarts}
      source={{ uri }}
      style={styles.fill}
      containerStyle={styles.fill}
      allowsInlineMediaPlayback
      allowsFullscreenVideo
      mediaPlaybackRequiresUserAction={false}
      onLoadEnd={onLoadEnd}
      onContentProcessDidTerminate={gone}
      onRenderProcessGone={gone}
    />
  );
}

/** A rendered MP4 in the phone's own video player, which streams it and does not hold the whole video in memory. */
export function Mp4Player({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => p.play());
  const { status } = useEvent(player, "statusChange", { status: player.status });
  if (status === "error") {
    return (
      <View style={styles.message}>
        <ErrorText>The MP4 could not be played. Try again in a moment.</ErrorText>
      </View>
    );
  }
  return <VideoView player={player} style={styles.fill} contentFit="contain" nativeControls fullscreenOptions={{ enable: true }} />;
}

/** Said after the live player crashes: play the MP4, or render one if there is none. Cancel tries the live player again. */
export function PlayerCrashDialog({ hasMp4, onCancel, onPrimary }: { hasMp4: boolean; onCancel: () => void; onPrimary: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      await onPrimary();
    } catch (e) {
      setError(renderStartError(e));
      setBusy(false);
    }
  };
  return (
    <Dialog visible title={CRASH_TITLE} onClose={onCancel}>
      <Text style={styles.body}>
        {CRASH_BODY} {hasMp4 ? "Play the rendered MP4 to watch it smoothly." : "Render the video to watch it smoothly."}
      </Text>
      <ErrorText>{error}</ErrorText>
      <View style={styles.end}>
        <PillButton title="Cancel" onPress={onCancel} disabled={busy} />
        <PillButton title={busy ? "Starting..." : hasMp4 ? "Play MP4" : "Render"} variant="primary" busy={busy} onPress={() => void go()} />
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.black },
  message: { flex: 1, alignItems: "center", justifyContent: "center", padding: gutter, backgroundColor: colors.black },
  body: { ...pageStyles.body, color: colors.text2 },
  end: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 10 },
});

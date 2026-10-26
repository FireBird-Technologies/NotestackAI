import { ApiError } from "@notestack/shared/client";
import { videosApi } from "@notestack/shared/endpoints";
import type { Artifact } from "@notestack/shared/types";
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { CloseIcon } from "@/icons";
import { colors, fonts, gutter } from "@/theme";
import { ErrorText } from "@/ui";
import { pageStyles } from "@/widgets";

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
 */
export function VideoPreview({ artifact, visible, onClose }: { artifact: Artifact; visible: boolean; onClose: () => void }) {
  const [preview, setPreview] = useState<string | null>((artifact.content?.preview_url as string | undefined) ?? null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);

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
          {preview && visible ? (
            <WebView
              source={{ uri: playerUrl(preview) }}
              style={styles.player}
              containerStyle={styles.player}
              allowsInlineMediaPlayback
              allowsFullscreenVideo
              mediaPlaybackRequiresUserAction={false}
              onLoadEnd={() => setLoaded(true)}
            />
          ) : null}
          {!ready && !error ? (
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

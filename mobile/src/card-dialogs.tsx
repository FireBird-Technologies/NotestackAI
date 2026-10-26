import { ApiError } from "@notestack/shared/client";
import { shareApi } from "@notestack/shared/endpoints";
import type { ShareInfo } from "@notestack/shared/types";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { extOf, fileName, saveFile } from "@/downloads";
import { DownloadIcon } from "@/icons";
import { colors, radius } from "@/theme";
import { ErrorText } from "@/ui";
import { Dialog, pageStyles, PillButton } from "@/widgets";

/** What each kind is called in the share dialog (web: ShareDialog SHARE_WHAT). */
export const SHARE_WHAT: Record<string, string> = {
  report: "report",
  infographic: "infographic",
  audio_overview: "audio overview",
  video: "video",
  slide_deck: "slide deck",
  flashcards: "flashcard set",
  quiz: "quiz",
  mind_map: "Mind Constellation",
};

/** One link request per item at a time, so opening the dialog twice quickly never makes two. */
const making = new Map<string, Promise<ShareInfo>>();
function linkFor(id: string): Promise<ShareInfo> {
  let got = making.get(id);
  if (!got) {
    got = shareApi
      .get(id)
      .then((s) => (s.shared ? s : shareApi.create(id)))
      .finally(() => making.delete(id));
    making.set(id, got);
  }
  return got;
}

const message = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback);

/**
 * Share (web: ShareDialog): opening it makes the link (or shows the one there is), ready to copy; the page shows the
 * item only. Stopping ends the link for good.
 */
export function ShareDialog({ artifactId, what, visible, onClose }: { artifactId: string; what: string; visible: boolean; onClose: () => void }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    linkFor(artifactId)
      .then((got) => live && setInfo(got))
      .catch((e) => live && setError(message(e, "Could not make the link.")));
    return () => {
      live = false;
    };
  }, [artifactId, visible]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const run = async (act: () => Promise<ShareInfo>) => {
    setBusy(true);
    setError("");
    try {
      setInfo(await act());
    } catch (e) {
      setError(message(e, "Could not change the link."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog visible={visible} title="Share" onClose={onClose}>
      {!info && !error ? (
        <View style={styles.wait}>
          <ActivityIndicator color={colors.blue} />
          <Text style={styles.muted}>Making the link</Text>
        </View>
      ) : null}
      {info && !info.shared ? (
        <>
          <Text style={styles.muted}>
            Make a link anyone can open to see this {what}. They don&apos;t need an account, and they can&apos;t edit or see your posts, only the {what}.
          </Text>
          <View style={styles.end}>
            <PillButton title={busy ? "Making the link..." : "Create preview link"} variant="primary" busy={busy} onPress={() => void run(() => shareApi.create(artifactId))} />
          </View>
        </>
      ) : null}
      {info?.shared && info.url ? (
        <>
          <View style={styles.linkRow}>
            <View style={styles.linkBox}>
              <Text style={styles.link} numberOfLines={1} selectable>
                {info.url}
              </Text>
            </View>
            <PillButton title={copied ? "Copied" : "Copy link"} variant="primary" onPress={() => void Clipboard.setStringAsync(info.url!).then(() => setCopied(true))} />
          </View>
          <Text style={styles.muted}>
            The page shows the {what} only: no source text, no quotes and no name. Stopping ends the link for good, and sharing again makes a new one.
          </Text>
          <View style={styles.row}>
            <PillButton small title="Open the page" onPress={() => void WebBrowser.openBrowserAsync(info.url!, { controlsColor: colors.blue })} />
            <PillButton small title="Stop sharing" variant="danger" disabled={busy} onPress={() => void run(() => shareApi.remove(artifactId))} />
          </View>
        </>
      ) : null}
      <ErrorText>{error}</ErrorText>
    </Dialog>
  );
}

/** Launch on an audio overview (web: launchpad/Attachment.tsx AudioOnlyModal): LinkedIn takes no audio, so download it. */
export function AudioOnlyDialog({ title, downloadUrl, visible, onClose }: { title: string; downloadUrl: string | null | undefined; visible: boolean; onClose: () => void }) {
  return (
    <Dialog visible={visible} title="Audio can't be posted" onClose={onClose}>
      <View style={styles.badge}>
        <Image source={require("@/assets/images/create/headphones.png")} style={styles.badgeIcon} tintColor={colors.blue} />
      </View>
      <Text style={pageStyles.body}>
        LinkedIn does not support posting audio files, so <Text style={styles.strong}>{title}</Text> can&apos;t be scheduled. Download it now to use it
        elsewhere, like a podcast app, your newsletter or a website.
      </Text>
      <View style={styles.end}>
        <PillButton title="Close" onPress={onClose} />
        {downloadUrl ? (
          <PillButton
            title="Download"
            variant="primary"
            icon={<DownloadIcon size={17} color={colors.white} />}
            onPress={() => {
              onClose();
              // Saved as a file and handed to the share sheet (Files, a podcast app...), not opened in a browser.
              void saveFile({ url: downloadUrl }, fileName(title, "Audio overview"), extOf(downloadUrl, "mp3")).catch(() => undefined);
            }}
          />
        ) : (
          <Text style={styles.muted}>The file isn&apos;t available right now. Try again later.</Text>
        )}
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  wait: { flexDirection: "row", alignItems: "center", gap: 10 },
  muted: { color: colors.text2, fontSize: 15, lineHeight: 22 },
  end: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 10 },
  row: { flexDirection: "row", gap: 10 },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  linkBox: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.black,
  },
  link: { color: colors.text, fontSize: 15 },
  badge: { width: 60, height: 60, borderRadius: 30, alignItems: "center", justifyContent: "center", backgroundColor: colors.blue10 },
  badgeIcon: { width: 28, height: 28 },
  strong: { color: colors.text, fontWeight: "700" },
});


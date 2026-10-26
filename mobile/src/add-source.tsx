import { ApiError, type UploadSource } from "@notestack/shared/client";
import { sourcesApi } from "@notestack/shared/endpoints";
import type { Job, Source } from "@notestack/shared/types";
import { classifyUrl, looksLikeArticle } from "@notestack/shared/urlScrapability";
import { File } from "expo-file-system";
import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { colors, gutter } from "@/theme";
import { ErrorText } from "@/ui";
import { CARD_RADIUS } from "@/widgets";

const FILE_TYPES = /\.(md|markdown|txt|vtt|html?|pdf)$/i;

/** One box for everything: paste a link (feed or article is worked out for you) or add files. */
export function AddSource({
  onAdded,
  notebookId,
  compact,
}: {
  onAdded: (source: Source, job: Job) => void;
  /** Every post the source brings in joins this notebook too. */
  notebookId?: string;
  /** The notebook's dialog: a shorter hint, in a plain box. */
  compact?: boolean;
}) {
  const [value, setValue] = useState("");
  const [override, setOverride] = useState<"feed" | "url" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const link = value.trim();
  const mode = override ?? (looksLikeArticle(value) ? "url" : "feed");
  const verdict = classifyUrl(value);

  /** The web's link check: a blocked link stops here, a warned one asks first. */
  const confirmLink = () =>
    new Promise<boolean>((resolve) => {
      if (verdict.kind === "ok") return resolve(true);
      if (verdict.kind === "blocked") {
        Alert.alert("This link can't be added", verdict.message, [{ text: "Use a different link", onPress: () => resolve(false) }]);
        return;
      }
      Alert.alert("Before you add this link", verdict.message, [
        { text: "Use a different link", style: "cancel", onPress: () => resolve(false) },
        { text: "Continue anyway", onPress: () => resolve(true) },
      ]);
    });

  const connect = async () => {
    if (!link || !(await confirmLink())) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const res = mode === "feed" ? await sourcesApi.connect(link, notebookId) : await sourcesApi.importUrl(link, notebookId);
      onAdded(res.source, res.job);
      setValue("");
      setOverride(null);
    } catch (e) {
      const fallback = mode === "feed" ? "We could not find a feed there." : "We could not import that page.";
      setError(e instanceof ApiError ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    setError("");
    setNotice("");
    const picked = await File.pickFileAsync({
      multipleFiles: true,
      mimeTypes: ["text/*", "application/pdf"],
    }).catch(() => null);
    if (!picked || picked.canceled) return;
    const files = picked.result;
    setBusy(true);
    let failed = 0;
    for (const f of files) {
      if (!FILE_TYPES.test(f.name)) {
        failed += 1;
        continue;
      }
      try {
        // expo-file-system's File is a Blob with a name, which is all the shared upload needs.
        const res = await sourcesApi.importFile(f as unknown as UploadSource, notebookId);
        onAdded(res.source, res.job);
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    if (failed) {
      setError(`${failed} of ${files.length} files could not be uploaded. Markdown, text, VTT, HTML or PDF files work.`);
    } else {
      setNotice(`${files.length} ${files.length === 1 ? "file" : "files"} uploading. They appear under Imported posts and files.`);
    }
  };

  return (
    <View style={[styles.card, compact && styles.compact]}>
      <TextInput
        style={styles.linkInput}
        value={value}
        onChangeText={(t) => {
          setValue(t);
          setOverride(null);
        }}
        placeholder="Paste a blog, newsletter or article link"
        placeholderTextColor={colors.text3}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={connect}
        accessibilityLabel="Blog, newsletter or article link"
      />
      <View style={styles.addRow}>
        <Pressable
          onPress={connect}
          disabled={busy || !link}
          accessibilityRole="button"
          style={[styles.connect, (busy || !link) && styles.connectOff]}>
          <Text style={[styles.connectText, (busy || !link) && styles.connectTextOff]}>
            {busy ? (mode === "feed" ? "Finding posts..." : "Working...") : mode === "feed" ? "Connect" : "Import article"}
          </Text>
        </Pressable>
        <Text style={styles.or}>or</Text>
        <Pressable onPress={upload} disabled={busy} accessibilityRole="button" style={[styles.outline, busy && styles.off]}>
          <Text style={styles.outlineText}>Upload files</Text>
        </Pressable>
      </View>
      {!link ? (
        compact ? (
          <Text style={styles.body}>Any blog or newsletter link, or Markdown, text, HTML and PDF files.</Text>
        ) : (
          <Text style={styles.body}>
            Substack, Ghost, WordPress, Medium or any site with a feed. Markdown, text, VTT transcripts, HTML and PDF files
            work too.
          </Text>
        )
      ) : mode === "feed" ? (
        <Text style={styles.body}>
          We will pull in the whole archive and keep it in sync.{" "}
          <Text style={styles.link} onPress={() => setOverride("url")}>
            Just this one page instead
          </Text>
        </Text>
      ) : (
        <Text style={styles.body}>
          Looks like a single article, so we will import just this page.{" "}
          <Text style={styles.link} onPress={() => setOverride("feed")}>
            Connect the whole site instead
          </Text>
        </Text>
      )}
      {verdict.kind !== "ok" ? (
        <Text style={verdict.kind === "blocked" ? styles.blocked : styles.warn}>{verdict.message}</Text>
      ) : null}
      <ErrorText>{error}</ErrorText>
      {notice ? <Text style={styles.body}>{notice}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 12,
    padding: gutter * 1.25,
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(12, 12, 12, 0.92)",
  },
  compact: { padding: gutter, backgroundColor: colors.surface },
  body: { color: colors.text2, fontSize: 15, lineHeight: 22 },
  link: { color: colors.blue, textDecorationLine: "underline" },
  linkInput: {
    color: colors.text,
    fontSize: 17,
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  addRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 14 },
  connect: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999, backgroundColor: colors.blue },
  connectOff: { backgroundColor: "rgba(33, 124, 255, 0.35)" },
  connectText: { color: colors.white, fontSize: 17, fontWeight: "600" },
  connectTextOff: { color: "rgba(255, 255, 255, 0.55)" },
  or: { color: colors.text3, fontSize: 16 },
  outline: {
    alignSelf: "flex-start",
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  outlineText: { color: colors.text, fontSize: 16, fontWeight: "600" },
  off: { opacity: 0.45 },
  blocked: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  warn: { color: "#f5b041", fontSize: 14, lineHeight: 20 },
});

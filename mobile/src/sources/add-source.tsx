import { ApiError, type UploadSource } from "@notestack/shared/client";
import { sourcesApi } from "@notestack/shared/endpoints";
import type { Job, Source } from "@notestack/shared/types";
import { classifyUrl, looksLikeArticle } from "@notestack/shared/urlScrapability";
import { File } from "expo-file-system";
import { useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { UploadIcon } from "@/ui/icons";
import { colors, fonts, gutter } from "@/ui/theme";
import { ErrorText } from "@/ui";
import { CARD_RADIUS } from "@/ui/widgets";

const FILE_TYPES = /\.(md|markdown|txt|vtt|html?|pdf)$/i;

/** One box for everything: paste a link (feed or article is worked out for you) or add files. */
export function AddSource({
  onAdded,
  notebookId,
  compact,
  examples,
}: {
  onAdded: (source: Source, job: Job) => void;
  /** Every post the source brings in joins this notebook too. */
  notebookId?: string;
  /** The notebook's dialog: a shorter hint, in a plain box. */
  compact?: boolean;
  /** Links to try, as chips under the box that fill it (onboarding). */
  examples?: string[];
}) {
  const [value, setValue] = useState("");
  const [method, setMethod] = useState<"link" | "upload">("link");
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

  const linkPanel = (
    <>
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
      <Pressable
        onPress={connect}
        disabled={busy || !link}
        accessibilityRole="button"
        style={[styles.connect, (busy || !link) && styles.connectOff]}>
        <Text style={[styles.connectText, (busy || !link) && styles.connectTextOff]}>
          {busy ? (mode === "feed" ? "Finding posts..." : "Working...") : mode === "feed" ? "Connect" : "Import article"}
        </Text>
      </Pressable>
      {!link ? (
        <Text style={styles.body}>
          {compact ? "Paste a blog, newsletter, feed, or one article." : "Substack, Ghost, WordPress, Medium or any site with a feed, or one article."}
        </Text>
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
      {examples && examples.length > 0 && !link ? (
        <View style={styles.examples}>
          <Text style={styles.or}>Try:</Text>
          {examples.map((x) => (
            <Pressable key={x} onPress={() => setValue(x)} accessibilityRole="button" style={styles.example}>
              <Text style={styles.exampleText}>{x}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {verdict.kind !== "ok" ? (
        <Text style={verdict.kind === "blocked" ? styles.blocked : styles.warn}>{verdict.message}</Text>
      ) : null}
    </>
  );

  const uploadPanel = (
    <Pressable onPress={upload} disabled={busy} accessibilityRole="button" style={({ pressed }) => [styles.drop, (busy || pressed) && styles.off]}>
      <UploadIcon size={22} color={colors.blue} />
      <Text style={styles.dropTitle}>{busy ? "Uploading files..." : "Choose files"}</Text>
      <Text style={styles.dropHint}>Markdown · text · VTT · HTML · PDF</Text>
    </Pressable>
  );

  return (
    <View style={[styles.card, compact && styles.compact]}>
      {/* Link and Upload side by side (web: ADD_SOURCE_METHODS; NotebookLM needs Chrome on a computer, so not here) */}
      <View style={styles.methods} accessibilityRole="tablist">
        {(
          [
            ["link", "Link"],
            ["upload", "Upload"],
          ] as const
        ).map(([id, label]) => {
          const on = method === id;
          return (
            <Pressable
              key={id}
              onPress={() => {
                setMethod(id);
                setError("");
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={[styles.method, on && styles.methodOn]}>
              <Text style={[styles.methodText, on && styles.methodTextOn]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      {method === "link" ? linkPanel : uploadPanel}
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
  methods: { flexDirection: "row", gap: 6, padding: 4, borderRadius: 18, borderWidth: 1, borderColor: colors.lineStrong },
  method: { flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 14 },
  methodOn: { backgroundColor: colors.blue },
  methodText: { color: colors.text2, fontSize: 16, fontWeight: "500" },
  methodTextOn: { color: colors.white },
  drop: {
    alignItems: "center",
    gap: 6,
    paddingVertical: 22,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.lineStrong,
  },
  dropTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  dropHint: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5 },
  connect: { alignItems: "center", paddingHorizontal: 24, paddingVertical: 9, borderRadius: 999, backgroundColor: colors.blue },
  connectOff: { backgroundColor: "rgba(33, 124, 255, 0.35)" },
  connectText: { color: colors.white, fontSize: 16, fontWeight: "600" },
  connectTextOff: { color: "rgba(255, 255, 255, 0.55)" },
  or: { color: colors.text3, fontSize: 16 },
  examples: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  example: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  exampleText: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13 },
  off: { opacity: 0.45 },
  blocked: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  warn: { color: "#f5b041", fontSize: 14, lineHeight: 20 },
});

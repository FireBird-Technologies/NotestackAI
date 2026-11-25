import { ApiError, type UploadSource } from "@notestack/shared/client";
import { MAX_SOURCE_FILE_BYTES, MAX_SOURCE_FILE_LABEL, settingsApi, sourcesApi } from "@notestack/shared/endpoints";
import { SAMPLE_DOCUMENTS, SAMPLE_LINK } from "@notestack/shared/content/samples";
import type { Job, Source } from "@notestack/shared/types";
import { classifyUrl, looksLikeArticle } from "@notestack/shared/urlScrapability";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as WebBrowser from "expo-web-browser";
import { Trans } from "react-i18next";
import { File } from "expo-file-system";
import { useRef, useState } from "react";
import { Alert, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { useAuth } from "@/account/auth";
import { useUpgrade } from "@/account/upgrade";
import { track } from "@/lib/analytics";
import { webUrl } from "@/lib/platform";
import { Pressable } from "@/ui/pressable";

import { CloseIcon, EyeIcon, UploadIcon } from "@/ui/icons";
import { colors, fonts, gutter } from "@/ui/theme";
import { ErrorText } from "@/ui";
import { CARD_RADIUS } from "@/ui/widgets";
import i18n from "@/i18n";

const FILE_TYPES = /\.(md|markdown|txt|vtt|html?|pdf)$/i;
const EXT_BY_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/vtt": "vtt",
  "text/html": "html",
};

/**
 * The picked file as an upload under its real name, or null when it isn't a supported type. The picker gives each file's
 * own name (Android's Downloads and Drive hand over only an id otherwise, and the server tells uploads apart by name, so
 * they replaced one another). A name with no extension takes one from its reported type. The type is left for the
 * shared upload to work out from the name, so it always sends the bytes read here.
 */
function uploadable(asset: DocumentPicker.DocumentPickerAsset): UploadSource | null {
  const type = (asset.mimeType ?? "").split(";")[0];
  const ext = FILE_TYPES.test(asset.name) ? "" : EXT_BY_TYPE[type];
  if (!FILE_TYPES.test(asset.name) && !ext) return null;
  const name = ext ? `${asset.name.replace(/\.$/, "")}.${ext}` : asset.name;
  return { name, type: "", size: asset.size ?? 0, arrayBuffer: () => new File(asset.uri).arrayBuffer() } as unknown as UploadSource;
}

/**
 * What the picker offers. Android tags .md and .vtt as application/octet-stream, so that must be offered there (the
 * extension check below still turns away other such files); on iOS octet-stream means every file, so it names the
 * markdown and VTT types instead.
 */
const PICK_TYPES =
  Platform.OS === "android"
    ? ["text/plain", "text/markdown", "text/x-markdown", "text/vtt", "text/html", "application/pdf", "application/octet-stream"]
    : ["text/plain", "text/markdown", "text/vtt", "text/html", "application/pdf"];

/** A file picked to upload, waiting in the list until Upload is pressed. `key` spots the same file picked again. */
/** `preview`: a sample file's web address, opened by the row's eye button. */
type Picked = { uri: string; key: string; name: string; size: number; upload: UploadSource; preview?: string };

const sizeLabel = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** One box for everything: paste a link (feed or article is worked out for you) or add files. */
const METHODS = [
  ["link", i18n.t("addSource.link")],
  ["upload", i18n.t("addSource.upload")],
] as const;

export function AddSource({
  onAdded,
  notebookId,
  compact,
  examples,
  initialMethod = "link",
  roomy,
  samples,
}: {
  onAdded: (source: Source, job: Job) => void;
  /** Every post the source brings in joins this notebook too. */
  notebookId?: string;
  /** The notebook's dialog: a shorter hint, in a plain box. */
  compact?: boolean;
  /** Links to try, a line per row, under the box that fill it (onboarding). */
  examples?: string[][];
  /** Which way in is open first, and listed first: onboarding opens on Upload, as a phone's files are nearer to hand. */
  initialMethod?: "link" | "upload";
  /** Onboarding: a taller drop box, as the screen has room for it. */
  roomy?: boolean;
  /** Onboarding: "Use sample link" and "Use sample document", for someone with nothing to hand. */
  samples?: boolean;
}) {
  const [value, setValue] = useState("");
  const [method, setMethod] = useState<"link" | "upload">(initialMethod);
  const [override, setOverride] = useState<"feed" | "url" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Files picked so far: more can be added, any removed, and Upload sends them all (web: Welcome's file list).
  const [files, setFiles] = useState<Picked[]>([]);
  const uploading = useRef(false);
  // Each file becomes a post: the list stops at the posts the plan still has room for (null: no limit, or not loaded).
  const queryClient = useQueryClient();
  const usage = useQuery({ queryKey: ["settings", "usage"], queryFn: settingsApi.usage });
  const limit = usage.data?.limits.indexed_posts ?? -1;
  const room = limit < 0 ? null : Math.max(0, limit - (usage.data?.used.indexed_posts ?? 0));
  // A guest with no room left is asked to sign up or subscribe at every try, rather than told only after picking files.
  const { user } = useAuth();
  const upgrade = useUpgrade();
  const full = Boolean(user?.is_guest) && room === 0;
  const link = value.trim();
  const mode = override ?? (looksLikeArticle(value) ? "url" : "feed");
  const verdict = classifyUrl(value);

  /** The web's link check: a blocked link stops here, a warned one asks first. */
  const confirmLink = () =>
    new Promise<boolean>((resolve) => {
      if (verdict.kind === "ok") return resolve(true);
      if (verdict.kind === "blocked") {
        Alert.alert(i18n.t("addSource.cantAdd"), verdict.message, [{ text: i18n.t("addSource.useDifferent"), onPress: () => resolve(false) }]);
        return;
      }
      Alert.alert(i18n.t("addSource.beforeAdd"), verdict.message, [
        { text: i18n.t("addSource.useDifferent"), style: "cancel", onPress: () => resolve(false) },
        { text: i18n.t("addSource.continueAnyway"), onPress: () => resolve(true) },
      ]);
    });

  const connect = async () => {
    if (!link || !(await confirmLink())) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const res = mode === "feed" ? await sourcesApi.connect(link, notebookId) : await sourcesApi.importUrl(link, notebookId);
      track("source_add", { source_type: mode === "feed" ? "feed" : "url" });
      onAdded(res.source, res.job);
      setValue("");
      setOverride(null);
    } catch (e) {
      const fallback = mode === "feed" ? i18n.t("addSource.noFeed") : i18n.t("addSource.noImport");
      setError(e instanceof ApiError ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  /** Add files to the list; nothing is sent until Upload. */
  const pick = async () => {
    setError("");
    setNotice("");
    if (full) return upgrade();
    const picked = await DocumentPicker.getDocumentAsync({ multiple: true, type: PICK_TYPES, copyToCacheDirectory: true }).catch(() => null);
    if (!picked || picked.canceled) return;
    const fresh: Picked[] = [];
    let unsupported = false;
    const large: string[] = [];
    for (const asset of picked.assets) {
      const upload = uploadable(asset);
      if (!upload) {
        unsupported = true;
        continue;
      }
      const size = asset.size ?? upload.size;
      if (size > MAX_SOURCE_FILE_BYTES) {
        large.push(upload.name);
        continue;
      }
      const key = `${upload.name}-${size}`;
      if (!fresh.some((x) => x.key === key)) fresh.push({ uri: asset.uri, key, name: upload.name, size, upload });
    }
    addPicked(fresh, large, unsupported);
  };

  /** Merge into the list, skipping files already in it and stopping at the plan's room, and say what was left out. */
  const addPicked = (fresh: Picked[], large: string[] = [], unsupported = false) => {
    if (uploading.current) return; // the list is frozen while it uploads (a sample download can finish mid-upload)
    const merged = [...files, ...fresh.filter((x) => !files.some((y) => y.key === x.key))];
    if (room !== null && merged.length > room) {
      setError(
        room === 0
          ? i18n.t("addSource.planFull")
          : i18n.t("addSource.roomKept", { count: room }),
      );
    } else if (large.length) {
      setError(
        large.length === 1
          ? i18n.t("addSource.tooLargeOne", { name: large[0], max: MAX_SOURCE_FILE_LABEL })
          : i18n.t("addSource.tooLargeMany", { count: large.length, max: MAX_SOURCE_FILE_LABEL }),
      );
    } else if (unsupported) setError(i18n.t("addSource.unsupported"));
    setFiles(room === null ? merged : merged.slice(0, room));
  };

  /** The sample PDFs, downloaded from the site and added to the list like picked files; nothing is sent until Upload. */
  const addSample = async () => {
    setError("");
    setNotice("");
    if (full) return upgrade();
    const loaded = await Promise.all(
      SAMPLE_DOCUMENTS.map(async ({ name, path }): Promise<Picked | null> => {
        const url = `${webUrl()}${path}`;
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(String(res.status));
          const buffer = await res.arrayBuffer();
          // No type: the shared upload works it out from the name (application/pdf) and sends these bytes as they are
          const upload = { name, type: "", size: buffer.byteLength, arrayBuffer: async () => buffer } as unknown as UploadSource;
          return { uri: `sample:${name}`, key: `${name}-${buffer.byteLength}`, name, size: buffer.byteLength, upload, preview: url };
        } catch {
          return null;
        }
      }),
    );
    const ok = loaded.filter((p): p is Picked => p !== null);
    if (ok.length) addPicked(ok);
    else setError(i18n.t("addSource.sampleFailed"));
  };

  /** Send every file in the list, a few at a time; the screen hears about them once all are in. */
  const upload = async () => {
    if (!files.length) return;
    setError("");
    setNotice("");
    setBusy(true);
    uploading.current = true;
    const done: { source: Source; job: Job }[] = [];
    const failed: Picked[] = [];
    const results = await sourcesApi.importFiles(files.map((f) => f.upload), notebookId);
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        track("source_add", { source_type: "file" });
        done.push({ source: r.value.source, job: r.value.job });
      } else failed.push(files[i]);
    });
    setBusy(false);
    uploading.current = false;
    setFiles(failed);
    if (failed.length) setError(i18n.t("addSource.uploadFailed", { count: failed.length }));
    else setNotice(i18n.t("addSource.uploading", { count: done.length }));
    done.forEach((d) => onAdded(d.source, d.job));
    if (done.length) void queryClient.invalidateQueries({ queryKey: ["settings", "usage"] });
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
        placeholder={compact ? i18n.t("addSource.pasteShort") : i18n.t("addSource.pasteLong")}
        placeholderTextColor={colors.text3}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={connect}
        accessibilityLabel={i18n.t("addSource.linkLabel")}
      />
      {samples ? (
        <Text style={styles.sample}>
          <Trans
            i18nKey="addSource.sampleLine"
            components={[
              <Text
                key="link"
                style={styles.sampleLink}
                accessibilityRole="button"
                onPress={() => {
                  if (busy) return;
                  setValue(SAMPLE_LINK);
                  setOverride(null);
                }}
              />,
            ]}
          />
        </Text>
      ) : null}
      <Pressable
        onPress={connect}
        disabled={busy || !link}
        accessibilityRole="button"
        style={[styles.connect, (busy || !link) && styles.connectOff]}>
        <Text style={[styles.connectText, (busy || !link) && styles.connectTextOff]}>
          {busy ? (mode === "feed" ? i18n.t("addSource.finding") : i18n.t("addSource.working")) : mode === "feed" ? i18n.t("addSource.connect") : i18n.t("addSource.importArticle")}
        </Text>
      </Pressable>
      {!link ? (
        <Text style={styles.body}>
          {compact ? i18n.t("addSource.hintShort") : i18n.t("addSource.hintLong")}
        </Text>
      ) : mode === "feed" ? (
        <Text style={styles.body}>
          {i18n.t("addSource.feedBody")}{" "}
          <Text style={styles.link} onPress={() => setOverride("url")}>
            {i18n.t("addSource.justPage")}
          </Text>
        </Text>
      ) : (
        <Text style={styles.body}>
          {i18n.t("addSource.pageBody")}{" "}
          <Text style={styles.link} onPress={() => setOverride("feed")}>
            {i18n.t("addSource.wholeSite")}
          </Text>
        </Text>
      )}
      {examples && examples.length > 0 && !link ? (
        <View>
          {examples.map((row, r) => (
            <Text key={r} style={styles.examples}>
              {r === 0 ? i18n.t("addSource.try") : "     "}
              {row.map((x, i) => (
                <Text key={x}>
                  {i > 0 ? ", " : null}
                  <Text onPress={() => setValue(x)} accessibilityRole="button" style={styles.exampleText}>
                    {x}
                  </Text>
                </Text>
              ))}
              {r < examples.length - 1 ? "," : null}
            </Text>
          ))}
        </View>
      ) : null}
      {verdict.kind !== "ok" ? (
        <Text style={verdict.kind === "blocked" ? styles.blocked : styles.warn}>{verdict.message}</Text>
      ) : null}
    </>
  );

  const uploadPanel = (
    <>
      <Pressable onPress={pick} disabled={busy} accessibilityRole="button" style={({ pressed }) => [styles.drop, roomy && styles.dropRoomy, (busy || pressed) && styles.off]}>
        <UploadIcon size={22} color={colors.blue} />
        <Text style={styles.dropTitle}>{files.length ? i18n.t("addSource.addMore") : i18n.t("addSource.choose")}</Text>
        <Text style={styles.dropHint}>{i18n.t("addSource.types", { max: MAX_SOURCE_FILE_LABEL })}</Text>
        {room !== null ? <Text style={styles.dropHint}>{i18n.t("addSource.room", { count: room })}</Text> : null}
      </Pressable>
      {samples ? (
        <Text style={styles.sample}>
          <Trans
            i18nKey="addSource.sampleDocs"
            values={{ n: SAMPLE_DOCUMENTS.length }}
            components={[<Text key="docs" style={styles.sampleLink} accessibilityRole="button" onPress={() => !busy && void addSample()} />]}
          />
        </Text>
      ) : null}
      {files.length > 0 ? (
        <View style={styles.fileList}>
          {files.map((f) => (
            <View key={f.uri} style={styles.fileRow}>
              <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">
                {f.name}
              </Text>
              {f.size ? <Text style={styles.fileSize}>{sizeLabel(f.size)}</Text> : null}
              {f.preview ? (
                <Pressable
                  onPress={() => void WebBrowser.openBrowserAsync(f.preview!, { controlsColor: colors.blue })}
                  hitSlop={10}
                  accessibilityRole="link"
                  accessibilityLabel={i18n.t("addSource.preview", { name: f.name })}>
                  <EyeIcon size={16} color={colors.text2} />
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => setFiles((list) => list.filter((x) => x.uri !== f.uri))}
                disabled={busy}
                hitSlop={10}
                style={busy && styles.off}
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                accessibilityLabel={i18n.t("addSource.removeNamed", { name: f.name })}>
                <CloseIcon size={14} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <Pressable
        onPress={upload}
        disabled={busy || !files.length}
        accessibilityRole="button"
        style={[styles.connect, (busy || !files.length) && styles.connectOff]}>
        <Text style={[styles.connectText, (busy || !files.length) && styles.connectTextOff]}>
          {busy ? i18n.t("common.uploading") : files.length === 1 ? i18n.t("addSource.uploadOne") : files.length ? i18n.t("addSource.uploadMany", { count: files.length }) : i18n.t("addSource.uploadFiles")}
        </Text>
      </Pressable>
    </>
  );

  return (
    <View style={[styles.card, compact && styles.compact]}>
      {/* Link and Upload side by side (web: ADD_SOURCE_METHODS; NotebookLM needs Chrome on a computer, so not here) */}
      <View style={styles.methods} accessibilityRole="tablist">
        {(initialMethod === "upload" ? [...METHODS].reverse() : METHODS).map(([id, label]) => {
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
  sample: { alignSelf: "flex-start", marginTop: -4, color: colors.text3, fontSize: 14 },
  sampleLink: { color: colors.text, textDecorationLine: "underline", textDecorationColor: colors.blue },
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
  dropRoomy: { paddingVertical: 44, gap: 9 },
  dropTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  dropHint: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5 },
  connect: { alignItems: "center", paddingHorizontal: 24, paddingVertical: 9, borderRadius: 999, backgroundColor: colors.blue },
  connectOff: { backgroundColor: "rgba(33, 124, 255, 0.35)" },
  connectText: { color: colors.white, fontSize: 16, fontWeight: "600" },
  connectTextOff: { color: "rgba(255, 255, 255, 0.55)" },
  examples: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 },
  exampleText: { color: colors.text2 },
  off: { opacity: 0.45 },
  fileList: { gap: 6 },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  fileName: { flex: 1, color: colors.text, fontFamily: fonts.mono, fontSize: 13 },
  fileSize: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12 },
  blocked: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  warn: { color: "#f5b041", fontSize: 14, lineHeight: 20 },
});

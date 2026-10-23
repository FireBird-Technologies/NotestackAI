import { ApiError, type UploadSource } from "@notestack/shared/client";
import { docsApi, jobsApi, sourcesApi } from "@notestack/shared/endpoints";
import type { Doc, Job, Source } from "@notestack/shared/types";
import { classifyUrl, looksLikeArticle } from "@notestack/shared/urlScrapability";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { File } from "expo-file-system";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { SourcesNav } from "@/sources-nav";
import { Starfield } from "@/starfield";
import { colors, fonts, gutter } from "@/theme";
import { Body, Centered, ErrorText, Loading, formatDate } from "@/ui";
import { CARD_RADIUS, JobProgress, Pager, StatusPill } from "@/widgets";

const PAGE = 10; // posts on one page of the list, as on the web
const FILE_TYPES = /\.(md|markdown|txt|vtt|html?|pdf)$/i;

/** Sources, as the web page: add a link or files, the connected sources, then every post with search and pages. */
export default function Sources() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [jobs, setJobs] = useState<Record<string, Job>>({});

  // A new search starts on its first page, shortly after typing stops.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q);
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const sources = useQuery({ queryKey: ["sources"], queryFn: sourcesApi.list });
  const docs = useQuery({
    queryKey: ["docs", "sources", search, page],
    queryFn: () => docsApi.list({ q: search, indexed_only: true, sort: "added", limit: PAGE, offset: page * PAGE }),
  });
  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["sources"] });
    void queryClient.invalidateQueries({ queryKey: ["docs"] });
  }, [queryClient]);

  const watch = useCallback((sourceId: string, job: Job) => setJobs((j) => ({ ...j, [sourceId]: job })), []);

  // Pick up syncs and imports that were already running when the page opened.
  useEffect(() => {
    jobsApi
      .active()
      .then((active) => {
        for (const job of active) {
          if (typeof job.params.source_id === "string" && ["ingest", "import_url", "import_upload"].includes(job.kind)) {
            watch(job.params.source_id, job);
          }
        }
      })
      .catch(() => undefined);
  }, [watch]);

  // While anything runs, follow its job and refresh the counts, so posts show up as they arrive.
  const running = Object.entries(jobs).filter(([, j]) => j.status === "queued" || j.status === "running");
  const runningKey = running.map(([id, j]) => `${id}:${j.id}`).join(",");
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  useEffect(() => {
    if (!runningKey) return;
    const t = setInterval(async () => {
      for (const [sourceId, job] of Object.entries(jobsRef.current)) {
        if (job.status !== "queued" && job.status !== "running") continue;
        const next = await jobsApi.get(job.id).catch(() => null);
        if (next) watch(sourceId, next);
      }
      reload();
    }, 3000);
    return () => clearInterval(t);
  }, [runningKey, reload, watch]);

  const added = (source: Source, job: Job) => {
    watch(source.id, job);
    reload();
  };

  if (sources.isPending) return <Loading />;
  if (sources.error && !sources.data) {
    return (
      <Centered>
        <Body muted>Could not load your sources. Pull to try again.</Body>
      </Centered>
    );
  }

  const list = sources.data ?? [];
  const total = docs.data?.total ?? 0;

  return (
    <View style={styles.fill}>
      <Starfield />
      <ScrollView
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={sources.isRefetching} onRefresh={reload} tintColor={colors.blue} />}>
        <SourcesNav current="posts" />

        <Text style={styles.eyebrow}>Sources</Text>
        <Text style={styles.title} accessibilityRole="header">
          Your knowledge, in orbit
        </Text>

        <AddSource onAdded={added} />

        {list.map((s) => (
          <SourceCard key={s.id} source={s} job={jobs[s.id]} onSync={watch} onRemoved={reload} />
        ))}
        {list.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>No sources yet</Text>
            <Text style={styles.body}>
              A lone satellite, waiting for signal. Connect a blog or site above, or upload your markdown files.
            </Text>
          </View>
        ) : null}

        {list.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.postsTitle}>
              Posts <Text style={styles.postsCount}>{total}</Text>
            </Text>
            <TextInput
              style={styles.search}
              value={q}
              onChangeText={setQ}
              placeholder="Search titles and text"
              placeholderTextColor={colors.text3}
              clearButtonMode="while-editing"
              autoCapitalize="none"
              accessibilityLabel="Search posts"
            />
            {(docs.data?.items ?? []).map((d) => (
              <PostRow key={d.id} doc={d} onRemoved={reload} />
            ))}
            {docs.data && docs.data.items.length === 0 ? <Body muted>No posts match.</Body> : null}
            {docs.isPending ? <Loading /> : null}
            <Pager page={page} pages={Math.ceil(total / PAGE)} onChange={setPage} />
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** One box for everything: paste a link (feed or article is worked out for you) or add files. */
function AddSource({ onAdded }: { onAdded: (source: Source, job: Job) => void }) {
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
      const res = mode === "feed" ? await sourcesApi.connect(link) : await sourcesApi.importUrl(link);
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
        const res = await sourcesApi.importFile(f as unknown as UploadSource);
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
    <View style={styles.card}>
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
        <Text style={styles.body}>
          Substack, Ghost, WordPress, Medium or any site with a feed. Markdown, text, VTT transcripts, HTML and PDF files
          work too.
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
      {verdict.kind !== "ok" ? (
        <Text style={verdict.kind === "blocked" ? styles.blocked : styles.warn}>{verdict.message}</Text>
      ) : null}
      <ErrorText>{error}</ErrorText>
      {notice ? <Text style={styles.body}>{notice}</Text> : null}
    </View>
  );
}

function SourceCard({
  source: s,
  job,
  onSync,
  onRemoved,
}: {
  source: Source;
  job?: Job;
  onSync: (sourceId: string, job: Job) => void;
  onRemoved: () => void;
}) {
  const active = Boolean(job && (job.status === "queued" || job.status === "running"));
  const failed = !active && (s.sync_status === "error" || job?.status === "failed");
  const posts = Math.max(s.document_count - s.locked_count, 0);

  const remove = () =>
    Alert.alert("Delete this source?", s.title ?? s.feed_url, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await sourcesApi.remove(s.id);
          onRemoved();
        },
      },
    ]);

  return (
    <View style={styles.card}>
      <View style={styles.sourceHead}>
        <View style={styles.sourceTitle}>
          <Text style={styles.cardTitle}>{s.title ?? s.feed_url}</Text>
          <Text style={styles.mono}>
            {s.is_imports ? "imports" : s.platform} · {posts} posts
            {s.last_synced_at ? ` · synced ${formatDate(s.last_synced_at, true)}` : ""}
          </Text>
        </View>
        {s.is_imports ? <StatusPill status={active ? "syncing" : s.sync_status} /> : null}
      </View>
      {!s.is_imports ? <StatusPill status={active ? "syncing" : s.sync_status} /> : null}
      {!s.is_imports ? (
        <Text
          style={styles.mono}
          numberOfLines={1}
          onPress={() => WebBrowser.openBrowserAsync(s.site_url ?? s.feed_url.replace(/^site:/, ""))}>
          {s.feed_url.replace(/^site:/, "")}
        </Text>
      ) : null}
      {job && (active || job.status === "failed") ? <JobProgress job={job} /> : null}
      {s.locked_count > 0 && !active ? (
        <View style={styles.locked}>
          <Text style={styles.lockedTitle}>{s.locked_count} posts not indexed</Text>
          <Text style={styles.body}>Your plan only indexes your latest posts.</Text>
        </View>
      ) : null}
      {s.sync_status === "error" && s.sync_error && !active ? <ErrorText>{s.sync_error}</ErrorText> : null}
      {!s.is_imports ? (
        <View style={styles.sourceActions}>
          <Pressable
            disabled={active}
            accessibilityRole="button"
            style={[styles.outline, active && styles.off]}
            onPress={async () => {
              const res = await sourcesApi.sync(s.id);
              onSync(s.id, res.job);
            }}>
            <Text style={styles.outlineText}>Sync now</Text>
          </Pressable>
          {failed ? (
            <Pressable accessibilityRole="button" style={[styles.outline, styles.danger]} onPress={remove}>
              <Text style={[styles.outlineText, styles.dangerText]}>Delete</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function PostRow({ doc: d, onRemoved }: { doc: Doc; onRemoved: () => void }) {
  const remove = () =>
    Alert.alert("Delete this post?", d.title, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await docsApi.remove(d.id);
          onRemoved();
        },
      },
    ]);
  return (
    <View style={styles.postRow}>
      <View style={styles.postText}>
        <Text
          style={styles.postTitle}
          accessibilityRole="link"
          onPress={() => router.push({ pathname: "/sources/post/[id]", params: { id: d.id } })}>
          {d.title}
        </Text>
        <Text style={styles.mono}>
          {d.locked ? "Not indexed · " : ""}
          {d.source_title ?? ""} · {formatDate(d.published_at)} · {d.words} words
        </Text>
      </View>
      <Pressable onPress={remove} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Delete ${d.title}`}>
        <SymbolView name={{ ios: "trash", android: "delete" }} size={18} tintColor={colors.text2} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.black },
  page: { padding: gutter * 1.25, paddingBottom: gutter * 3, gap: 14 },
  eyebrow: {
    color: colors.blue,
    fontFamily: fonts.mono,
    fontSize: 12.5,
    letterSpacing: 3,
    textTransform: "uppercase",
    marginTop: 6,
  },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  card: {
    gap: 12,
    padding: gutter * 1.25,
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(12, 12, 12, 0.92)",
  },
  cardTitle: { color: colors.text, fontSize: 20, fontWeight: "600" },
  body: { color: colors.text2, fontSize: 16, lineHeight: 23 },
  mono: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13, lineHeight: 20 },
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
  danger: { borderColor: "rgba(255, 107, 107, 0.5)" },
  dangerText: { color: colors.danger },
  blocked: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  warn: { color: "#f5b041", fontSize: 14, lineHeight: 20 },
  sourceHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  sourceTitle: { flex: 1, gap: 4 },
  sourceActions: { flexDirection: "row", gap: 10 },
  locked: { gap: 4, padding: 12, borderRadius: 10, backgroundColor: colors.blue10 },
  lockedTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  postsTitle: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 24 },
  postsCount: { color: colors.text3, fontFamily: fonts.mono, fontSize: 16 },
  search: {
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  postRow: {
    flexDirection: "row",
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  postText: { flex: 1, gap: 6 },
  postTitle: {
    color: colors.text,
    fontSize: 17,
    lineHeight: 25,
    textDecorationLine: "underline",
    textDecorationColor: colors.blue,
  },
});

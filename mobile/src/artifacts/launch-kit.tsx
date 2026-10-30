import { ApiError } from "@notestack/shared/client";
import { artifactsApi, launchpadApi } from "@notestack/shared/endpoints";
import type { Artifact, LaunchKitContent } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { Composer } from "@/launchpad/editors";
import { colors, fonts, gutter, radius } from "@/ui/theme";
import { ErrorText, formatDate, Loading } from "@/ui";
import { BackLink } from "@/video/back";
import { confirm, JobProgress, Page, PillButton, Sheet, StatusPill } from "@/ui/widgets";

/** LinkedIn's limit for one post. */
const LIMIT = 3000;

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <PillButton
      small
      title={done ? "Copied" : "Copy"}
      onPress={async () => {
        await Clipboard.setStringAsync(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    />
  );
}

const working = (k: Artifact) => k.status === "generating" || k.status === "pending" || k.job?.status === "queued" || k.job?.status === "running";

/**
 * A Launch Kit's page (web: pages/LaunchKit.tsx, /app/launchpad/kits/:id): its progress while it is being written, then
 * the LinkedIn post to edit, copy and schedule, and its hooks, strongest first, each of which can go out on its own.
 */
export function LaunchKitView({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const kitQuery = useQuery({
    queryKey: ["artifact", id],
    queryFn: () => artifactsApi.get(id),
    // While it is being written: its job's progress for the bar, until it is ready or failed.
    refetchInterval: (q) => (q.state.data && working(q.state.data) ? 2000 : false),
  });
  if (!kitQuery.data) {
    return (
      <Page>
        <BackLink fallback="/launchpad" />
        {kitQuery.error ? <ErrorText>{kitQuery.error.message}</ErrorText> : <Loading />}
      </Page>
    );
  }
  // Keyed by status: the post editor starts from the written kit once it is ready.
  return <KitBody key={kitQuery.data.status} kit={kitQuery.data} onSaved={(k) => queryClient.setQueryData(["artifact", id], k)} />;
}

function KitBody({ kit, onSaved }: { kit: Artifact; onSaved: (k: Artifact) => void }) {
  const queryClient = useQueryClient();
  const c = (kit.content ?? {}) as LaunchKitContent;
  const [posts, setPosts] = useState<string[]>(c.posts?.linkedin ?? []);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [schedule, setSchedule] = useState<string | null>(null);
  const accounts = useQuery({ queryKey: ["launchpad", "accounts"], queryFn: launchpadApi.accounts, enabled: schedule !== null });
  const title = c.post_title ?? kit.title;
  const running = working(kit);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      onSaved(await artifactsApi.update(kit.id, { content: { posts: { ...c.posts, linkedin: posts } } }));
      setDirty(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the edits. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const remove = () =>
    confirm(
      "Delete launch kit?",
      "Delete",
      () => {
        artifactsApi.remove(kit.id).then(
          () => {
            void queryClient.invalidateQueries({ queryKey: ["launchpad"] });
            void queryClient.invalidateQueries({ queryKey: ["library"] });
            if (router.canGoBack()) router.back();
            else router.replace("/launchpad/kits");
          },
          (e: unknown) => setError(e instanceof ApiError ? e.message : "Could not delete it. Try again."),
        );
      },
      title,
    );

  return (
    <Page>
      <BackLink fallback="/launchpad" />
      <View style={styles.section}>
        <Text style={styles.eyebrow}>LAUNCH KIT</Text>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        <Text style={styles.date}>{formatDate(kit.created_at, true)}</Text>
        <View style={styles.row}>
          <StatusPill status={running ? "working" : kit.status} />
          <PillButton small title="Delete" onPress={remove} />
        </View>
        {kit.job && (running || kit.status === "failed") ? <JobProgress job={kit.job} /> : null}
        <ErrorText>{error}</ErrorText>

        {kit.status === "ready" ? (
          <>
            <View style={styles.rule} />
            <Text style={styles.h}>LinkedIn post</Text>
            <Text style={styles.muted}>The full post, written from the article. Edit it here, then schedule it.</Text>
            {posts.map((p, i) => (
              <View key={i} style={styles.post}>
                <Text style={[styles.count, p.length > LIMIT && styles.over]}>
                  {p.length} / {LIMIT}
                </Text>
                <TextInput
                  style={styles.input}
                  value={p}
                  multiline
                  scrollEnabled
                  textAlignVertical="top"
                  onChangeText={(v) => {
                    setPosts(posts.map((x, j) => (j === i ? v : x)));
                    setDirty(true);
                  }}
                  accessibilityLabel="LinkedIn post"
                />
                <View style={styles.row}>
                  <CopyButton text={p} />
                  {/* Just this post, as it reads on screen, saved or not */}
                  <PillButton small title="Schedule" onPress={() => setSchedule(p)} />
                  {dirty ? <PillButton small variant="primary" title={saving ? "Saving..." : "Save edits"} busy={saving} onPress={() => void save()} /> : null}
                </View>
              </View>
            ))}

            {(c.hooks?.length ?? 0) > 0 ? (
              <>
                <View style={styles.rule} />
                <Text style={styles.h}>Hooks</Text>
                <Text style={styles.muted}>{c.hooks.length} short lines to lead with, strongest first. Each can go out on its own.</Text>
                {c.hooks.map((h, i) => (
                  <View key={i} style={styles.hook}>
                    <View style={styles.between}>
                      <Text style={styles.hookNum}>Hook {i + 1}</Text>
                      <Text style={styles.strength}>strength {Math.round(h.strength * 100)}</Text>
                    </View>
                    <Text style={styles.hookText}>{h.text}</Text>
                    <Text style={styles.muted}>{h.rationale}</Text>
                    <View style={styles.row}>
                      <CopyButton text={h.text} />
                      <PillButton small title="Schedule" onPress={() => setSchedule(h.text)} />
                    </View>
                  </View>
                ))}
              </>
            ) : null}
          </>
        ) : null}
      </View>

      <Sheet visible={schedule !== null} title="New post" onClose={() => setSchedule(null)}>
        {schedule !== null ? (
          <Composer
            at={null}
            initialText={schedule}
            kit={{ id: kit.id, title, documentId: kit.document_id ?? null }}
            accounts={accounts.data ?? null}
            onAccounts={(x) => queryClient.setQueryData(["launchpad", "accounts"], x)}
            onCancel={() => setSchedule(null)}
            onDone={() => {
              setSchedule(null);
              void queryClient.invalidateQueries({ queryKey: ["launchpad"] });
            }}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12, padding: gutter * 1.25, borderRadius: radius.md + 2, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(12, 12, 12, 0.92)" },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 3 },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 24, lineHeight: 30 },
  date: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong, marginVertical: 6 },
  h: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 24 },
  muted: { color: colors.text2, fontSize: 15, lineHeight: 22 },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  post: { gap: 8, padding: gutter * 0.75, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  count: { alignSelf: "flex-end", color: colors.text2, fontFamily: fonts.mono, fontSize: 13 },
  over: { color: colors.danger },
  input: {
    height: 320,
    color: colors.text,
    fontSize: 16,
    lineHeight: 23,
    padding: 14,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.black,
  },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  hook: { gap: 10, padding: gutter * 0.9, borderRadius: radius.md, borderWidth: 1, borderLeftWidth: 3, borderColor: colors.line, borderLeftColor: colors.blue20 },
  hookNum: { color: colors.blue, fontFamily: fonts.mono, fontSize: 13.5 },
  strength: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13 },
  hookText: { color: colors.white, fontSize: 17, lineHeight: 26, fontWeight: "500" },
});

import { ApiError } from "@notestack/shared/client";
import { launchpadApi, videosApi } from "@notestack/shared/endpoints";
import type { VideoListItem } from "@notestack/shared/types";
import { BUSY, shortUrl, statusOf } from "@notestack/shared/video";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { RocketIcon, TrashIcon } from "@/ui/icons";
import { Composer } from "@/launchpad/editors";
import { colors, fonts, radius } from "@/ui/theme";
import { formatDate, Loading } from "@/ui";
import { useUpgrade } from "@/account/upgrade";
import { Dialog, Pager, PillButton, Sheet } from "@/ui/widgets";

import { vstyles } from "./ui";

const PAGE = 10;

/**
 * Library → Videos, as the web's (pages/Videos.tsx): the allowance and New video, then each video as a row (its status,
 * source, scenes and date) that opens its editor, with Launch once it is complete and Delete. Ten at a time; while one
 * is still changing, the list asks again every 15 seconds.
 */
export function VideosList() {
  const queryClient = useQueryClient();
  const upgrade = useUpgrade();
  const [page, setPage] = useState(0);
  const [deleting, setDeleting] = useState<VideoListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [launching, setLaunching] = useState<string | null>(null);
  const quota = useQuery({ queryKey: ["videos", "quota"], queryFn: videosApi.quota });
  const list = useQuery({
    queryKey: ["videos", "list", page],
    queryFn: () => videosApi.list({ limit: PAGE, offset: page * PAGE }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((v) => BUSY.has(v.status) || BUSY.has(v.b2v_status ?? "")) ? 15_000 : false),
  });
  const accounts = useQuery({ queryKey: ["launchpad", "accounts"], queryFn: launchpadApi.accounts, enabled: launching !== null });
  // Another page: the loader until it arrives, never the last page meanwhile.
  const videos = list.isPlaceholderData ? null : (list.data?.items ?? null);
  const total = list.data?.total ?? 0;
  const q = quota.data;
  const out = !!q && q.used >= q.limit;

  /** Stays open (and loading) until the delete finishes; a failure shows in the dialog so it can be retried. */
  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    setDeleteError("");
    try {
      await videosApi.remove(deleting.id);
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: ["videos"] });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    } catch (e) {
      setDeleteError(e instanceof ApiError ? e.message : "Could not delete it. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={vstyles.stack}>
      <View style={styles.head}>
        <Text style={styles.quota}>
          {q ? `${q.used} of ${q.limit} video${q.limit === 1 ? "" : "s"} used${q.resets_at ? ` this period, refills ${formatDate(q.resets_at)}` : " on your plan"}` : ""}
        </Text>
        {out ? (
          <PillButton small variant="primary" title="Get more videos" onPress={() => upgrade({ highlight: q?.plan === "writer" ? "studio" : "writer" })} />
        ) : (
          <PillButton small variant="primary" title="New video" onPress={() => router.push("/library/videos/new")} />
        )}
      </View>
      {list.error && !list.data ? <Text style={vstyles.error}>{list.error.message}</Text> : null}
      {!videos && !list.error ? <Loading /> : null}
      {videos?.length === 0 ? (
        <View style={styles.empty}>
          <Text style={vstyles.h3}>No videos yet</Text>
          <Text style={vstyles.muted}>Turn a post or any article link into a narrated video, then edit it scene by scene.</Text>
          <PillButton variant="primary" title="Make your first video" onPress={() => router.push("/library/videos/new")} />
        </View>
      ) : null}
      {videos?.map((v) => {
        const st = statusOf(v);
        const source = shortUrl(v.source_url);
        return (
          <View key={v.id} style={styles.row}>
            <Pressable onPress={() => router.push({ pathname: "/library/videos/[id]", params: { id: v.id } })} accessibilityRole="button" style={({ pressed }) => [styles.main, pressed && styles.pressed]}>
              <Text style={styles.title} numberOfLines={2}>
                {v.title}
              </Text>
              <View style={vstyles.row}>
                <View style={[styles.dot, st.tone === "failed" && styles.dotFailed]} />
                <Text style={[vstyles.muted, vstyles.small]}>{st.label}</Text>
              </View>
              <Text style={styles.meta}>{[source, v.scenes ? `${v.scenes} scene${v.scenes === 1 ? "" : "s"}` : null, v.created_at ? formatDate(v.created_at) : null].filter(Boolean).join(" · ")}</Text>
            </Pressable>
            <View style={styles.actions}>
              {st.tone === "done" ? (
                <Pressable onPress={() => setLaunching(v.id)} accessibilityRole="button" accessibilityLabel={`Launch ${v.title}`} style={styles.icon}>
                  <RocketIcon size={16} />
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => {
                  setDeleteError("");
                  setDeleting(v);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${v.title}`}
                style={styles.icon}>
                <TrashIcon size={16} />
              </Pressable>
            </View>
          </View>
        );
      })}
      <Pager page={page} pages={Math.ceil(total / PAGE)} onChange={setPage} />

      {/* While the delete runs, the backdrop and the close button do nothing */}
      <Dialog visible={deleting !== null} title="Delete this video?" onClose={busy ? () => undefined : () => setDeleting(null)}>
        <Text style={vstyles.body}>
          &quot;<Text style={vstyles.strong}>{deleting?.title}</Text>&quot; will be deleted permanently. This can&apos;t be undone.
        </Text>
        {deleteError ? <Text style={vstyles.error}>{deleteError}</Text> : null}
        <View style={vstyles.end}>
          <PillButton small title="Cancel" disabled={busy} onPress={() => setDeleting(null)} />
          <PillButton small variant="danger" title={busy ? "Deleting..." : "Delete video"} busy={busy} onPress={() => void confirmDelete()} />
        </View>
      </Dialog>
      <Sheet visible={launching !== null} title="New post" onClose={() => setLaunching(null)}>
        {launching !== null ? (
          <Composer
            at={null}
            artifactId={launching}
            accounts={accounts.data ?? null}
            onAccounts={(x) => queryClient.setQueryData(["launchpad", "accounts"], x)}
            onCancel={() => setLaunching(null)}
            onDone={() => {
              setLaunching(null);
              void queryClient.invalidateQueries({ queryKey: ["launchpad"] });
            }}
          />
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" },
  quota: { flex: 1, minWidth: 160, color: colors.text2, fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 18 },
  empty: { gap: 10, alignItems: "flex-start", paddingVertical: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 16, paddingHorizontal: 18, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(16, 17, 20, 0.92)" },
  main: { flex: 1, gap: 6 },
  pressed: { opacity: 0.75 },
  title: { color: colors.text, fontSize: 16.5, fontWeight: "700", lineHeight: 22 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.blue },
  dotFailed: { backgroundColor: "#ef4444" },
  meta: { color: colors.text3, fontSize: 13 },
  actions: { flexDirection: "row", gap: 6 },
  icon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.lineStrong },
});

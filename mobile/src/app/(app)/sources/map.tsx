import { ApiError } from "@notestack/shared/client";
import { artifactsApi, jobsApi, notebooksApi, topicsApi } from "@notestack/shared/endpoints";
import { layout } from "@notestack/shared/topicLayout";
import type { Job, TopicDetail, TopicMap } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useMemo, useState } from "react";
import { ActionSheetIOS, Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, useWindowDimensions, View } from "react-native";

import { Segments, SourcesNav } from "@/sources/sources-nav";
import { Starfield } from "@/shell/starfield";
import { colors, fonts, gutter } from "@/ui/theme";
import { STATUS_LABEL, Sparkline, StarMap, type ColorMode } from "@/sources/topic-map";
import { Body, Button, ErrorText, Loading, formatDate } from "@/ui";
import { CARD_RADIUS, JobProgress } from "@/ui/widgets";

function momentumText(m: number) {
  if (!Number.isFinite(m) || m === 0) return "no recent posts";
  return m >= 1 ? `${m.toFixed(1)}x its usual share lately` : `${Math.round(m * 100)}% of its usual share lately`;
}

/** The constellations in the archive (web: pages/TopicMap.tsx): the map, the briefing, and a topic's details. */
export default function TopicMapScreen() {
  const queryClient = useQueryClient();
  const { height: screenH } = useWindowDimensions();
  const [mode, setMode] = useState<ColorMode>("recency");
  const [briefing, setBriefing] = useState(false);
  const [selected, setSelected] = useState<TopicDetail | null>(null);
  const [focusId, setFocusId] = useState<{ id: string; at: number } | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");

  const map = useQuery<TopicMap>({ queryKey: ["topics"], queryFn: topicsApi.map });
  const data = map.data;
  const placed = useMemo(() => (data?.nodes.length ? layout(data) : new Map()), [data]);
  const running = Boolean(job && (job.status === "queued" || job.status === "running"));

  // Follow a rebuild until it ends, then load the new map.
  useEffect(() => {
    if (!job || !running) return;
    const t = setInterval(async () => {
      const next = await jobsApi.get(job.id).catch(() => null);
      if (!next) return;
      setJob(next);
      if (next.status === "done") void queryClient.invalidateQueries({ queryKey: ["topics"] });
    }, 2500);
    return () => clearInterval(t);
  }, [job, running, queryClient]);

  const rebuild = async (full: boolean) => {
    setError("");
    try {
      setJob(await topicsApi.rebuild(full));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not start the rebuild. Try again.");
    }
  };

  const options = () => {
    const confirm = () => void rebuild(true);
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["Rebuild the whole map", "Cancel"], cancelButtonIndex: 1, userInterfaceStyle: "dark" },
        (i) => i === 0 && confirm(),
      );
    } else {
      Alert.alert("Map options", undefined, [
        { text: "Rebuild the whole map", onPress: confirm },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  };

  /** Show a topic's details, and centre the map on it when picked from the briefing. */
  const open = async (id: string, center = false) => {
    if (center) setFocusId({ id, at: Date.now() });
    try {
      setSelected(await topicsApi.get(id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load that topic.");
    }
  };

  const recentBucket = useMemo(() => {
    const a = data?.archive;
    if (!a?.start || !a.end || !a.recent_from) return undefined;
    const span = +new Date(a.end) - +new Date(a.start) || 1;
    return Math.floor(((+new Date(a.recent_from) - +new Date(a.start)) / span) * 12);
  }, [data]);

  const galaxies = data ? data.galaxies.filter((g) => g.size > 1) : [];

  return (
    <View style={styles.fill}>
      <Starfield />
      <ScrollView contentContainerStyle={styles.page}>
        <SourcesNav current="map" />
        <Text style={styles.eyebrow}>Topic map</Text>
        <Text style={styles.title} accessibilityRole="header">
          The constellations in your archive
        </Text>

        <View style={styles.toolbar}>
          <Segments
            options={[
              { id: "recency", label: "Recency" },
              { id: "momentum", label: "Momentum" },
            ]}
            value={mode}
            onChange={setMode}
          />
          {data && data.nodes.length > 0 ? (
            <View style={styles.switchRow}>
              <Switch
                value={briefing}
                onValueChange={setBriefing}
                trackColor={{ false: colors.surface2, true: colors.blue }}
                thumbColor={colors.white}
                accessibilityLabel="Briefing"
              />
              <Text style={[styles.switchLabel, briefing && styles.switchLabelOn]}>Briefing</Text>
            </View>
          ) : null}
          <Pressable onPress={options} hitSlop={10} accessibilityRole="button" accessibilityLabel="Map options" style={styles.more}>
            <Text style={styles.moreText}>⋯</Text>
          </Pressable>
        </View>
        {data?.has_untagged_posts ? (
          <Pressable disabled={running} onPress={() => rebuild(false)} style={[styles.outline, running && styles.off]}>
            <Text style={styles.outlineText}>Map new posts</Text>
          </Pressable>
        ) : null}

        {job && (running || job.status === "failed") ? <JobProgress job={job} /> : null}
        <ErrorText>{error}</ErrorText>
        {map.isPending ? <Loading /> : null}
        {map.error && !data ? <ErrorText>Could not load the topic map.</ErrorText> : null}

        {data && data.nodes.length === 0 && !running ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>No constellations yet</Text>
            <Body muted>
              Notestack reads each post and names what it is about, then links topics that appear together. New posts are
              mapped automatically after each sync.
            </Body>
            <Button title="Map my archive" onPress={() => rebuild(false)} />
          </View>
        ) : null}

        {data && data.nodes.length > 0 ? (
          <StarMap
            data={data}
            placed={placed}
            mode={mode}
            selectedId={selected?.id ?? null}
            focusId={focusId}
            onSelect={(id) => void open(id)}
            height={Math.min(620, Math.max(420, screenH * 0.62))}
          />
        ) : null}

        {data && selected ? (
          <TopicCard
            topic={selected}
            recentBucket={recentBucket}
            acting={acting}
            closeLabel={briefing ? "Back to briefing" : "Close"}
            onClose={() => setSelected(null)}
            onOpen={(id) => void open(id, true)}
            onAudio={async () => {
              setActing("audio");
              try {
                const nb = await notebooksApi.fromTopic(selected.id);
                await artifactsApi.generate({ type: "audio_overview", notebook_id: nb.id, format: "deep_dive", minutes: 6 });
                router.navigate({ pathname: "/notebooks/[id]", params: { id: nb.id, title: nb.title } });
              } catch (e) {
                setError(e instanceof ApiError ? e.message : "Could not start the audio overview.");
              } finally {
                setActing(null);
              }
            }}
            onNotebook={async () => {
              setActing("notebook");
              try {
                const nb = await notebooksApi.fromTopic(selected.id);
                router.navigate({ pathname: "/notebooks/[id]", params: { id: nb.id, title: nb.title } });
              } finally {
                setActing(null);
              }
            }}
          />
        ) : null}

        {data && briefing && !selected ? (
          <View style={styles.card}>
            <Text style={styles.eyebrow}>Mission briefing</Text>
            <Text style={styles.body}>
              {data.archive.posts} posts from {formatDate(data.archive.start)} to {formatDate(data.archive.end)}. Recent
              means since {formatDate(data.archive.recent_from)}.
            </Text>

            <Brief title="Galaxies">
              {galaxies.slice(0, 6).map((g) => (
                <Row key={g.id} label={g.name} meta={`${g.size} topics · ${g.post_count} posts`} onPress={() => g.topic_ids[0] && open(g.topic_ids[0], true)} />
              ))}
              {galaxies.length === 0 ? <Text style={styles.body}>No clusters yet. Map more posts.</Text> : null}
            </Brief>

            <Brief title="Rising">
              {data.insights.rising.map((r) => (
                <Row key={r.id} label={r.name} meta={`${r.momentum.toFixed(1)}x`} metaUp onPress={() => open(r.id, true)} />
              ))}
              {data.insights.rising.length === 0 ? <Text style={styles.body}>Nothing is picking up speed right now.</Text> : null}
            </Brief>

            <Brief title="Dormant">
              {data.insights.dormant.map((d) => (
                <Row key={d.id} label={d.name} meta={`since ${formatDate(d.last_at)}`} onPress={() => open(d.id, true)} />
              ))}
              {data.insights.dormant.length === 0 ? <Text style={styles.body}>Every topic has been visited lately.</Text> : null}
              {data.insights.dormant.length > 0 ? (
                <Text style={styles.monoLink} onPress={() => router.navigate("/launchpad")}>
                  Resurface old posts
                </Text>
              ) : null}
            </Brief>

            <Brief title="Strongest pairings" last>
              {data.insights.pairs.map((p) => (
                <View key={`${p.a_id}-${p.b_id}`} style={styles.row}>
                  <Text style={styles.rowLabelWrap}>
                    <Text style={styles.link} onPress={() => open(p.a_id, true)}>
                      {p.a}
                    </Text>
                    <Text style={styles.body}> + </Text>
                    <Text style={styles.link} onPress={() => open(p.b_id, true)}>
                      {p.b}
                    </Text>
                  </Text>
                  <Text style={styles.rowMeta}>{p.posts} posts</Text>
                </View>
              ))}
            </Brief>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Brief({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <View style={[styles.brief, last && styles.briefLast]}>
      <Text style={styles.briefTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, meta, metaUp, onPress }: { label: string; meta: string; metaUp?: boolean; onPress: () => void }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.link, styles.rowLabel]} onPress={onPress} accessibilityRole="link">
        {label}
      </Text>
      <Text style={[styles.rowMeta, metaUp && styles.up]}>{meta}</Text>
    </View>
  );
}

function TopicCard({
  topic: t,
  recentBucket,
  acting,
  closeLabel,
  onClose,
  onOpen,
  onAudio,
  onNotebook,
}: {
  topic: TopicDetail;
  recentBucket?: number;
  acting: string | null;
  closeLabel: string;
  onClose: () => void;
  onOpen: (id: string) => void;
  onAudio: () => void;
  onNotebook: () => void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.monoLink} onPress={onClose}>
        {closeLabel}
      </Text>
      <View style={styles.topicHead}>
        <Text style={styles.cardTitle}>{t.name}</Text>
        <View style={[styles.pill, t.status === "rising" && styles.pillUp, t.status === "dormant" && styles.pillDim]}>
          <Text style={styles.pillText}>{STATUS_LABEL[t.status]}</Text>
        </View>
      </View>
      {t.summary ? <Text style={styles.body}>{t.summary}</Text> : null}
      <View style={styles.stats}>
        {[
          ["Posts", String(t.post_count)],
          ["Recent", String(t.recent_posts)],
          ["First", formatDate(t.first_at)],
          ["Last", formatDate(t.last_at)],
        ].map(([k, v]) => (
          <View key={k} style={styles.stat}>
            <Text style={styles.statKey}>{k}</Text>
            <Text style={styles.statValue}>{v}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.rowMeta}>Momentum: {momentumText(t.momentum)}</Text>
      <Sparkline values={t.timeline} highlightFrom={recentBucket} />
      <View style={styles.row}>
        <Text style={styles.rowMeta}>{formatDate(t.timeline_start)}</Text>
        <Text style={styles.rowMeta}>{formatDate(t.timeline_end)}</Text>
      </View>
      {t.related.length > 0 ? (
        <>
          <Text style={styles.rowMeta}>Travels with</Text>
          <View style={styles.chips}>
            {t.related.map((r) => (
              <Pressable key={r.id} onPress={() => onOpen(r.id)} style={styles.chip}>
                <Text style={styles.chipText}>
                  {r.name} <Text style={styles.chipCount}>{r.shared_posts}</Text>
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      <View style={styles.actions}>
        <Button title={acting === "audio" ? "Starting..." : "Audio about this"} onPress={onAudio} busy={acting === "audio"} disabled={acting !== null} />
        {t.posts[0] ? (
          <Button
            title="Launch Kit for the latest post"
            variant="secondary"
            disabled={acting !== null}
            onPress={() => WebBrowser.openBrowserAsync(`https://notestack.ai/app/launchpad/kits?post=${t.posts[0].id}`)}
          />
        ) : null}
        <Button title="Open as notebook" variant="secondary" onPress={onNotebook} busy={acting === "notebook"} disabled={acting !== null} />
      </View>
      {t.posts.map((d) => (
        <View key={d.id} style={styles.postRow}>
          <Text
            style={[styles.link, styles.rowLabel]}
            onPress={() => router.push({ pathname: "/sources/post/[id]", params: { id: d.id } })}>
            {d.title}
          </Text>
          <Text style={styles.rowMeta}>{formatDate(d.published_at)}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.black },
  page: { padding: gutter * 1.25, paddingBottom: gutter * 3, gap: 14 },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 3, textTransform: "uppercase" },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  toolbar: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  switchLabel: { color: colors.text2, fontSize: 17 },
  switchLabelOn: { color: colors.text },
  more: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  moreText: { color: colors.text2, fontSize: 18, lineHeight: 20 },
  outline: {
    alignSelf: "flex-start",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  outlineText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  off: { opacity: 0.45 },
  card: {
    gap: 12,
    padding: gutter * 1.5,
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(12, 12, 12, 0.92)",
  },
  cardTitle: { color: colors.text, fontSize: 22, fontWeight: "600", flexShrink: 1 },
  body: { color: colors.text2, fontSize: 16, lineHeight: 24 },
  brief: { gap: 10, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line },
  briefLast: {},
  briefTitle: { color: colors.blue, fontFamily: fonts.mono, fontSize: 15, fontWeight: "700", letterSpacing: 2.5, textTransform: "uppercase" },
  row: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 },
  rowLabel: { flexShrink: 1 },
  rowLabelWrap: { flexShrink: 1, fontSize: 17 },
  rowMeta: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13 },
  up: { color: colors.blue },
  link: { color: colors.text, fontSize: 17, textDecorationLine: "underline", textDecorationColor: colors.blue },
  monoLink: { color: colors.text, fontFamily: fonts.mono, fontSize: 14, letterSpacing: 1 },
  topicHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: "rgba(33,124,255,0.5)" },
  pillUp: { borderColor: colors.white },
  pillDim: { borderColor: colors.lineStrong },
  pillText: { color: colors.text2, fontFamily: fonts.mono, fontSize: 12 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  stat: { width: "47%", gap: 2 },
  statKey: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, textTransform: "uppercase", letterSpacing: 1 },
  statValue: { color: colors.text, fontSize: 17 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  chipText: { color: colors.text, fontSize: 14 },
  chipCount: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12 },
  actions: { gap: 8 },
  postRow: { gap: 4, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line },
});

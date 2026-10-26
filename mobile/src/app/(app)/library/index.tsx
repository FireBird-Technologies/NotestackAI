import { artifactsApi } from "@notestack/shared/endpoints";
import type { Artifact, Page } from "@notestack/shared/types";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from "react-native";

import { ArtifactCard, isMaking } from "@/artifact-card";
import { Starfield } from "@/starfield";
import { VideosList } from "@/video/list";
import { colors, fonts, gutter, radius } from "@/theme";
import { Body, Button, Loading } from "@/ui";
import { CARD_RADIUS, Pager } from "@/widgets";

/** The kinds to show, in the web Library's order. "videos" lists the Videos editor's videos. */
const KINDS = [
  { id: "all", label: "All" },
  { id: "report", label: "Reports" },
  { id: "summary", label: "Summaries" },
  { id: "quiz", label: "Quizzes" },
  { id: "flashcards", label: "Flashcards" },
  { id: "mind_map", label: "Mind Constellations" },
  { id: "infographic", label: "Infographics" },
  { id: "slide_deck", label: "Slide decks" },
  { id: "audio_overview", label: "Audio overviews" },
  { id: "videos", label: "Videos" },
] as const;
type Kind = (typeof KINDS)[number]["id"];

const PAGE = 10;

/** Everything made, of one kind or all, searchable, ten at a time (web: pages/Archive.tsx). */
export default function Library() {
  const queryClient = useQueryClient();
  const scroller = useRef<ScrollViewInstance>(null);
  const [kind, setKind] = useState<Kind>("all");
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  // A new search starts on its first page, shortly after typing stops.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q);
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const list = useQuery<Page<Artifact>>({
    queryKey: ["library", kind, search, page],
    queryFn: () => artifactsApi.list({ type: kind === "all" ? undefined : kind, q: search, limit: PAGE, offset: page * PAGE }),
    // Videos have their own list, as on the web.
    enabled: kind !== "videos",
    placeholderData: keepPreviousData,
    // While something is still being made, ask again now and then so its status and progress move.
    refetchInterval: (query) => (query.state.data?.items.some(isMaking) ? 4000 : false),
  });
  const reload = () => void queryClient.invalidateQueries({ queryKey: ["library"] });

  const pick = (k: Kind) => {
    setKind(k);
    setPage(0);
    setPicking(false);
  };
  const goTo = (p: number) => {
    setPage(p);
    scroller.current?.scrollTo({ y: 0, animated: true });
  };

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const label = KINDS.find((k) => k.id === kind)?.label ?? "All";

  return (
    <View style={styles.fill}>
      <Starfield />
      <ScrollView
        ref={scroller}
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isPlaceholderData} onRefresh={reload} tintColor={colors.blue} />}>
        <Text style={styles.eyebrow}>Library</Text>
        <Text style={styles.title} accessibilityRole="header">
          Everything you have made
        </Text>

        {/* The chosen kind in a pill; its chevron opens the rest (the web's phone layout). */}
        <View style={styles.filterWrap}>
          <Pressable
            onPress={() => setPicking((p) => !p)}
            accessibilityRole="combobox"
            accessibilityLabel={`Show ${label}`}
            accessibilityState={{ expanded: picking }}
            style={styles.filter}>
            <Text style={styles.filterText}>{label}</Text>
            <SymbolView
              name={{ ios: picking ? "chevron.up" : "chevron.down", android: picking ? "expand_less" : "expand_more" }}
              size={14}
              tintColor={colors.text2}
              weight="semibold"
            />
          </Pressable>
          {picking ? (
            <View style={styles.menu} accessibilityRole="menu">
              {KINDS.map((k) => {
                const on = k.id === kind;
                return (
                  <Pressable
                    key={k.id}
                    onPress={() => pick(k.id)}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: on }}
                    style={({ pressed }) => [styles.option, on && styles.optionOn, pressed && styles.optionPressed]}>
                    <Text style={[styles.optionText, on && styles.optionTextOn]}>{k.label}</Text>
                    {on ? <SymbolView name={{ ios: "checkmark", android: "check" }} size={14} tintColor={colors.blue} /> : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>

        {kind !== "videos" ? (
          <TextInput
            style={styles.search}
            value={q}
            onChangeText={setQ}
            placeholder={`Search ${total} items by post or notebook`}
            placeholderTextColor={colors.text3}
            clearButtonMode="while-editing"
            autoCapitalize="none"
            accessibilityLabel="Search"
          />
        ) : null}

        {kind === "videos" ? <VideosList /> : null}
        {kind !== "videos" && list.isPending ? <Loading /> : null}
        {list.error && !list.data ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Could not load your library</Text>
            <Body muted>Something went wrong reaching the server.</Body>
            <Button title="Try again" onPress={reload} />
          </View>
        ) : null}
        {kind !== "videos" && list.data && items.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nothing here yet</Text>
            <Body muted>
              Reports, summaries, quizzes, flashcards, Mind Constellations, slide decks, audio and more that you create
              show up here.
            </Body>
            <Button title="Open a notebook" onPress={() => router.navigate("/notebooks")} />
          </View>
        ) : null}

        {kind !== "videos" ? (
          <>
            {items.map((a) => (
              <ArtifactCard key={a.id} artifact={a} onRemoved={reload} onChanged={reload} />
            ))}
            <Pager page={page} pages={Math.ceil(total / PAGE)} onChange={goTo} />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.black },
  page: { padding: gutter * 1.25, paddingBottom: gutter * 3, gap: 14 },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 3, textTransform: "uppercase" },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 28, lineHeight: 34, letterSpacing: -0.4 },
  // The menu opens over the cards below, so this block sits above them.
  filterWrap: { zIndex: 10, alignSelf: "flex-start", minWidth: 230 },
  filter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: colors.blue,
    backgroundColor: colors.black,
    shadowColor: colors.blue,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  filterText: { color: colors.text, fontSize: 18 },
  menu: {
    position: "absolute",
    top: 60,
    left: 0,
    right: 0,
    padding: 8,
    gap: 2,
    borderRadius: CARD_RADIUS,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.black,
    shadowColor: colors.blue,
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radius.sm + 2,
  },
  optionOn: { backgroundColor: "rgba(33, 124, 255, 0.12)" },
  optionPressed: { backgroundColor: colors.surface2 },
  optionText: { color: colors.text, fontSize: 17 },
  optionTextOn: { color: colors.blue },
  search: {
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  empty: { gap: 10, paddingVertical: gutter },
  emptyTitle: { color: colors.text, fontSize: 19, fontWeight: "600" },
});

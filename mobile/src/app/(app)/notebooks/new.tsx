import { ApiError } from "@notestack/shared/client";
import { docsApi, notebooksApi } from "@notestack/shared/endpoints";
import type { Doc } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, StyleSheet, Text, TextInput, View } from "react-native";
import { Pressable } from "@/ui/pressable";
import { useBottomInset } from "@/lib/insets";

import { colors, fonts, gutter, radius } from "@/ui/theme";
import { Body, Button, ErrorText, Loading, formatDate } from "@/ui";

/** New notebook, as the web's dialog: what it is about, and the posts it reads from. */
export default function NewNotebook() {
  const queryClient = useQueryClient();
  const bottomInset = useBottomInset();
  const [topic, setTopic] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const posts = useQuery({
    queryKey: ["docs", "picker"],
    queryFn: () => docsApi.list({ sort: "added", limit: 5000 }),
  });
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const items = posts.data?.items ?? [];
    return q ? items.filter((d) => d.title.toLowerCase().includes(q)) : items;
  }, [posts.data, filter]);

  const toggle = (d: Doc) => {
    if (d.locked) return;
    setSelected((s) => (s.includes(d.id) ? s.filter((x) => x !== d.id) : [...s, d.id]));
  };

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const nb = await notebooksApi.create(topic.trim() || "Untitled notebook", selected);
      await queryClient.invalidateQueries({ queryKey: ["notebooks"] });
      router.dismiss();
      router.push({ pathname: "/notebooks/[id]", params: { id: nb.id, title: nb.title } });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create the notebook. Try again.");
      setBusy(false);
    }
  };

  return (
    <View style={styles.fill}>
      <FlatList
        data={visible}
        keyExtractor={(d) => d.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.head}>
            <Text style={styles.label}>What is it about?</Text>
            <TextInput
              style={styles.input}
              value={topic}
              onChangeText={setTopic}
              placeholder="Pricing, paid tiers, 2024 essays..."
              placeholderTextColor={colors.text3}
              autoFocus
            />
            <Text style={[styles.label, styles.postsLabel]}>Posts</Text>
            <TextInput
              style={styles.input}
              value={filter}
              onChangeText={setFilter}
              placeholder="Filter by title"
              placeholderTextColor={colors.text3}
              clearButtonMode="while-editing"
            />
            {posts.isPending ? <Loading /> : null}
            {posts.error ? <ErrorText>{posts.error.message}</ErrorText> : null}
          </View>
        }
        renderItem={({ item: d }) => {
          const on = selected.includes(d.id);
          return (
            <Pressable
              onPress={() => toggle(d)}
              disabled={d.locked}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: d.locked }}
              style={[styles.row, on && styles.rowOn, d.locked && styles.locked]}>
              <View style={[styles.box, on && styles.boxOn]}>{on ? <Text style={styles.tick}>✓</Text> : null}</View>
              <View style={styles.rowText}>
                <Text style={styles.postTitle} numberOfLines={2}>
                  {d.title}
                </Text>
                <Text style={styles.postMeta}>
                  {formatDate(d.published_at)} · {d.locked ? "Not indexed on your plan" : `${d.words} words`}
                </Text>
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          posts.isPending ? undefined : <Body muted>{filter ? "No posts match that." : "No posts yet. Add a source first."}</Body>
        }
      />
      <View style={[styles.footer, { paddingBottom: Math.max(bottomInset, gutter) }]}>
        <ErrorText>{error}</ErrorText>
        <Button
          title={busy ? "Creating..." : `Create with ${selected.length} ${selected.length === 1 ? "post" : "posts"}`}
          onPress={create}
          busy={busy}
          disabled={!selected.length}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.black },
  list: { padding: gutter, gap: 8 },
  head: { gap: 8, marginBottom: 8 },
  label: { color: colors.text2, fontSize: 15, fontWeight: "600" },
  postsLabel: { marginTop: 10 },
  input: {
    color: colors.text,
    fontSize: 17,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
  },
  row: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    padding: 12,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.line,
  },
  rowOn: { borderColor: "rgba(33, 124, 255, 0.5)", backgroundColor: colors.blue10 },
  locked: { opacity: 0.45 },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.lineStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { backgroundColor: colors.blue, borderColor: colors.blue },
  tick: { color: colors.white, fontSize: 14, fontWeight: "700" },
  rowText: { flex: 1, gap: 3 },
  postTitle: { color: colors.text, fontSize: 16, lineHeight: 22 },
  postMeta: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12 },
  footer: {
    paddingHorizontal: gutter,
    paddingTop: 12,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.lineStrong,
    backgroundColor: colors.black,
  },
});

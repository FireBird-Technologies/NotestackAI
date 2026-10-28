import { notebooksApi } from "@notestack/shared/endpoints";
import type { NotebookSummary } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from "react-native";

import { PlanetIcon } from "@/shell/planet";
import { Starfield } from "@/shell/starfield";
import { colors, fonts, gutter, radius } from "@/ui/theme";
import { Body, Button, Centered, Loading, formatDate } from "@/ui";

/** Every notebook, "All posts" first, as the web's Research notebooks page. */
export default function Notebooks() {
  const queryClient = useQueryClient();
  const { data, error, isPending, isRefetching, refetch } = useQuery({
    queryKey: ["notebooks"],
    queryFn: async () => {
      // "All posts" always exists, so asking the whole archive never needs setup.
      await notebooksApi.archive().catch(() => undefined);
      const list = await notebooksApi.list();
      return [...list].sort((a, b) => Number(b.is_archive) - Number(a.is_archive));
    },
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: ["notebooks"] });

  if (isPending) return <Loading />;
  if (error && !data) {
    return (
      <Centered>
        <Body muted>{error.message}</Body>
        <Button title="Try again" onPress={() => refetch()} />
      </Centered>
    );
  }

  return (
    <View style={styles.fill}>
      <Starfield />
      <FlatList
        data={data}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.blue} />}
        ListHeaderComponent={
          <View style={styles.head}>
            <Text style={styles.eyebrow}>Notebooks</Text>
            <Text style={styles.title} accessibilityRole="header">
              Research notebooks
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push("/notebooks/new")}
              style={({ pressed }) => [styles.newButton, pressed && styles.pressed]}>
              <Text style={styles.newText}>New notebook</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => <NotebookCard notebook={item} onChanged={reload} />}
      />
    </View>
  );
}

function NotebookCard({ notebook: n, onChanged }: { notebook: NotebookSummary; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(n.title);

  const meta = [
    `${n.document_count} posts`,
    n.chat_count ? `${n.chat_count} chats` : null,
    n.artifact_count ? `${n.artifact_count} made` : null,
    formatDate(n.updated_at),
  ]
    .filter(Boolean)
    .join(" · ");

  const save = async () => {
    const title = name.trim();
    if (title && title !== n.title) await notebooksApi.update(n.id, { title });
    setRenaming(false);
    onChanged();
  };

  const confirmDelete = () =>
    Alert.alert(`Delete "${n.title}"?`, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await notebooksApi.remove(n.id);
          onChanged();
        },
      },
    ]);

  const options = () =>
    Alert.alert(n.title, undefined, [
      {
        text: "Rename",
        onPress: () => {
          setName(n.title);
          setRenaming(true);
        },
      },
      { text: "Delete", style: "destructive", onPress: confirmDelete },
      { text: "Cancel", style: "cancel" },
    ]);

  return (
    <View style={[styles.card, n.is_archive && styles.archive]}>
      {renaming ? (
        <View style={styles.renameRow}>
          <TextInput
            style={styles.renameInput}
            value={name}
            onChangeText={setName}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={save}
            accessibilityLabel="Notebook title"
          />
          <Pressable onPress={save} style={styles.saveButton} accessibilityRole="button">
            <Text style={styles.saveText}>Save</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="link"
          onPress={() => router.push({ pathname: "/notebooks/[id]", params: { id: n.id, title: n.title } })}
          style={({ pressed }) => [styles.cardLink, pressed && styles.pressed]}>
          {n.is_archive ? <PlanetIcon size={28} /> : null}
          <Text style={styles.cardTitle} numberOfLines={2}>
            {n.title}
          </Text>
          {n.description || n.summary ? (
            <Text style={styles.summary} numberOfLines={3}>
              {n.description || n.summary}
            </Text>
          ) : null}
          <Text style={styles.meta}>{meta}</Text>
        </Pressable>
      )}
      {!n.is_archive && !renaming ? (
        <Pressable
          onPress={options}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Notebook options"
          style={styles.menu}>
          <Text style={styles.menuText}>⋯</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.black },
  list: { padding: gutter * 1.25, paddingBottom: gutter * 3, gap: 14 },
  head: { gap: 10, marginBottom: 8 },
  eyebrow: {
    color: colors.blue,
    fontFamily: fonts.mono,
    fontSize: 12.5,
    letterSpacing: 3,
    textTransform: "uppercase",
  },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 30, lineHeight: 36, letterSpacing: -0.5 },
  // The web's primary pill with its blue glow.
  newButton: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 26,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: colors.blue,
    shadowColor: colors.blue,
    shadowOpacity: 0.6,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  newText: { color: colors.white, fontSize: 18, fontWeight: "600" },
  pressed: { opacity: 0.75 },
  card: {
    minHeight: 140,
    padding: gutter * 1.5,
    borderRadius: radius.md + 2,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(12, 12, 12, 0.92)",
  },
  // "All posts": a deep blue wash and a blue edge, as on the web.
  archive: { borderColor: "rgba(33, 124, 255, 0.45)", backgroundColor: "rgba(6, 14, 30, 0.92)" },
  cardLink: { gap: 8 },
  cardTitle: { color: colors.text, fontSize: 21, fontWeight: "600", paddingRight: 28 },
  summary: { color: colors.text2, fontSize: 17, lineHeight: 25 },
  meta: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13, lineHeight: 20, marginTop: 4 },
  menu: { position: "absolute", top: gutter, right: gutter, padding: 4 },
  menuText: { color: colors.text2, fontSize: 20, lineHeight: 20 },
  renameRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  renameInput: {
    flex: 1,
    color: colors.text,
    fontSize: 17,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
  },
  saveButton: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: radius.sm, backgroundColor: colors.blue },
  saveText: { color: colors.white, fontSize: 16, fontWeight: "600" },
});

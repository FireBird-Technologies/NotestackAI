import { docsApi, jobsApi, notebooksApi } from "@notestack/shared/endpoints";
import { groupChats } from "@notestack/shared/notebook";
import type { ChatSummary, Doc, Job, Notebook } from "@notestack/shared/types";
import { useQuery } from "@tanstack/react-query";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { AddSource } from "@/sources/add-source";
import { colors, fonts, radius } from "@/ui/theme";
import { ErrorText, formatDate, Loading } from "@/ui";
import { confirm, JobProgress, pageStyles, PillButton, Section, Sheet } from "@/ui/widgets";

/**
 * The Sources tab (web: NotebookView's chats column on a phone): the notebook's chats under date headings, with + New,
 * open and delete, then its posts with Add & modify.
 */
export function SourcesTab({
  notebook,
  chats,
  chatId,
  onOpenChat,
  onNewChat,
  onChatRemoved,
  onPostsChanged,
}: {
  notebook: Notebook;
  chats: ChatSummary[];
  chatId: string | null;
  onOpenChat: (id: string) => void;
  onNewChat: () => void;
  onChatRemoved: (id: string) => void;
  onPostsChanged: () => void;
}) {
  const groups = useMemo(() => groupChats(chats), [chats]);
  // Today's chats start open, as on the web.
  const [open, setOpen] = useState<string[]>(["Today"]);
  const [adding, setAdding] = useState(false);
  // Sources connected from the sheet: their imports, followed until done, when the notebook reloads with the new posts.
  const [imports, setImports] = useState<Job[]>([]);
  const changed = useRef(onPostsChanged);
  useEffect(() => {
    changed.current = onPostsChanged;
  }, [onPostsChanged]);
  const running = imports.filter((j) => j.status === "queued" || j.status === "running").map((j) => j.id).join(",");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const next = await Promise.all(running.split(",").map((id) => jobsApi.get(id).catch(() => null)));
      setImports((cur) => cur.map((j) => next.find((n) => n?.id === j.id) ?? j));
      changed.current();
    }, 3000);
    return () => clearInterval(t);
  }, [running]);
  // A finished import leaves the card a moment after it is done.
  useEffect(() => {
    if (!imports.some((j) => j.status === "done")) return;
    const t = setTimeout(() => setImports((cur) => cur.filter((j) => j.status !== "done")), 2500);
    return () => clearTimeout(t);
  }, [imports]);
  const [error, setError] = useState("");
  const posts = notebook.documents.length;

  const remove = (c: ChatSummary, title: string) =>
    confirm(
      "Delete this chat?",
      "Delete",
      async () => {
        setError("");
        try {
          await notebooksApi.removeChat(c.id);
          onChatRemoved(c.id);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Could not delete the chat.");
        }
      },
      `"${title}" and its answers will be deleted.`,
    );

  return (
    <ScrollView contentContainerStyle={styles.column}>
      <Section title="Chats" aside={<PillButton small title="+ New" onPress={onNewChat} />}>
        <ErrorText>{error}</ErrorText>
        {chats.length === 0 ? <Text style={pageStyles.body}>Your conversations in this notebook will appear here.</Text> : null}
        {groups.map((g) => {
          const shown = open.includes(g.label);
          return (
            <View key={g.label} style={styles.group}>
              <Pressable
                onPress={() => setOpen(shown ? open.filter((x) => x !== g.label) : [...open, g.label])}
                accessibilityRole="button"
                accessibilityState={{ expanded: shown }}
                style={styles.groupHead}>
                <SymbolView
                  name={shown ? { ios: "chevron.down", android: "expand_more" } : { ios: "chevron.right", android: "chevron_right" }}
                  size={13}
                  tintColor={colors.text3}
                />
                <Text style={styles.groupLabel}>{g.label.toUpperCase()}</Text>
                <Text style={styles.groupCount}>{g.items.length}</Text>
              </Pressable>
              {shown
                ? g.items.map((c) => {
                    const title = c.title?.trim() || "Untitled chat";
                    const on = c.id === chatId;
                    return (
                      <View key={c.id} style={[styles.chat, on && styles.chatOn]}>
                        <Pressable
                          onPress={() => onOpenChat(c.id)}
                          style={styles.chatLink}
                          accessibilityRole="button"
                          accessibilityLabel={`${title}, updated ${formatDate(c.updated_at)}`}>
                          <Text style={[styles.chatTitle, on && styles.chatTitleOn]} numberOfLines={1}>
                            {title}
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => remove(c, title)}
                          hitSlop={6}
                          accessibilityRole="button"
                          accessibilityLabel={`Delete ${title}`}
                          style={styles.trash}>
                          <SymbolView name={{ ios: "trash", android: "delete" }} size={15} tintColor={colors.text2} />
                        </Pressable>
                      </View>
                    );
                  })
                : null}
            </View>
          );
        })}
      </Section>

      <Section title="Posts" aside={<PillButton small title="Add & modify" onPress={() => setAdding(true)} />}>
        {posts > 0 ? (
          <Text style={pageStyles.body}>
            {posts} {posts === 1 ? "post is" : "posts are"} connected to this notebook.
          </Text>
        ) : (
          <Text style={pageStyles.body}>No posts yet. Add some to start asking and creating.</Text>
        )}
        {imports.map((j) => (
          <JobProgress key={j.id} job={j} />
        ))}
      </Section>

      <Sheet visible={adding} title={notebook.is_archive ? "Connect a source" : `Add to ${notebook.title}`} onClose={() => setAdding(false)}>
        <Text style={pageStyles.body}>
          {notebook.is_archive
            ? "This archive already contains all your posts. Posts from a new source join it automatically."
            : "Every post it imports joins this notebook."}
        </Text>
        <AddSource
          compact
          notebookId={notebook.is_archive ? undefined : notebook.id}
          onAdded={(_, job) => {
            setImports((cur) => [...cur, job]);
            setAdding(false);
          }}
        />
        <PostsManager notebook={notebook} readOnly={notebook.is_archive} onChanged={onPostsChanged} />
      </Sheet>
    </ScrollView>
  );
}

/**
 * A notebook's posts in two tabbed lists (web: NotebookPostsManager): those in it (× removes one, after a warning) and
 * the rest of the library (+ Add puts one in). Only indexed posts are offered. `readOnly` (the archive) only lists them.
 */
function PostsManager({ notebook, readOnly, onChanged }: { notebook: Notebook; readOnly: boolean; onChanged: () => void }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"inside" | "outside">("inside");
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState("");
  // Indexed posts only: one past the plan's limit cannot be added, so it is not offered.
  const all = useQuery({
    queryKey: ["docs", "picker", "indexed"],
    queryFn: () => docsApi.list({ sort: "added", limit: 5000, indexed_only: true }),
    enabled: !readOnly,
  });

  const needle = q.trim().toLowerCase();
  const matches = (d: Doc) => !needle || d.title.toLowerCase().includes(needle) || (d.source_title ?? "").toLowerCase().includes(needle);
  const docs = notebook.documents;
  const inside = docs.filter(matches);
  const outside = useMemo(() => {
    const have = new Set(notebook.documents.map((d) => d.id));
    return (all.data?.items ?? [])
      .filter((d) => !have.has(d.id) && !d.locked)
      .sort((a, b) => (Date.parse(b.added_at ?? "") || 0) - (Date.parse(a.added_at ?? "") || 0));
  }, [all.data, notebook.documents]);
  const outsideShown = outside.filter(matches);

  const run = async (id: string, call: () => Promise<unknown>) => {
    setError("");
    setPending((p) => [...p, id]);
    try {
      await call();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the posts. Try again.");
    } finally {
      setPending((p) => p.filter((x) => x !== id));
    }
  };

  const remove = (d: Doc) =>
    confirm(
      "Remove this post?",
      "Remove post",
      () => void run(d.id, () => notebooksApi.removeDoc(notebook.id, d.id)),
      `"${d.title}" will be removed from this notebook. The post itself is kept in your library, and you can add it back later.`,
    );

  return (
    <View style={styles.manager}>
      <TextInput
        style={styles.search}
        value={q}
        onChangeText={setQ}
        placeholder="Search posts"
        placeholderTextColor={colors.text3}
        clearButtonMode="while-editing"
        autoCapitalize="none"
        accessibilityLabel="Search posts"
      />
      <ErrorText>{error}</ErrorText>

      {readOnly ? (
        <Text style={styles.eyebrow}>ALREADY ADDED POSTS ({docs.length})</Text>
      ) : (
        <View style={styles.tabs} accessibilityRole="tablist">
          {(
            [
              ["inside", "Added sources"],
              ["outside", "Other sources"],
            ] as const
          ).map(([id, label]) => {
            const on = tab === id;
            return (
              <Pressable
                key={id}
                onPress={() => setTab(id)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={[styles.tab, on && styles.tabOn]}>
                <Text style={[styles.tabText, on && styles.tabTextOn]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {readOnly || tab === "inside" ? (
        <ScrollView style={styles.panel} nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>
          {inside.map((d, i) => (
            <View key={d.id} style={[styles.pmRow, i > 0 && styles.pmRowLine]}>
              <View style={styles.pmText}>
                <Text style={styles.pmTitle} numberOfLines={1}>
                  {d.title}
                </Text>
                <Text style={pageStyles.mono}>{formatDate(d.published_at)}</Text>
              </View>
              {!readOnly ? (
                <Pressable
                  onPress={() => remove(d)}
                  disabled={pending.includes(d.id)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${d.title} from this notebook`}
                  style={styles.pmAction}>
                  {pending.includes(d.id) ? (
                    <ActivityIndicator size="small" color={colors.text2} />
                  ) : (
                    <SymbolView name={{ ios: "xmark", android: "close" }} size={14} tintColor={colors.text2} />
                  )}
                </Pressable>
              ) : null}
            </View>
          ))}
          {inside.length === 0 ? <Text style={styles.pmEmpty}>{docs.length ? "No posts match." : "No posts yet."}</Text> : null}
        </ScrollView>
      ) : all.isPending ? (
        <Loading />
      ) : (
        <ScrollView style={styles.panel} nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>
          {all.error ? <ErrorText>{all.error.message}</ErrorText> : null}
          {outsideShown.map((d, i) => (
            <View key={d.id} style={[styles.pmRow, i > 0 && styles.pmRowLine]}>
              <View style={styles.pmText}>
                <Text style={styles.pmTitle} numberOfLines={1}>
                  {d.title}
                </Text>
                <Text style={pageStyles.mono}>
                  {formatDate(d.published_at)} · {d.words} words
                </Text>
              </View>
              <PillButton
                small
                title="+ Add"
                busy={pending.includes(d.id)}
                onPress={() => void run(d.id, () => notebooksApi.addDocs(notebook.id, [d.id]))}
              />
            </View>
          ))}
          {outsideShown.length === 0 ? (
            <Text style={styles.pmEmpty}>{outside.length ? "No posts match." : "All your posts are in this notebook."}</Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  column: { padding: 10, gap: 12 },
  group: { gap: 2 },
  groupHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  groupLabel: { flex: 1, color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 0.8 },
  groupCount: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5 },
  chat: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radius.sm, paddingLeft: 8 },
  chatOn: { backgroundColor: colors.blue10 },
  chatLink: { flex: 1, paddingVertical: 10 },
  chatTitle: { color: colors.text2, fontSize: 16 },
  chatTitleOn: { color: colors.text },
  trash: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface2,
  },
  manager: { gap: 12 },
  search: {
    color: colors.text,
    fontSize: 17,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.black,
  },
  eyebrow: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1 },
  tabs: {
    flexDirection: "row",
    padding: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 999, borderWidth: 1.5, borderColor: "transparent" },
  tabOn: { borderColor: colors.blue, backgroundColor: colors.black },
  tabText: { color: colors.text3, fontSize: 16, fontWeight: "500" },
  tabTextOn: { color: colors.text },
  // About six and a half rows, the list scrolling inside its box (the sheet around it scrolls on its own).
  panel: { maxHeight: 430, flexGrow: 0, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  pmRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  pmRowLine: { borderTopWidth: 1, borderTopColor: colors.line },
  pmText: { flex: 1, gap: 3 },
  pmTitle: { color: colors.text, fontSize: 16 },
  pmAction: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  pmEmpty: { color: colors.text3, fontSize: 15, padding: 14 },
});

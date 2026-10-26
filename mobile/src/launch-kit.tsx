import { ApiError } from "@notestack/shared/client";
import { artifactsApi, launchpadApi } from "@notestack/shared/endpoints";
import type { Artifact, LaunchKitContent } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { ChevronLeftIcon } from "@/icons";
import { Composer } from "@/launchpad/editors";
import { colors, fonts, gutter, radius } from "@/theme";
import { ErrorText, formatDate } from "@/ui";
import { confirm, PillButton, pageStyles, Sheet, StatusPill } from "@/widgets";

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

/**
 * A Launch Kit, opened from its card (web: pages/LaunchKit.tsx KitView): the LinkedIn post to edit, copy and schedule,
 * and its hooks, strongest first, each of which can go out on its own. Kits are worked for LinkedIn only for now.
 */
export function LaunchKitScreen({ artifact, visible, onClose, onDeleted, onChanged }: {
  artifact: Artifact;
  visible: boolean;
  onClose: () => void;
  onDeleted: () => void;
  onChanged: () => void;
}) {
  const [kit, setKit] = useState(artifact);
  const c = (kit.content ?? {}) as LaunchKitContent;
  const saved = c.posts?.linkedin ?? [];
  const [posts, setPosts] = useState<string[]>(saved);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [schedule, setSchedule] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ["launchpad", "accounts"], queryFn: launchpadApi.accounts, enabled: schedule !== null });
  const title = c.post_title ?? kit.title;

  // The kit as the server has it, each time it opens.
  useEffect(() => {
    if (!visible) return;
    artifactsApi.get(artifact.id).then(
      (k) => {
        setKit(k);
        setPosts((k.content as LaunchKitContent)?.posts?.linkedin ?? []);
        setDirty(false);
      },
      () => undefined,
    );
  }, [visible, artifact.id]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      setKit(await artifactsApi.update(kit.id, { content: { posts: { ...c.posts, linkedin: posts } } }));
      setDirty(false);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the edits. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaProvider>
      <SafeAreaView style={pageStyles.sheet} edges={["top", "bottom"]}>
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" style={styles.back}>
            <ChevronLeftIcon size={16} color={colors.text2} />
            <Text style={styles.backText}>Back</Text>
          </Pressable>
          <View style={styles.head}>
            <View style={styles.headText}>
              <Text style={styles.eyebrow}>LAUNCH KIT</Text>
              <Text style={styles.title} accessibilityRole="header">
                {title}
              </Text>
              <Text style={styles.date}>{formatDate(kit.created_at, true)}</Text>
            </View>
            <View style={styles.headSide}>
              <StatusPill status={kit.status} />
              <PillButton small variant="danger" title="Delete" onPress={() => confirm("Delete launch kit?", "Delete", onDeleted, title)} />
            </View>
          </View>
          <ErrorText>{error}</ErrorText>

          {kit.status === "ready" ? (
            <>
              <View style={styles.section}>
                <Text style={styles.h}>LinkedIn post</Text>
                <View style={styles.between}>
                  <Text style={styles.muted}>The full post, written from the article. Edit it here, then schedule it.</Text>
                  {dirty ? <PillButton small variant="primary" title={saving ? "Saving..." : "Save edits"} busy={saving} onPress={() => void save()} /> : null}
                </View>
                {posts.map((p, i) => (
                  <View key={i} style={styles.post}>
                    <Text style={[styles.count, p.length > LIMIT && styles.over]}>
                      {p.length} / {LIMIT}
                    </Text>
                    <TextInput
                      style={styles.input}
                      value={p}
                      multiline
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
                    </View>
                  </View>
                ))}
              </View>

              {(c.hooks?.length ?? 0) > 0 ? (
                <View style={styles.section}>
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
                </View>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
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
    </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { padding: gutter * 1.25, paddingBottom: gutter * 3, gap: 16 },
  back: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", paddingVertical: 4 },
  backText: { color: colors.text2, fontSize: 15 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  headText: { flex: 1, gap: 6 },
  headSide: { alignItems: "flex-end", gap: 8 },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 3 },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 24, lineHeight: 30 },
  date: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13 },
  section: { gap: 12, padding: gutter, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(12, 12, 12, 0.92)" },
  h: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 19 },
  muted: { flex: 1, color: colors.text2, fontSize: 14.5, lineHeight: 21 },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  post: { gap: 8 },
  count: { alignSelf: "flex-end", color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5 },
  over: { color: colors.danger },
  input: {
    minHeight: 220,
    color: colors.text,
    fontSize: 15.5,
    lineHeight: 22,
    padding: 14,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  row: { flexDirection: "row", gap: 8 },
  hook: { gap: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  hookNum: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5 },
  strength: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5 },
  hookText: { color: colors.white, fontSize: 16.5, lineHeight: 24, fontWeight: "500" },
});

import { artifactsApi, docsApi } from "@notestack/shared/endpoints";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { colors, fonts, radius } from "@/theme";
import { ErrorText, Loading } from "@/ui";
import { BackLink } from "@/video/back";
import { Page, PageHead, pageStyles, PillButton, Section } from "@/widgets";

/**
 * Create a launch kit (web: pages/LaunchKit.tsx LaunchKits, /app/launchpad/kits): pick one of your posts, and its kit
 * (a LinkedIn post and hooks) is written on its own page. `?post=<id>` starts that post's kit straight away.
 */
export default function LaunchKits() {
  const { post } = useLocalSearchParams<{ post?: string }>();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const autoStarted = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setSearch(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const posts = useQuery({
    queryKey: ["docs", "kit-picker", search],
    queryFn: () => docsApi.list({ q: search || undefined, limit: 30 }),
    select: (p) => p.items.filter((d) => !d.locked),
  });

  const generate = useCallback(
    async (documentId: string) => {
      setBusy(documentId);
      setError("");
      try {
        const kit = await artifactsApi.generate({ type: "launch_kit", document_id: documentId });
        void queryClient.invalidateQueries({ queryKey: ["launchpad"] });
        void queryClient.invalidateQueries({ queryKey: ["library"] });
        // Its page shows the progress, then the kit.
        router.replace({ pathname: "/launchpad/kits/[id]", params: { id: kit.id } });
      } catch (e) {
        // A plan limit also opens the Plans sheet (PLAN_LIMIT_EVENT).
        setError(e instanceof Error && e.message ? e.message : "Could not start the launch kit. Try again.");
        setBusy(null);
      }
    },
    [queryClient],
  );

  useEffect(() => {
    if (post && !autoStarted.current) {
      autoStarted.current = true;
      void generate(post);
    }
  }, [post, generate]);

  return (
    <Page>
      <BackLink fallback="/launchpad" />
      <PageHead eyebrow="Launch Kit" title="Create a launch kit" />
      <ErrorText>{error}</ErrorText>
      <Section>
        <View style={styles.intro}>
          <Text style={styles.h}>Pick a post to launch</Text>
          <Text style={styles.muted}>A LinkedIn post and hooks, in your voice and grounded in the post.</Text>
        </View>
        <TextInput
          style={pageStyles.input}
          value={q}
          onChangeText={setQ}
          placeholder="Search your posts"
          placeholderTextColor={colors.text3}
          clearButtonMode="while-editing"
          accessibilityLabel="Search your posts"
        />
        {posts.isPending ? <Loading /> : null}
        {posts.error ? <ErrorText>{posts.error.message}</ErrorText> : null}
        {posts.data?.length === 0 ? <Text style={styles.muted}>{search ? "No posts match." : "No indexed posts yet. Connect a source first."}</Text> : null}
        {posts.data?.map((d) => (
          <View key={d.id} style={styles.row}>
            <View style={styles.text}>
              <Text style={styles.title} numberOfLines={1}>
                {d.title}
              </Text>
              {d.source_title ? (
                <Text style={styles.source} numberOfLines={1}>
                  {d.source_title}
                </Text>
              ) : null}
            </View>
            <PillButton small variant="primary" title={busy === d.id ? "Launching..." : "Launch"} busy={busy === d.id} disabled={busy !== null} onPress={() => void generate(d.id)} />
          </View>
        ))}
      </Section>
    </Page>
  );
}

const styles = StyleSheet.create({
  intro: { gap: 4 },
  h: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 21 },
  muted: { color: colors.text2, fontSize: 15.5, lineHeight: 23 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  text: { flex: 1, gap: 4 },
  title: { color: colors.text, fontSize: 16.5, fontWeight: "700" },
  source: { color: colors.text2, fontSize: 14.5 },
});

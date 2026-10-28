import { docsApi } from "@notestack/shared/endpoints";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ScrollView, StyleSheet, Text } from "react-native";

import { colors, fonts, gutter } from "@/ui/theme";
import { Body, Button, Centered, Loading, formatDate } from "@/ui";

/** One post's text as Notestack indexed it (the web's Reader). */
export default function Post() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const doc = useQuery({ queryKey: ["doc", id], queryFn: () => docsApi.get(id) });

  if (doc.isPending) return <Loading />;
  if (!doc.data) {
    return (
      <Centered>
        <Body muted>{doc.error?.message ?? "Could not load this post."}</Body>
        <Button title="Try again" onPress={() => void doc.refetch()} />
      </Centered>
    );
  }
  const d = doc.data;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Stack.Screen options={{ title: d.source_title ?? "" }} />
      <Text style={styles.title} accessibilityRole="header" selectable>
        {d.title}
      </Text>
      <Text style={styles.meta}>
        {d.source_title ?? ""} · {formatDate(d.published_at)} · {d.words} words
      </Text>
      {d.url ? (
        <Text style={styles.link} onPress={() => WebBrowser.openBrowserAsync(d.url, { controlsColor: colors.blue })}>
          Open the original
        </Text>
      ) : null}
      <Text style={styles.body} selectable>
        {d.lines.join("\n")}
      </Text>
      {d.preview ? <Body muted>This is a preview of the post.</Body> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: gutter * 1.25, paddingBottom: gutter * 3, gap: 12 },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 26, lineHeight: 32 },
  meta: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13 },
  link: { color: colors.blue, fontSize: 16, textDecorationLine: "underline" },
  body: { color: colors.text2, fontSize: 17, lineHeight: 27, marginTop: 8 },
});

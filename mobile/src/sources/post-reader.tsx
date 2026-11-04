import { docsApi } from "@notestack/shared/endpoints";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useRef } from "react";
import { ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";

import { colors, fonts, gutter } from "@/ui/theme";
import { Body, Button, Centered, Loading, formatDate } from "@/ui";

/**
 * One post's text as Notestack indexed it (the web's Reader), with the real line numbers citations point at. Routed from
 * Sources and, for a chat's citation, from a notebook with `start` and `end`: those lines are boxed, scrolled to.
 */
export default function Post() {
  const { id, start, end } = useLocalSearchParams<{ id: string; start?: string; end?: string }>();
  const doc = useQuery({ queryKey: ["doc", id], queryFn: () => docsApi.get(id) });
  const scroll = useRef<ScrollViewInstance>(null);
  const scrolled = useRef(false);

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
  const from = Number(start);
  const to = Number(end) || from;
  const cited = (n: number) => from > 0 && n >= from && n <= to;

  // Skip the front matter block for display, but keep real line numbers.
  let bodyStart = 0;
  if (d.lines[0] === "---") {
    const close = d.lines.indexOf("---", 1);
    bodyStart = close > 0 ? close + 1 : 0;
  }

  const line = (text: string, n: number, hit = false) => {
    const heading = text.match(/^(#{1,3})\s+(.*)/);
    return (
      <View
        key={n}
        style={[styles.line, hit && styles.hit]}
        onLayout={
          hit && n === from
            ? (e) => {
                if (scrolled.current) return;
                scrolled.current = true;
                scroll.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - 120), animated: false });
              }
            : undefined
        }>
        <Text style={styles.n}>{n}</Text>
        <Text style={heading ? [styles.heading, heading[1].length === 1 && styles.h1] : styles.text} selectable>
          {heading ? heading[2] : text}
        </Text>
      </View>
    );
  };

  // Every line in its own row; a cited one (blank ones too) gets the web's highlight box.
  const rows = d.lines.slice(bodyStart).map((text, i) => {
    const n = i + bodyStart + 1;
    if (!text.trim() && !cited(n)) return <View key={n} style={styles.gap} />;
    return line(text, n, cited(n));
  });

  return (
    <ScrollView ref={scroll} contentContainerStyle={styles.page}>
      <Stack.Screen options={{ title: d.source_title ?? "" }} />
      <Text style={styles.title} accessibilityRole="header" selectable>
        {d.title}
      </Text>
      <Text style={styles.meta}>
        {d.source_title ?? ""} · {formatDate(d.published_at)} · {d.words} words
      </Text>
      {d.url.startsWith("http") ? (
        <Text style={styles.link} onPress={() => WebBrowser.openBrowserAsync(d.url, { controlsColor: colors.blue })}>
          Open the original
        </Text>
      ) : null}
      <View style={styles.spacer} />
      {rows}
      {d.preview ? <Body muted>This is a preview of the post.</Body> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: gutter * 1.25, paddingBottom: gutter * 3 },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 26, lineHeight: 32, marginBottom: 12 },
  meta: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13, marginBottom: 12 },
  link: { color: colors.blue, fontSize: 16, textDecorationLine: "underline" },
  spacer: { height: 16 },
  // The web's .reader-line: a number column, then the text.
  line: { flexDirection: "row", gap: 8, paddingVertical: 2, paddingHorizontal: 6 },
  n: { width: 28, color: colors.text3, fontFamily: fonts.mono, fontSize: 11, textAlign: "right", paddingTop: 5 },
  text: { flex: 1, color: colors.text2, fontSize: 17, lineHeight: 27 },
  heading: { flex: 1, color: colors.text, fontFamily: fonts.displayBold, fontSize: 19, lineHeight: 26, marginTop: 6 },
  h1: { fontSize: 24, lineHeight: 30 },
  gap: { height: 10 },
  // The web's .reader-line.hit: each cited line boxed, with the blue bar on its left.
  hit: {
    backgroundColor: colors.blue20,
    borderLeftWidth: 3,
    borderLeftColor: colors.blue,
    borderRadius: 6,
    paddingVertical: 6,
    marginBottom: 3,
  },
});

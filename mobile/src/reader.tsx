import { docsApi } from "@notestack/shared/endpoints";
import type { Citation } from "@notestack/shared/types";
import { useQuery } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { type ComponentRef, useRef } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CloseIcon } from "@/icons";

import { colors, fonts, gutter } from "@/theme";
import { ErrorText, formatDate, Loading } from "@/ui";
import { pageStyles } from "@/widgets";

/** What a citation points at: a post's lines (opened in the reader), or what was said in a chat (its words alone). */
export type Cited = Pick<
  Citation,
  "title" | "line_start" | "line_end" | "span"
> & { document_id?: string | null; kind?: "post" | "chat" };

/**
 * A cited post, opened at the cited lines and with them lit (web: Reader). A sheet, so it opens over a summary, a
 * report or a Mind Constellation where the citation was tapped. A chat citation has no post: its words are shown.
 */
export function ReaderSheet({
  cite,
  onClose,
}: {
  cite: Cited | null;
  onClose: () => void;
}) {
  const id = cite?.kind !== "chat" ? cite?.document_id : null;
  const doc = useQuery({
    queryKey: ["doc", id],
    queryFn: () => docsApi.get(id!),
    enabled: Boolean(id),
  });
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const lit = (n: number) =>
    !!cite && n >= cite.line_start && n <= cite.line_end;
  return (
    <Modal
      visible={cite !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={pageStyles.sheet} edges={["top", "bottom"]}>
        <View style={pageStyles.sheetHead}>
          <Text style={[pageStyles.sheetTitle, styles.head]} numberOfLines={1}>
            {doc.data?.source_title ?? cite?.title ?? "Source"}
          </Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <CloseIcon size={20} />
          </Pressable>
        </View>
        <ScrollView ref={scroll} contentContainerStyle={pageStyles.sheetBody}>
          {!cite ? null : !id ? (
            <View style={styles.quote}>
              <Text style={styles.line}>{cite.span}</Text>
            </View>
          ) : doc.isPending ? (
            <Loading />
          ) : !doc.data ? (
            <ErrorText>
              {doc.error?.message ?? "Could not load this post."}
            </ErrorText>
          ) : (
            <View>
              <Text style={styles.title} accessibilityRole="header" selectable>
                {doc.data.title}
              </Text>
              <Text style={styles.meta}>
                {formatDate(doc.data.published_at)} · lines {cite.line_start}
                {cite.line_end > cite.line_start ? ` to ${cite.line_end}` : ""}
              </Text>
              {doc.data.url ? (
                <Text
                  style={styles.link}
                  onPress={() =>
                    WebBrowser.openBrowserAsync(doc.data!.url, {
                      controlsColor: colors.blue,
                    })
                  }
                >
                  Open the original
                </Text>
              ) : null}
              {doc.data.lines.map((text, i) => (
                <View
                  key={i}
                  style={[styles.row, lit(i + 1) && styles.lit]}
                  onLayout={
                    i + 1 === cite.line_start
                      ? (e) =>
                          scroll.current?.scrollTo({
                            y: Math.max(0, e.nativeEvent.layout.y - 80),
                            animated: true,
                          })
                      : undefined
                  }
                >
                  <Text style={styles.n}>{i + 1}</Text>
                  <Text
                    style={[styles.line, lit(i + 1) && styles.litText]}
                    selectable
                  >
                    {text}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  head: { flex: 1, marginRight: 12 },
  title: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 22,
    lineHeight: 28,
    marginBottom: 6,
  },
  meta: {
    color: colors.text3,
    fontFamily: fonts.mono,
    fontSize: 13,
    marginBottom: 6,
  },
  link: {
    color: colors.blue,
    fontSize: 15,
    textDecorationLine: "underline",
    marginBottom: 12,
  },
  row: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 6,
  },
  lit: { backgroundColor: colors.blue20 },
  n: {
    width: 30,
    color: colors.text3,
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 24,
    textAlign: "right",
  },
  line: { flex: 1, color: colors.text2, fontSize: 16, lineHeight: 24 },
  litText: { color: colors.text },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.blue,
    paddingLeft: gutter * 0.75,
  },
});

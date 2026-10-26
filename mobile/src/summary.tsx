import { citedLines, groupCitations } from "@notestack/shared/citations";
import type { Artifact, Citation } from "@notestack/shared/types";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Markdown } from "@/markdown";
import { type Cited, ReaderSheet } from "@/reader";
import { StudyModal } from "@/study-modal";
import { colors, fonts } from "@/theme";

/** Every citation, each source once with a number for each place it was cited (web: CitationList). */
export function CitationList({ citations, onCite }: { citations: Citation[]; onCite: (c: Citation) => void }) {
  if (!citations.length) return null;
  return (
    <View style={styles.cites}>
      {groupCitations(citations).map((g) => (
        <View key={g.key} style={styles.citeRow}>
          <Text style={styles.citeTitle} onPress={() => onCite(g.cites[0])} accessibilityRole="link">
            {g.title}
          </Text>
          <View style={styles.citeNums}>
            {g.cites.map((c) => (
              <Pressable key={c.marker} onPress={() => onCite(c)} hitSlop={4} accessibilityRole="button" accessibilityLabel={`${c.marker}: ${citedLines(c)}`} style={styles.num}>
                <Text style={styles.numText}>{c.marker}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * A summary, opened from its card (web: ArtifactCard's SummaryBody in a StudyOverlay): its themes as chips, the text
 * with its [n] markers, and every citation. A marker or a citation opens the cited lines in the reader.
 */
export function SummaryScreen({ artifact, visible, onClose }: { artifact: Artifact; visible: boolean; onClose: () => void }) {
  const [cite, setCite] = useState<Cited | null>(null);
  const c = artifact.content ?? {};
  const themes = (c.themes as string[] | undefined) ?? [];
  const citations = (c.citations as Citation[] | undefined) ?? [];
  return (
    <StudyModal title={artifact.title} visible={visible} onClose={onClose}>
      {themes.length > 0 ? (
        <View style={styles.chips}>
          {themes.map((t) => (
            <Text key={t} style={styles.chip}>
              {t}
            </Text>
          ))}
        </View>
      ) : null}
      <Markdown text={String(c.summary ?? "")} citations={citations} onCite={setCite} />
      <CitationList citations={citations} onCite={setCite} />
      <ReaderSheet cite={cite} onClose={() => setCite(null)} />
    </StudyModal>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(33, 124, 255, 0.35)",
    overflow: "hidden",
    color: colors.text,
    fontSize: 12.5,
  },
  cites: { gap: 10, marginTop: 6, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  citeRow: { gap: 6 },
  citeTitle: { color: colors.text, fontSize: 15, lineHeight: 21, textDecorationLine: "underline", textDecorationColor: colors.blue },
  citeNums: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  num: { minWidth: 24, height: 22, paddingHorizontal: 6, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.blue10 },
  numText: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12 },
});

import type { Artifact } from "@notestack/shared/types";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

import { ArtifactCard } from "@/artifacts/artifact-card";
import { colors, fonts, radius } from "@/ui/theme";
import { ErrorText, Loading } from "@/ui";
import { FlowBar } from "@/ui/widgets";

/**
 * The Library tab (web: StudioPanel's "Made from this notebook" on a phone): what is being started, then everything made
 * here, newest first. Nothing yet: a note in the middle of the card.
 */
export function LibraryTab({
  artifacts,
  starting,
  error,
  refreshing,
  onRefresh,
}: {
  artifacts: Artifact[] | undefined;
  starting: string[];
  error: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const empty = artifacts?.length === 0 && starting.length === 0;
  return (
    <ScrollView
      contentContainerStyle={styles.column}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue} />}>
      <View style={[styles.card, empty && styles.cardEmpty]}>
        <ErrorText>{error}</ErrorText>
        {!artifacts ? <Loading /> : null}
        {empty ? (
          <Text style={styles.empty}>Nothing made yet. Use the Create tab to make audio, slides, videos and more.</Text>
        ) : null}
        {artifacts && !empty ? <Text style={styles.label}>MADE FROM THIS NOTEBOOK</Text> : null}
        {starting.map((label, i) => (
          <View key={`${label}-${i}`} style={styles.starting} accessibilityLiveRegion="polite">
            <Text style={styles.startingTitle}>Starting your {label}</Text>
            <FlowBar label="Queued for launch" />
          </View>
        ))}
        {artifacts?.map((a) => (
          <ArtifactCard key={a.id} artifact={a} onRemoved={onRefresh} onChanged={onRefresh} />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  column: { flexGrow: 1, padding: 10 },
  card: {
    gap: 12,
    padding: 16,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(10, 12, 18, 0.72)",
  },
  cardEmpty: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { maxWidth: 300, color: colors.text2, fontSize: 16, lineHeight: 24, textAlign: "center" },
  label: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1 },
  starting: {
    gap: 12,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "rgba(33, 124, 255, 0.35)",
    backgroundColor: colors.blue10,
  },
  startingTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
});

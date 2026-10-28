import { type ReactNode, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CloseIcon } from "@/ui/icons";
import { colors, fonts } from "@/ui/theme";
import { pageStyles } from "@/ui/widgets";

/**
 * A popup for studying (a quiz, flashcards, a summary), as the web's StudyOverlay: the title, minimise and close.
 * Minimised, it is a small pill where it was opened, which brings it back where it was; the Android back button
 * minimises too. The popup's content unmounts while minimised, so keep its progress in the component around it.
 */
export function StudyModal({ title, visible, onClose, fill = false, children }: {
  title: string;
  visible: boolean;
  onClose: () => void;
  /** The content takes the popup's whole height (a flashcard deck), rather than its own. */
  fill?: boolean;
  children: ReactNode;
}) {
  const [minimized, setMinimized] = useState(false);
  const close = () => {
    setMinimized(false);
    onClose();
  };
  return (
    <>
      <Modal visible={visible && !minimized} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setMinimized(true)}>
        <SafeAreaView style={pageStyles.sheet} edges={["top", "bottom"]}>
          <View style={pageStyles.sheetHead}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <View style={styles.headActions}>
              <Pressable onPress={() => setMinimized(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Minimise">
                <View style={styles.minus} />
              </Pressable>
              <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
                <CloseIcon size={20} />
              </Pressable>
            </View>
          </View>
          <ScrollView contentContainerStyle={[pageStyles.sheetBody, fill && styles.fill]} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </SafeAreaView>
      </Modal>
      {visible && minimized ? (
        <View style={styles.pill}>
          <Pressable onPress={() => setMinimized(false)} accessibilityRole="button" accessibilityLabel="Open again" style={styles.pillOpen}>
            <View style={styles.pillDot} />
            <Text style={styles.pillTitle} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.pillLink}>Open</Text>
          </Pressable>
          <Pressable onPress={close} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
            <CloseIcon size={14} color={colors.text2} />
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

/** A row with a label on the left and the thumbs on the right: "How was this quiz?" (web: ArtifactFeedback's label). */
export function FeedbackRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.fbRow}>
      <Text style={styles.fbLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { flex: 1, color: colors.text, fontFamily: fonts.displayMedium, fontSize: 19 },
  fill: { flexGrow: 1 },
  headActions: { flexDirection: "row", alignItems: "center", gap: 22, marginLeft: 16 },
  // The web's minimise glyph: one short line (M6 12h12 at 1.8 stroke).
  minus: { width: 14, height: 1.8, borderRadius: 1, backgroundColor: colors.text, marginVertical: 9 },
  fbRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  fbLabel: { flex: 1, color: colors.text2, fontSize: 14, lineHeight: 20 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: 999,
    backgroundColor: colors.surface2,
  },
  pillOpen: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  pillDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.blue },
  pillTitle: { flex: 1, color: colors.text, fontSize: 14 },
  pillLink: { color: colors.blue, fontSize: 14, fontWeight: "600" },
});

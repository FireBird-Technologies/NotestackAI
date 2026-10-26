import { router } from "expo-router";
import { Pressable, StyleSheet, Text } from "react-native";

import { ArrowLeftIcon } from "@/icons";
import { colors } from "@/theme";

/** "← Back", as the web's video pages: where you came from, else the Library (opened from a notebook or a link,
 * there is no screen behind it in this stack). */
export function BackLink() {
  return (
    <Pressable
      onPress={() => (router.canGoBack() ? router.back() : router.replace("/library"))}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={styles.back}>
      <ArrowLeftIcon size={16} color={colors.text2} />
      <Text style={styles.text}>Back</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingVertical: 4 },
  text: { color: colors.text2, fontSize: 15 },
});

import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, gutter } from "@/theme";

export type NotebookTab = "sources" | "chat" | "create" | "library";

const TABS: { id: NotebookTab; label: string }[] = [
  { id: "sources", label: "Sources" },
  { id: "chat", label: "Chat" },
  { id: "create", label: "Create" },
  { id: "library", label: "Library" },
];

/** A notebook's top bar as on the web app on a phone: back to the notebooks, and the four tabs in one pill. */
export function NotebookBar({ tab, onTab }: { tab: NotebookTab; onTab: (t: NotebookTab) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingTop: insets.top }]}>
      <View style={styles.row}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.navigate("/notebooks"))}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="All notebooks"
          style={styles.back}>
          <SymbolView name={{ ios: "chevron.left", android: "arrow_back" }} size={20} tintColor={colors.text} />
        </Pressable>
        <View style={styles.tabs} accessibilityRole="tablist">
          {TABS.map((t) => {
            const on = t.id === tab;
            return (
              <Pressable
                key={t.id}
                onPress={() => onTab(t.id)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={[styles.tab, on && styles.tabOn]}>
                <Text style={[styles.text, on && styles.textOn]} numberOfLines={1}>
                  {t.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.black, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  row: { height: 60, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: gutter },
  back: { paddingVertical: 6, paddingRight: 2 },
  tabs: {
    flex: 1,
    flexDirection: "row",
    padding: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  tab: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 999 },
  tabOn: { backgroundColor: colors.blue },
  text: { color: colors.text2, fontSize: 15, fontWeight: "500" },
  textOn: { color: colors.white, fontWeight: "600" },
});

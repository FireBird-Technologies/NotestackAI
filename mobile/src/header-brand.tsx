import { Image } from "expo-image";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useDrawer } from "@/nav-drawer";
import { colors, fonts, gutter } from "@/theme";

/** A section's top bar as on the web app on a phone: the menu button, the logo and the section name, on the left. */
function AppBar({ title }: { title: string }) {
  const insets = useSafeAreaInsets();
  const { open } = useDrawer();
  return (
    <View style={[styles.bar, { paddingTop: insets.top }]}>
      <View style={styles.row}>
        <Pressable onPress={open} hitSlop={10} accessibilityRole="button" accessibilityLabel="Open menu" style={styles.menu}>
          <Image source={require("@/assets/images/ui/menu.png")} style={styles.menuIcon} tintColor={colors.text} />
        </Pressable>
        <Pressable onPress={() => router.navigate("/notebooks")} accessibilityRole="link" accessibilityLabel="Notestack home">
          <Image source={require("@/assets/images/logo.png")} style={styles.logo} accessibilityIgnoresInvertColors />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
      </View>
    </View>
  );
}

/**
 * Header options for the first screen of each section. A custom bar rather than the native one: iOS centres native
 * titles and puts left items in a glass capsule, and the web bar has neither.
 */
export function brandHeader(title: string) {
  return { title, header: () => <AppBar title={title} /> };
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.black,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  row: { height: 56, flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: gutter * 1.25 },
  menu: { paddingVertical: 4, paddingRight: 4 },
  menuIcon: { width: 26, height: 26 },
  logo: { width: 32, height: 32, borderRadius: 8 },
  title: { flex: 1, color: colors.text, fontFamily: fonts.displayBold, fontSize: 22 },
});

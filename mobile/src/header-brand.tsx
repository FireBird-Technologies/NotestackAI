import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, fonts, gutter } from "@/theme";

/** A tab's top bar as on the web app on a phone: the logo and the section name, on the left. */
function AppBar({ title }: { title: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingTop: insets.top }]}>
      <View style={styles.row}>
        <Image source={require("@/assets/images/logo.png")} style={styles.logo} accessibilityIgnoresInvertColors />
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
      </View>
    </View>
  );
}

/**
 * Header options for the first screen of each tab. A custom bar rather than the native one: iOS centres native
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
  row: { height: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: gutter * 1.25 },
  logo: { width: 32, height: 32, borderRadius: 8 },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 22 },
});

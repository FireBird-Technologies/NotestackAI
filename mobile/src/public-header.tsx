import { Image } from "expo-image";
import { router, type Href } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut, SlideInUp, SlideOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, fonts, gutter, radius } from "@/theme";

/** The web app's mobile menu (frontend/src/components/PublicChrome.tsx); each item is a screen in the app. */
const LINKS: { label: string; path: Href }[] = [
  { label: "Features", path: "/features" },
  { label: "Pricing", path: "/pricing" },
  { label: "Free tools", path: "/tools" },
  { label: "Blog", path: "/blogs" },
];

const BAR_HEIGHT = 60;

/**
 * The signed out screens' navbar, as on the web: the logo (back to the landing page) and a menu button that drops a
 * panel of links down from the bar. Render it last inside the screen so the panel sits above the content.
 */
export function PublicHeader() {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  // Back to the landing page: pops the screens above it, or replaces this one when it is not underneath.
  const home = () => {
    setOpen(false);
    router.dismissTo("/welcome");
  };
  const visit = (path: Href) => {
    setOpen(false);
    router.navigate(path);
  };

  return (
    <View style={styles.layer} pointerEvents="box-none">
      {open && (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(160)} style={styles.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} accessibilityLabel="Close menu" />
        </Animated.View>
      )}

      {/* Solid behind the status bar and the bar, so content scrolling underneath does not show through. */}
      <View style={[styles.top, { paddingTop: insets.top }, open && styles.topOpen]}>
        <View style={styles.bar}>
          <Pressable
            onPress={home}
            accessibilityRole="link"
            accessibilityLabel="Notestack home"
            hitSlop={8}
            style={({ pressed }) => [styles.brand, pressed && styles.pressed]}>
            <Image source={require("@/assets/images/logo.png")} style={styles.logo} accessibilityIgnoresInvertColors />
            <Text style={styles.wordmark}>Notestack</Text>
          </Pressable>
          <Pressable
            onPress={() => setOpen((o) => !o)}
            accessibilityRole="button"
            accessibilityLabel={open ? "Close menu" : "Open menu"}
            accessibilityState={{ expanded: open }}
            style={({ pressed }) => [styles.menuButton, pressed && styles.pressed]}>
            {open ? <CloseIcon /> : <MenuIcon />}
          </Pressable>
        </View>
      </View>

      {open && (
        <Animated.View
          entering={SlideInUp.duration(220)}
          exiting={SlideOutUp.duration(180)}
          style={styles.panel}
          accessibilityRole="menu">
          {LINKS.map((link) => (
            <Pressable
              key={link.label}
              onPress={() => visit(link.path)}
              accessibilityRole="menuitem"
              style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}>
              <Text style={styles.itemText}>{link.label}</Text>
            </Pressable>
          ))}
        </Animated.View>
      )}
    </View>
  );
}

/** Height of the bar below the status bar, for screens laying out content under it. */
export const PUBLIC_HEADER_HEIGHT = BAR_HEIGHT;

function MenuIcon() {
  return (
    <View style={styles.icon}>
      <View style={styles.stroke} />
      <View style={styles.stroke} />
      <View style={styles.stroke} />
    </View>
  );
}

function CloseIcon() {
  return (
    <View style={[styles.icon, styles.close]}>
      <View style={[styles.stroke, styles.crossA]} />
      <View style={[styles.stroke, styles.crossB]} />
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0, 0, 0, 0.55)" },
  bar: {
    height: BAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: gutter * 1.5,
  },
  top: { backgroundColor: colors.black, borderBottomWidth: 1, borderBottomColor: colors.line },
  // The open menu panel draws its own bottom edge.
  topOpen: { borderBottomWidth: 0 },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  logo: { width: 34, height: 34, borderRadius: 9 },
  wordmark: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 22, letterSpacing: -0.2 },
  menuButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "#0b0b0b",
  },
  pressed: { opacity: 0.7 },
  icon: { width: 20, height: 14, justifyContent: "space-between" },
  close: { justifyContent: "center" },
  stroke: { height: 2, borderRadius: 1, backgroundColor: colors.white },
  crossA: { position: "absolute", left: 0, right: 0, transform: [{ rotate: "45deg" }] },
  crossB: { position: "absolute", left: 0, right: 0, transform: [{ rotate: "-45deg" }] },
  panel: {
    backgroundColor: colors.black,
    paddingHorizontal: gutter * 1.5,
    paddingBottom: gutter,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  item: { paddingVertical: 16, paddingHorizontal: 12, borderRadius: radius.sm },
  itemPressed: { backgroundColor: colors.surface2 },
  itemText: { color: colors.text2, fontSize: 19 },
});

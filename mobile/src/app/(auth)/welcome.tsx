import { router } from "expo-router";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Horizon } from "@/shell/horizon";
import { Starfield } from "@/shell/starfield";
import { PUBLIC_HEADER_HEIGHT, PublicHeader } from "@/shell/public-header";
import { colors, fonts, gutter } from "@/ui/theme";
import { Button } from "@/ui";

/** How much of the screen width the planet's glowing edge rises from the bottom. */
const HORIZON = 0.16;

/** The first screen a signed out person sees: the web landing page's hero, then on to sign in. */
export default function Welcome() {
  const { width } = useWindowDimensions();
  return (
    <View style={styles.fill}>
      <Starfield />
      <Horizon rise={HORIZON} />
      <SafeAreaView style={styles.fill} edges={["top", "bottom"]}>
        <View style={[styles.hero, { paddingTop: PUBLIC_HEADER_HEIGHT }]}>
          <Text style={styles.eyebrow}>
            <Text style={styles.eyebrowStrong}>The ultimate NotebookLM alternative</Text> for writers, bloggers and
            newsletters
          </Text>
          <Text style={styles.title} accessibilityRole="header">
            Your knowledge,{"\n"}
            <Text style={styles.glow}>in orbit.</Text>
          </Text>
          <Text style={styles.sub}>
            Notestack turns your blog, newsletter, site or markdown files into a research notebook you can question,
            podcasts you can publish and launch kits for every platform. Every word traced back to what you actually
            wrote.
          </Text>
        </View>

        <View style={[styles.actions, { paddingBottom: width * HORIZON + 4 }]}>
          <Button title="Get started" onPress={() => router.push("/sign-in")} />
          <Button title="New here? Create a free account" variant="link" onPress={() => router.push("/sign-up")} />
          <Text style={styles.meta}>
            Works with Substack, Ghost, WordPress, Medium, any RSS feed or site, and markdown files.
          </Text>
        </View>
      </SafeAreaView>
      <PublicHeader />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "transparent" },
  hero: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: gutter * 1.5, gap: 18 },
  eyebrow: {
    color: colors.blue,
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: 20,
    letterSpacing: 2,
    textTransform: "uppercase",
    textAlign: "center",
  },
  eyebrowStrong: { color: colors.text, textDecorationLine: "underline", textDecorationColor: colors.blue },
  title: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 46,
    lineHeight: 51,
    letterSpacing: -1,
    textAlign: "center",
  },
  glow: {
    color: colors.blue,
    textShadowColor: colors.blue,
    textShadowRadius: 18,
    textShadowOffset: { width: 0, height: 0 },
  },
  sub: { color: colors.text2, fontSize: 17.5, lineHeight: 26, textAlign: "center" },
  actions: { paddingHorizontal: gutter * 1.5, gap: 4 },
  meta: {
    color: colors.text3,
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: 19,
    textAlign: "center",
    marginTop: 8,
  },
});

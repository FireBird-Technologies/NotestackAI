import { FEATURES, STEPS } from "@notestack/shared/content/marketing";
import { router } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { Card, Eyebrow, Lede, PageTitle, PublicPage, publicText, SectionTitle } from "@/shell/public-page";
import { colors, fonts } from "@/ui/theme";
import { Button } from "@/ui";

/** The landing page's "What you get" and "How it works" sections, as their own screen. */
export default function Features() {
  return (
    <PublicPage>
      <Eyebrow>What you get</Eyebrow>
      <PageTitle>Everything your writing can become</PageTitle>
      <Lede>One archive in, every format out, and every word traced back to what you actually wrote.</Lede>

      {FEATURES.map((f) => (
        <Card key={f.label}>
          <Text style={styles.label}>{f.label}</Text>
          <Text style={publicText.cardTitle}>{f.title}</Text>
          <Text style={publicText.body}>{f.body}</Text>
        </Card>
      ))}

      <Eyebrow>How it works</Eyebrow>
      <SectionTitle>Three steps to liftoff</SectionTitle>
      {STEPS.map((s) => (
        <View key={s.n} style={styles.step}>
          <Text style={styles.stepN}>{s.n}</Text>
          <View style={styles.stepText}>
            <Text style={publicText.cardTitle}>{s.title}</Text>
            <Text style={publicText.body}>{s.body}</Text>
          </View>
        </View>
      ))}

      <View style={styles.cta}>
        <Button title="Start free" onPress={() => router.navigate("/sign-up")} />
      </View>
    </PublicPage>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 1, textTransform: "uppercase" },
  step: { flexDirection: "row", gap: 16, paddingVertical: 6 },
  stepN: { color: colors.blue, fontFamily: fonts.mono, fontSize: 18, lineHeight: 26 },
  stepText: { flex: 1, gap: 6 },
  cta: { marginTop: 16 },
});

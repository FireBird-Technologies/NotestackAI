import { FEATURES, STEPS } from "@notestack/shared/content/marketing";
import { router } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { Card, Eyebrow, Lede, PageTitle, PublicPage, publicText, SectionTitle } from "@/shell/public-page";
import { colors, fonts } from "@/ui/theme";
import { Button } from "@/ui";
import i18n, { tKey } from "@/i18n";

/** The landing page's "What you get" and "How it works" sections, as their own screen. */
export default function Features() {
  return (
    <PublicPage>
      <Eyebrow>{i18n.t("marketing.whatYouGet")}</Eyebrow>
      <PageTitle>{i18n.t("marketing.featuresTitle")}</PageTitle>
      <Lede>{i18n.t("marketing.featuresLede")}</Lede>

      {FEATURES.map((f, i) => (
        <Card key={f.label}>
          <Text style={styles.label}>{tKey(`marketing.features.${i}.label`, f.label)}</Text>
          <Text style={publicText.cardTitle}>{tKey(`marketing.features.${i}.title`, f.title)}</Text>
          <Text style={publicText.body}>{tKey(`marketing.features.${i}.body`, f.body)}</Text>
        </Card>
      ))}

      <Eyebrow>{i18n.t("marketing.howItWorks")}</Eyebrow>
      <SectionTitle>{i18n.t("marketing.stepsTitle")}</SectionTitle>
      {STEPS.map((s, i) => (
        <View key={s.n} style={styles.step}>
          <Text style={styles.stepN}>{s.n}</Text>
          <View style={styles.stepText}>
            <Text style={publicText.cardTitle}>{tKey(`marketing.steps.${i}.title`, s.title)}</Text>
            <Text style={publicText.body}>{tKey(`marketing.steps.${i}.body`, s.body)}</Text>
          </View>
        </View>
      ))}

      <View style={styles.cta}>
        <Button title={i18n.t("marketing.startFree")} onPress={() => router.navigate("/sign-up")} />
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

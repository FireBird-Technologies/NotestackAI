import { tools, toolsHub } from "@notestack/shared/content/tools";
import { router } from "expo-router";
import { StyleSheet, Text } from "react-native";
import { Pressable } from "@/ui/pressable";

import { Card, Eyebrow, Lede, PageTitle, PublicPage, publicText } from "@/shell/public-page";
import { colors } from "@/ui/theme";

export default function ToolsHub() {
  return (
    <PublicPage>
      <Eyebrow>Free tools</Eyebrow>
      <PageTitle>{toolsHub.heroTitle}</PageTitle>
      <Lede>{toolsHub.heroDescription}</Lede>
      {tools.map((t) => (
        <Pressable
          key={t.slug}
          accessibilityRole="link"
          onPress={() => router.push({ pathname: "/tools/[slug]", params: { slug: t.slug } })}
          style={({ pressed }) => pressed && styles.pressed}>
          <Card>
            <Text style={publicText.cardTitle}>{t.heroTitle}</Text>
            <Text style={publicText.body}>{t.description}</Text>
            <Text style={styles.open}>Open tool →</Text>
          </Card>
        </Pressable>
      ))}
    </PublicPage>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  open: { color: colors.blue, fontSize: 16, fontWeight: "600" },
});

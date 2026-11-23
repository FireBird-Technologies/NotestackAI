import { blogPosts, missionNumber, missionOf } from "@notestack/shared/content/blogPosts";
import { router } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { Card, Eyebrow, Lede, PageTitle, PublicPage, publicText } from "@/shell/public-page";
import { colors, fonts } from "@/ui/theme";
import i18n from "@/i18n";

const POSTS = [...blogPosts].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

/** The blog index, as the web's mission log: newest first, each post led by the question it answers. */
export default function Blog() {
  return (
    <PublicPage>
      <Eyebrow>{i18n.t("marketing.missionLog")}</Eyebrow>
      <PageTitle>{i18n.t("marketing.blogTitle")}</PageTitle>
      <Lede>{i18n.t("marketing.blogLede")}</Lede>
      {POSTS.map((p) => (
        <Pressable
          key={p.slug}
          accessibilityRole="link"
          onPress={() => router.push({ pathname: "/blogs/[slug]", params: { slug: p.slug } })}
          style={({ pressed }) => pressed && styles.pressed}>
          <Card>
            <View style={styles.meta}>
              <Text style={styles.mission}>{i18n.t("marketing.mission", { n: missionNumber(p) })}</Text>
              <Text style={publicText.mono}>{p.category}</Text>
            </View>
            <Text style={styles.question}>{missionOf(p).question}</Text>
            <Text style={publicText.cardTitle}>{p.title}</Text>
            <Text style={publicText.mono}>
              {i18n.t("marketing.waypoints", { count: p.sections.length, time: p.readTime })}
            </Text>
          </Card>
        </Pressable>
      ))}
    </PublicPage>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  meta: { flexDirection: "row", justifyContent: "space-between" },
  mission: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 0.5 },
  question: { color: colors.text2, fontSize: 16, lineHeight: 23, fontStyle: "italic" },
});

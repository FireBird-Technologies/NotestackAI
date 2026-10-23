import { blogPosts, missionNumber, missionOf } from "@notestack/shared/content/blogPosts";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Card, Eyebrow, Lede, PageTitle, PublicPage, publicText } from "@/public-page";
import { colors, fonts } from "@/theme";

const POSTS = [...blogPosts].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

/** The blog index, as the web's mission log: newest first, each post led by the question it answers. */
export default function Blog() {
  return (
    <PublicPage>
      <Eyebrow>Mission log</Eyebrow>
      <PageTitle>Every post is a search for an answer</PageTitle>
      <Lede>
        Pick a question. Each mission follows it through a few waypoints until the answer comes into view: research,
        deep writing, audio, video and distribution.
      </Lede>
      {POSTS.map((p) => (
        <Pressable
          key={p.slug}
          accessibilityRole="link"
          onPress={() => router.push({ pathname: "/blogs/[slug]", params: { slug: p.slug } })}
          style={({ pressed }) => pressed && styles.pressed}>
          <Card>
            <View style={styles.meta}>
              <Text style={styles.mission}>Mission {missionNumber(p)}</Text>
              <Text style={publicText.mono}>{p.category}</Text>
            </View>
            <Text style={styles.question}>{missionOf(p).question}</Text>
            <Text style={publicText.cardTitle}>{p.title}</Text>
            <Text style={publicText.mono}>
              {p.sections.length} waypoints · {p.readTime}
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

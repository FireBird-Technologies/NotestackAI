import { formatPostDate, getPost, missionNumber, missionOf } from "@notestack/shared/content/blogPosts";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import {
  ContentSection,
  Eyebrow,
  Faq,
  Inline,
  Lede,
  PageTitle,
  PublicPage,
  publicText,
  Related,
} from "@/public-page";
import { colors, fonts, gutter, radius } from "@/theme";
import { Button } from "@/ui";

/** One post: the question it answers and the short answer up front, then its sections, questions and related reads. */
export default function BlogPost() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const post = getPost(slug);

  if (!post) {
    return (
      <PublicPage>
        <PageTitle>Post not found</PageTitle>
        <Button title="See all posts" variant="secondary" onPress={() => router.navigate("/blogs")} />
      </PublicPage>
    );
  }

  const mission = missionOf(post);
  return (
    <PublicPage>
      <Eyebrow>
        Mission {missionNumber(post)} · {post.heroEyebrow}
      </Eyebrow>
      <PageTitle>{post.title}</PageTitle>
      <Text style={publicText.mono}>
        {formatPostDate(post.publishedAt)} · {post.readTime} · {post.sections.length} waypoints
      </Text>

      <View style={styles.answer}>
        <Text style={styles.query}>{mission.question}</Text>
        <Inline text={mission.answer} style={publicText.body} />
      </View>

      {post.heroImage ? (
        <Image
          source={{ uri: `https://notestack.ai${post.heroImage}` }}
          accessibilityLabel={post.heroImageAlt ?? ""}
          style={styles.hero}
          contentFit="cover"
          transition={200}
        />
      ) : null}

      <Lede>{post.heroDescription}</Lede>
      {post.sections.map((s) => (
        <ContentSection key={s.heading} {...s} />
      ))}
      <Faq items={post.faq} />
      <Related paths={post.relatedPaths} />
    </PublicPage>
  );
}

const styles = StyleSheet.create({
  answer: {
    gap: 8,
    padding: gutter,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.blue20,
    backgroundColor: colors.blue10,
  },
  query: { color: colors.blue, fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 },
  hero: { width: "100%", aspectRatio: 1.9, borderRadius: radius.md, backgroundColor: colors.surface2 },
});

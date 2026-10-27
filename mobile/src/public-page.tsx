import { router, type Href } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { getPost } from "@notestack/shared/content/blogPosts";
import { getTool } from "@notestack/shared/content/tools";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { PUBLIC_HEADER_HEIGHT, PublicHeader } from "@/public-header";
import { Starfield } from "@/starfield";
import { colors, fonts, gutter, radius } from "@/theme";

const SITE = "https://notestack.ai";

/** Paths the app has its own screen for; anything else on notestack.ai opens in the in-app browser. */
const APP_PATHS = [/^\/features$/, /^\/pricing$/, /^\/tools(\/[\w-]+)?$/, /^\/blogs(\/[\w-]+)?$/];

/** Follow a link from public copy: an app screen when there is one, else the page in the in-app browser. */
export function openLink(href: string) {
  const path = href.replace(/^https?:\/\/(www\.)?notestack\.ai/, "").replace(/#.*$/, "") || "/";
  if (href.startsWith("/") || href !== path) {
    if (APP_PATHS.some((re) => re.test(path))) return router.navigate(path as Href);
    if (path === "/") return router.navigate("/welcome");
    return void WebBrowser.openBrowserAsync(`${SITE}${path}`, { controlsColor: colors.blue });
  }
  void WebBrowser.openBrowserAsync(href, { controlsColor: colors.blue });
}

const INLINE = /(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)/g;

/** Inline [text](url) links and **bold** inside the shared copy, as on the web (pages/Blog.tsx Inline). */
export function Inline({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, link, bold] = m;
    if (link) {
      const label = link.slice(1, link.indexOf("]("));
      const href = link.slice(link.indexOf("](") + 2, -1);
      out.push(
        <Text key={at} style={styles.link} onPress={() => openLink(href)} accessibilityRole="link">
          {label}
        </Text>,
      );
    } else if (bold) {
      out.push(
        <Text key={at} style={styles.bold}>
          {bold.slice(2, -2)}
        </Text>,
      );
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <Text style={style}>{out}</Text>;
}

/** A public page (Features, Pricing, Free tools, Blog): the night sky, the navbar and a scrolling column. */
export function PublicPage({ children }: { children: ReactNode }) {
  return (
    <View style={styles.fill}>
      <Starfield />
      <SafeAreaView style={styles.fill} edges={["top"]}>
        <ScrollView contentContainerStyle={[styles.column, { paddingTop: PUBLIC_HEADER_HEIGHT + gutter }]}>
          {children}
        </ScrollView>
      </SafeAreaView>
      <PublicHeader />
    </View>
  );
}

/** The mono, blue, upper case line over a page or section title. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.pageTitle} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.sectionTitle} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Lede({ children }: { children: ReactNode }) {
  return <Text style={styles.lede}>{children}</Text>;
}

/** A dark glass card, as the web's .card. */
export function Card({ children, highlight }: { children: ReactNode; highlight?: boolean }) {
  return <View style={[styles.card, highlight && styles.cardHighlight]}>{children}</View>;
}

/** One section of a post or tool page: heading, paragraphs, bullets and an optional callout. */
export function ContentSection({
  heading,
  paragraphs,
  bullets,
  callout,
}: {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  callout?: string;
}) {
  return (
    <View style={styles.section}>
      <SectionTitle>{heading}</SectionTitle>
      {paragraphs.map((p, i) => (
        <Inline key={i} text={p} style={publicText.body} />
      ))}
      {bullets?.map((b) => (
        <View key={b} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Inline text={b} style={publicText.bullet} />
        </View>
      ))}
      {callout ? (
        <View style={styles.callout}>
          <Inline text={callout} style={publicText.body} />
        </View>
      ) : null}
    </View>
  );
}

/** Questions that open to their answers, as the web's <details> list. */
export function Faq({ items }: { items: { question: string; answer: string }[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return null;
  return (
    <View style={styles.section}>
      <SectionTitle>Questions</SectionTitle>
      {items.map((f) => {
        const expanded = open === f.question;
        return (
          <Pressable
            key={f.question}
            onPress={() => setOpen(expanded ? null : f.question)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            style={styles.faq}>
            <View style={styles.faqHead}>
              <Text style={styles.faqQuestion}>{f.question}</Text>
              <Text style={styles.faqSign}>{expanded ? "−" : "+"}</Text>
            </View>
            {expanded ? <Inline text={f.answer} style={publicText.body} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** A page's title for a related link: the post or tool it names, else the path itself. */
function pathTitle(path: string): string {
  const [, kind, slug] = path.split("/");
  if (kind === "blogs" && slug) return getPost(slug)?.title ?? path;
  if (kind === "tools" && slug) return getTool(slug)?.heroTitle ?? path;
  return path;
}

/** "Keep exploring": links to related posts and tools. */
export function Related({ paths }: { paths: string[] }) {
  if (!paths.length) return null;
  return (
    <View style={styles.section}>
      <SectionTitle>Keep exploring</SectionTitle>
      {paths.map((p) => (
        <Text key={p} style={[publicText.body, styles.link]} onPress={() => openLink(p)} accessibilityRole="link">
          {pathTitle(p)}
        </Text>
      ))}
    </View>
  );
}

export const publicText = StyleSheet.create({
  body: { color: colors.text2, fontSize: 17, lineHeight: 26 },
  small: { color: colors.text3, fontSize: 14, lineHeight: 20 },
  mono: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5, letterSpacing: 0.5 },
  cardTitle: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 21, lineHeight: 26 },
  bullet: { color: colors.text2, fontSize: 17, lineHeight: 26, flex: 1 },
});

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.black },
  column: { paddingHorizontal: gutter * 1.25, paddingBottom: gutter * 4, gap: gutter },
  link: { color: colors.blue, textDecorationLine: "underline" },
  bold: { fontWeight: "700", color: colors.text },
  eyebrow: {
    color: colors.blue,
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: 20,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginTop: gutter,
  },
  pageTitle: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 36, lineHeight: 41, letterSpacing: -0.8 },
  sectionTitle: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 26,
    lineHeight: 31,
    letterSpacing: -0.4,
    marginTop: gutter,
  },
  lede: { color: colors.text2, fontSize: 18, lineHeight: 27 },
  card: {
    padding: gutter * 1.25,
    gap: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(10, 12, 18, 0.85)",
  },
  section: { gap: 12 },
  bulletRow: { flexDirection: "row", gap: 10, paddingLeft: 4 },
  bulletDot: { color: colors.blue, fontSize: 17, lineHeight: 26 },
  callout: { borderLeftWidth: 2, borderLeftColor: colors.blue, paddingLeft: gutter, paddingVertical: 4 },
  faq: { paddingVertical: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: colors.line },
  faqHead: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  faqQuestion: { flex: 1, color: colors.text, fontSize: 17, lineHeight: 24, fontWeight: "600" },
  faqSign: { color: colors.blue, fontSize: 22, lineHeight: 24 },
  // Solid (the card's see-through fill over black), so iOS can draw the glow from the card's shape.
  cardHighlight: { borderColor: colors.blue, backgroundColor: "#080a0f", shadowColor: colors.blue, shadowOpacity: 0.5, shadowRadius: 18 },
});

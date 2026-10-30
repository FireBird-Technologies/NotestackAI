import { type Block, inlineTokens, type ListItem, parse } from "@notestack/shared/markdown";
import type { Citation } from "@notestack/shared/types";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import * as WebBrowser from "expo-web-browser";
import { type ReactNode, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { colors, fonts, radius } from "@/ui/theme";

/* The web's Markdown (frontend/src/components/Markdown.tsx) drawn natively, from the same parser: headings, paragraphs,
   lists (one nested level, tasks), quotes, code, tables, images, rules, and inline bold, italic, strikethrough, code,
   links and [n] citation markers that open the cited lines. */

type Cite = { citations?: Citation[]; onCite?: (c: Citation) => void };

const open = (href: string) => void WebBrowser.openBrowserAsync(href, { controlsColor: colors.blue });

/** A line's inline marks as nested Text, so it wraps as one paragraph. */
function inline(text: string, cite: Cite, key: string): ReactNode[] {
  const byMarker = new Map((cite.citations ?? []).map((c) => [c.marker, c]));
  return inlineTokens(text).map((t, i) => {
    const k = `${key}-${i}`;
    switch (t.kind) {
      case "text":
        return t.text;
      case "code":
        return (
          <Text key={k} style={styles.inlineCode}>
            {t.text}
          </Text>
        );
      case "bold":
        return (
          <Text key={k} style={styles.bold}>
            {inline(t.text, cite, k)}
          </Text>
        );
      case "italic":
        return (
          <Text key={k} style={styles.italic}>
            {inline(t.text, cite, k)}
          </Text>
        );
      case "strike":
        return (
          <Text key={k} style={styles.strike}>
            {inline(t.text, cite, k)}
          </Text>
        );
      case "image":
        return t.alt || "";
      case "link":
        return t.href && /^https?:|^mailto:/i.test(t.href) ? (
          <Text key={k} style={styles.link} onPress={() => open(t.href!)} accessibilityRole="link">
            {inline(t.label, cite, k)}
          </Text>
        ) : (
          <Text key={k}>{inline(t.label, cite, k)}</Text>
        );
      case "url":
        return (
          <Text key={k} style={styles.link} onPress={() => open(t.href)} accessibilityRole="link">
            {t.href}
          </Text>
        );
      case "cite":
        return t.markers.map((n) => {
          const c = byMarker.get(n);
          return c ? (
            <Text key={`${k}-${n}`} style={styles.cite} onPress={() => cite.onCite?.(c)} accessibilityRole="button" accessibilityLabel={`Source ${n}: ${c.title}`}>
              {` ${c.marker} `}
            </Text>
          ) : (
            <Text key={`${k}-${n}`} style={styles.citeOff}>
              {n}
            </Text>
          );
        });
    }
  });
}

const COLLAPSE_AT = 24; // lines

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n");
  const long = lines.length > COLLAPSE_AT;
  const [shownAll, setShownAll] = useState(!long);
  return (
    <View style={styles.code}>
      <View style={styles.codeBar}>
        <Text style={styles.codeLang}>{lang || "code"}</Text>
        <Pressable
          onPress={async () => {
            await Clipboard.setStringAsync(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          hitSlop={8}
          accessibilityRole="button">
          <Text style={styles.codeLang}>{copied ? "Copied" : "Copy"}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={styles.codeText} selectable>
          {shownAll ? code : lines.slice(0, COLLAPSE_AT).join("\n")}
        </Text>
      </ScrollView>
      {long ? (
        <Pressable onPress={() => setShownAll((o) => !o)} accessibilityRole="button">
          <Text style={styles.codeMore}>{shownAll ? "Show less" : `Show all ${lines.length} lines`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Items({ items, ordered, cite, k, start = 1 }: { items: ListItem[]; ordered: boolean; cite: Cite; k: string; start?: number }) {
  return (
    <View style={styles.list}>
      {items.map((it, j) => (
        <View key={`${k}-${j}`} style={styles.item}>
          <Text style={styles.bullet}>{it.task ? (it.done ? "☑" : "☐") : ordered ? `${start + j}.` : "•"}</Text>
          <View style={styles.itemBody}>
            <Text style={[styles.p, it.task && it.done && styles.strike]}>{inline(it.text, cite, `${k}-${j}`)}</Text>
            {it.children.length ? <Items items={it.children} ordered={ordered} cite={cite} k={`${k}-${j}-c`} /> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function Table({ b, cite, k }: { b: Extract<Block, { kind: "table" }>; cite: Cite; k: string }) {
  const cell = (text: string, j: number, head: boolean, key: string) => (
    <View key={key} style={[styles.cell, head && styles.headCell]}>
      <Text style={[styles.cellText, head && styles.bold, b.align[j] && { textAlign: b.align[j] }]}>{inline(text, cite, key)}</Text>
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tableWrap}>
      <View>
        <View style={styles.row}>{b.head.map((h, j) => cell(h, j, true, `${k}-h${j}`))}</View>
        {b.rows.map((r, j) => (
          <View key={j} style={styles.row}>
            {r.map((c, n) => cell(c, n, false, `${k}-${j}-${n}`))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function Figure({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const [ratio, setRatio] = useState(16 / 9);
  const [broken, setBroken] = useState(false);
  if (broken) return <Text style={styles.broken}>[image: {alt || src}]</Text>;
  return (
    <Pressable onPress={() => open(src)} accessibilityRole="imagebutton" accessibilityLabel={alt || "Open image"} style={styles.figure}>
      <Image
        source={{ uri: src }}
        style={[styles.image, { aspectRatio: ratio }]}
        contentFit="contain"
        onLoad={(e) => e.source.width && e.source.height && setRatio(e.source.width / e.source.height)}
        onError={() => setBroken(true)}
      />
      {title || alt ? <Text style={styles.caption}>{title || alt}</Text> : null}
    </Pressable>
  );
}

/**
 * Generated text as Markdown (web: Markdown). `reportHeadings`: a report's page, where "#" and "##" are its sections,
 * not the chat's small headings.
 */
export function Markdown({ text, citations, onCite, reportHeadings = false }: { text: string; reportHeadings?: boolean } & Cite) {
  const cite = { citations, onCite };
  const heading = reportHeadings ? [styles.rh2, styles.rh2, styles.h3, styles.h4, styles.h5, styles.h5] : [styles.h3, styles.h3, styles.h4, styles.h5, styles.h5, styles.h5];
  // A report's page reads larger and softer (web: .rp-prose).
  const para = reportHeadings ? [styles.p, styles.rp] : styles.p;
  return (
    <View style={styles.md}>
      {parse(text).map((b, i) => {
        const k = `b${i}`;
        switch (b.kind) {
          case "h":
            return (
              <Text key={k} style={heading[b.level - 1]} accessibilityRole="header">
                {inline(b.text, cite, k)}
              </Text>
            );
          case "p":
            return (
              <Text key={k} style={para}>
                {inline(b.text, cite, k)}
              </Text>
            );
          case "ul":
          case "ol":
            return <Items key={k} items={b.items} ordered={b.kind === "ol"} cite={cite} k={k} start={b.start} />;
          case "quote":
            return (
              <View key={k} style={styles.quote}>
                <Text style={styles.p}>{inline(b.text, cite, k)}</Text>
              </View>
            );
          case "code":
            return <CodeBlock key={k} code={b.text} lang={b.lang} />;
          case "img":
            return <Figure key={k} src={b.src} alt={b.alt} title={b.title} />;
          case "table":
            return <Table key={k} b={b} cite={cite} k={k} />;
          case "hr":
            return <View key={k} style={styles.hr} />;
          default:
            return null;
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  md: { gap: 12 },
  p: { color: colors.text, fontSize: 16, lineHeight: 25 },
  rh2: { color: colors.text, fontFamily: fonts.displayMedium, fontWeight: "400", fontSize: 30, lineHeight: 35, letterSpacing: -0.3, marginBottom: 6 },
  rp: { color: colors.text2, fontSize: 16.5, lineHeight: 30 },
  h3: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 19, lineHeight: 26, marginTop: 6 },
  h4: { color: colors.text, fontFamily: fonts.displayMedium, fontSize: 17, lineHeight: 24, marginTop: 4 },
  h5: { color: colors.text2, fontFamily: fonts.displayMedium, fontSize: 15.5, lineHeight: 22 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through", color: colors.text3 },
  link: { color: colors.text, textDecorationLine: "underline", textDecorationColor: colors.blue },
  inlineCode: { fontFamily: fonts.mono, fontSize: 14, color: colors.text, backgroundColor: colors.surface2 },
  cite: { fontFamily: fonts.mono, fontSize: 12, color: colors.blue, backgroundColor: colors.blue10 },
  citeOff: { fontFamily: fonts.mono, fontSize: 11, color: colors.text3 },
  list: { gap: 6 },
  item: { flexDirection: "row", gap: 8 },
  bullet: { color: colors.text2, fontSize: 16, lineHeight: 25, minWidth: 16 },
  itemBody: { flex: 1, gap: 6 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.blue, paddingLeft: 12 },
  code: { borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line, backgroundColor: "#0b0d12", overflow: "hidden" },
  codeBar: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line },
  codeLang: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12 },
  codeText: { color: colors.text, fontFamily: fonts.mono, fontSize: 13, lineHeight: 20, padding: 12 },
  codeMore: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12, padding: 10 },
  tableWrap: { borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line },
  row: { flexDirection: "row" },
  cell: { width: 160, padding: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  headCell: { backgroundColor: colors.surface2 },
  cellText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong, marginVertical: 6 },
  figure: { gap: 6 },
  image: { width: "100%", borderRadius: radius.sm + 2, backgroundColor: colors.surface },
  caption: { color: colors.text3, fontSize: 13, textAlign: "center" },
  broken: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13 },
});

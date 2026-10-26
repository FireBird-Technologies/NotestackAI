import { Fragment } from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, fonts } from "@/theme";

/** **bold**, *italic*, `code` and [n] citation markers inside one line. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[\d+\])/g);
  return (
    <>
      {parts.map((p, i) => {
        if (!p) return null;
        if (p.startsWith("**") && p.endsWith("**")) return <Text key={i} style={styles.bold}>{p.slice(2, -2)}</Text>;
        if (/^\[\d+\]$/.test(p)) return <Text key={i} style={styles.marker}>{p}</Text>;
        if (p.startsWith("`") && p.endsWith("`")) return <Text key={i} style={styles.code}>{p.slice(1, -1)}</Text>;
        if (p.length > 2 && p.startsWith("*") && p.endsWith("*")) return <Text key={i} style={styles.italic}>{p.slice(1, -1)}</Text>;
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

/** An answer's Markdown, as the web shows it (components/Markdown.tsx): headings, paragraphs and lists. */
export function AnswerText({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <View style={styles.wrap}>
      {blocks.map((block, b) => {
        const lines = block.split("\n");
        const heading = /^#{1,6}\s+/.exec(lines[0]);
        if (heading && lines.length === 1) {
          return (
            <Text key={b} style={styles.heading} selectable>
              <Inline text={lines[0].slice(heading[0].length)} />
            </Text>
          );
        }
        if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
          return (
            <View key={b} style={styles.list}>
              {lines.map((l, i) => {
                const m = /^\s*([-*•]|\d+[.)])\s+/.exec(l)!;
                const bullet = /\d/.test(m[1]) ? m[1].replace(")", ".") : "•";
                return (
                  <View key={i} style={styles.item}>
                    <Text style={styles.bullet}>{bullet}</Text>
                    <Text style={[styles.text, styles.itemText]} selectable>
                      <Inline text={l.slice(m[0].length)} />
                    </Text>
                  </View>
                );
              })}
            </View>
          );
        }
        return (
          <Text key={b} style={styles.text} selectable>
            {lines.map((l, i) => (
              <Fragment key={i}>
                {i > 0 ? "\n" : null}
                <Inline text={l.replace(/^#{1,6}\s+/, "")} />
              </Fragment>
            ))}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  text: { color: colors.text, fontSize: 16, lineHeight: 25 },
  heading: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 18, lineHeight: 24 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  code: { fontFamily: fonts.mono, fontSize: 14, color: colors.text2 },
  marker: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12 },
  list: { gap: 6 },
  item: { flexDirection: "row", gap: 8 },
  bullet: { color: colors.text3, fontSize: 16, lineHeight: 25, minWidth: 14 },
  itemText: { flex: 1 },
});

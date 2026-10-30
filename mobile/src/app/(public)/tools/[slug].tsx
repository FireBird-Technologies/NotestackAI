import { getTool, type ToolDef } from "@notestack/shared/content/tools";
import { buildPodcastScript, scriptToText } from "@notestack/shared/podcastScript";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Share, StyleSheet, Text, TextInput, View } from "react-native";

import { useAuth } from "@/account/auth";
import {
  Card,
  ContentSection,
  Eyebrow,
  Faq,
  Inline,
  Lede,
  PageTitle,
  PublicPage,
  publicText,
  Related,
} from "@/shell/public-page";
import { colors, fonts, radius } from "@/ui/theme";
import { Button } from "@/ui";

/** A free tool: its pitch and sections, with the script builder for anyone signed in (as on the web). */
export default function ToolScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const tool = getTool(slug);
  const { user } = useAuth();

  if (!tool) {
    return (
      <PublicPage>
        <PageTitle>Tool not found</PageTitle>
        <Button title="See all free tools" variant="secondary" onPress={() => router.navigate("/tools")} />
      </PublicPage>
    );
  }

  return (
    <PublicPage>
      <Eyebrow>{tool.eyebrow}</Eyebrow>
      <PageTitle>{tool.heroTitle}</PageTitle>
      <Lede>{tool.heroDescription}</Lede>
      {user ? <ScriptWidget tool={tool} /> : <SignInGate tool={tool} />}
      {tool.sections.map((s) => (
        <ContentSection key={s.heading} {...s} />
      ))}
      <Faq items={tool.faq} />
      <Related paths={tool.relatedPaths} />
    </PublicPage>
  );
}

/** Every free tool needs an account, as on the web. */
function SignInGate({ tool }: { tool: ToolDef }) {
  return (
    <Card highlight>
      <Text style={publicText.cardTitle}>Sign in to use the {tool.eyebrow.toLowerCase()}</Text>
      <Text style={publicText.body}>It is free. Create an account in seconds and come straight back to this tool.</Text>
      <Button title="Sign up free" onPress={() => router.navigate("/sign-up")} />
      <Button title="Sign in" variant="secondary" onPress={() => router.navigate("/sign-in")} />
    </Card>
  );
}

/** Paste a post, get a two host script built only from its sentences (lib shared with the web). */
function ScriptWidget({ tool }: { tool: ToolDef }) {
  const [text, setText] = useState("");
  const script = useMemo(() => buildPodcastScript(text), [text]);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <Card>
      <View style={styles.inputHead}>
        <Text style={styles.label}>{tool.inputLabel}</Text>
        <Text style={publicText.mono}>{words} words</Text>
      </View>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder={tool.inputPlaceholder}
        placeholderTextColor={colors.text3}
        multiline
        textAlignVertical="top"
      />
      {tool.inputHint ? <Inline text={tool.inputHint} style={publicText.small} /> : null}
      {text.trim() && !script ? (
        <Text style={publicText.small}>Paste a little more: the script needs at least three full sentences.</Text>
      ) : null}
      {script ? (
        <View style={styles.output}>
          <Text style={publicText.mono}>
            {script.lines.length} lines · about {Math.max(1, Math.round(script.minutes))} min · built from{" "}
            {script.sourceSentences} of your sentences
          </Text>
          {script.lines.map((l, i) => (
            <View key={i} style={[styles.line, l.host === "B" && styles.lineB]}>
              <Text style={styles.host}>Host {l.host}</Text>
              <Text style={publicText.body}>{l.text}</Text>
            </View>
          ))}
          <Button
            title="Share script"
            variant="secondary"
            onPress={() => void Share.share({ message: scriptToText(script), title: `${tool.slug}-script` })}
          />
          <Text style={publicText.small}>Hear it with two natural voices, grounded in your whole archive.</Text>
          <Button title="Make an audio overview" onPress={() => router.navigate("/notebooks")} />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  inputHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  label: { color: colors.text, fontSize: 16, fontWeight: "600" },
  input: {
    minHeight: 180,
    color: colors.text,
    fontSize: 16,
    lineHeight: 23,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
  },
  output: { gap: 12, marginTop: 4 },
  line: { gap: 4, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: colors.blue },
  lineB: { borderLeftColor: colors.lineStrong },
  host: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1, textTransform: "uppercase" },
});

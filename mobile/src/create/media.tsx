import {
  AUDIO_LENGTHS,
  AUDIO_STYLES,
  DECK_FORMATS,
  DECK_LENGTHS,
  INFOGRAPHIC_STYLES,
  INFOGRAPHIC_THEMES,
  LANGUAGES,
  SLIDE_THEMES,
} from "@notestack/shared/create-options";
import { videoVoicesApi } from "@notestack/shared/endpoints";
import { useQuery } from "@tanstack/react-query";
import { Image, type ImageSource } from "expo-image";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { ChoiceCard, createStyles, Foot, Hint, Label, Pills, Select, SourceFocusFields, type SourceSelection, TextArea } from "@/create/fields";
import type { DialogProps } from "@/create/study";
import { colors, radius } from "@/ui/theme";
import { PillButton } from "@/ui/widgets";

const LANGUAGE_OPTIONS = LANGUAGES.map((l) => ({ value: l, label: l }));

/** The workspace's voices for the hosts (web: prefetchVoices); none when they cannot load, so the defaults are used. */
export const voicesQuery = { queryKey: ["video-voices"], queryFn: videoVoicesApi.list, staleTime: 60_000 } as const;

type Style = (typeof AUDIO_STYLES)[number]["id"];

/** The audio overview settings (web: AudioOverview.tsx AudioOverviewDialog). */
export function AudioDialog({ notebook, chats, currentChatId, onCreate }: DialogProps) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [style, setStyle] = useState<Style>("deep_dive");
  const [hosts, setHosts] = useState<"1" | "2">("2");
  const [minutes, setMinutes] = useState("6");
  const [language, setLanguage] = useState("English");
  const [focus, setFocus] = useState("");
  const voices = useQuery(voicesQuery);
  const saved = voices.data?.saved ?? (voices.error ? [] : null);
  // The hosts' picks: chosen ones, else the first voice and a different second (never the same one twice).
  const [picked, setPicked] = useState<[string, string]>(["", ""]);
  const two = hosts === "2";
  const has = (id: string) => Boolean(saved?.some((v) => v.voice_id === id));
  const first = has(picked[0]) ? picked[0] : (saved?.[0]?.voice_id ?? "");
  const second = has(picked[1]) && picked[1] !== first ? picked[1] : ((saved?.find((v) => v.voice_id !== first) ?? saved?.[0])?.voice_id ?? "");
  const voice: [string, string] = [first, second];
  // A debate needs two hosts: with one, the style reads as Deep Dive.
  const shownStyle: Style = !two && style === "debate" ? "deep_dive" : style;

  const pickVoice = (i: 0 | 1, id: string) => {
    const next: [string, string] = [...voice];
    next[i] = id;
    const other = i === 0 ? 1 : 0;
    if (two && next[other] === id) next[other] = saved?.find((v) => v.voice_id !== id)?.voice_id ?? id;
    setPicked(next);
  };
  const voiceOptions = (saved ?? []).map((v) => ({ value: v.voice_id, label: v.name }));

  return (
    <View style={createStyles.stack}>
      <View style={createStyles.field}>
        <Label>Style</Label>
        <View style={styles.grid}>
          {AUDIO_STYLES.map((s) => {
            const off = s.id === "debate" && !two;
            return (
              <ChoiceCard
                key={s.id}
                title={s.name}
                blurb={off ? "Needs two hosts." : s.blurb}
                on={shownStyle === s.id}
                disabled={off}
                lines={3}
                style={styles.gridCell}
                onPress={() => setStyle(s.id)}
              />
            );
          })}
        </View>
      </View>
      <View style={createStyles.field}>
        <Label>Hosts</Label>
        <Pills<"1" | "2">
          value={hosts}
          onChange={setHosts}
          options={[
            { id: "2", label: "Two hosts" },
            { id: "1", label: "One host" },
          ]}
        />
      </View>
      <View style={styles.row}>
        <View style={[createStyles.field, styles.half]}>
          <Label>Length</Label>
          <Select label="Length" value={minutes} onChange={setMinutes} options={AUDIO_LENGTHS.map((l) => ({ value: l.value, label: l.label }))} />
          <Hint>{AUDIO_LENGTHS.find((l) => l.value === minutes)?.range}</Hint>
        </View>
        <View style={[createStyles.field, styles.half]}>
          <Label>Language</Label>
          <Select label="Language" value={language} onChange={setLanguage} options={LANGUAGE_OPTIONS} />
        </View>
      </View>
      {saved && saved.length > 0
        ? ([0, 1] as const)
            .filter((i) => i === 0 || two)
            .map((i) => (
              <View key={i} style={createStyles.field}>
                <Label>{two ? `Host ${i + 1} voice` : "Host voice"}</Label>
                <Select label={two ? `Host ${i + 1} voice` : "Host voice"} value={voice[i]} onChange={(v) => pickVoice(i, v)} options={voiceOptions} />
              </View>
            ))
        : null}
      {saved === null ? <Hint>Loading your voices...</Hint> : null}
      {saved !== null && saved.length === 0 ? <Hint>Your voices could not load, so the default {two ? "voices are" : "voice is"} used.</Hint> : null}
      <SourceFocusFields
        notebookId={notebook.id}
        docs={notebook.documents}
        chats={chats}
        currentChatId={currentChatId}
        what="audio overview"
        noFocus
        onChange={setSel}
      />
      <View style={createStyles.field}>
        <Label optional>What should the AI {two ? "hosts" : "host"} focus on in this episode?</Label>
        <TextArea value={focus} onChange={setFocus} max={4000} rows={5} placeholder={"- List the core ideas worth remembering\n- Explain how the pieces connect"} />
      </View>
      <Foot note={!sel?.ready && "Select at least one post or chat to make an audio overview."}>
        <PillButton
          title="Generate audio overview"
          variant="primary"
          disabled={!sel?.ready}
          onPress={() =>
            sel &&
            onCreate({
              ...sel.request,
              format: shownStyle,
              hosts: two ? 2 : 1,
              minutes: Number(minutes),
              language,
              instructions: focus.trim(),
              ...(voice[0] ? { host_a: voice[0], ...(two ? { host_b: voice[1] || voice[0] } : {}) } : {}),
            })
          }
        />
      </Foot>
    </View>
  );
}

const SLIDE_IMAGES: Record<string, ImageSource> = {
  "dark-space": require("@/assets/images/create/slide-dark-space.png"),
  "light-space": require("@/assets/images/create/slide-light-space.png"),
};
const LOOK_IMAGES: Record<string, ImageSource> = {
  midnight: require("@/assets/images/create/ig-midnight.png"),
  paper: require("@/assets/images/create/ig-paper.png"),
};

/** A look to pick, as its picture with a name (and a line) under it, ticked when chosen. */
function ImageChoice({ image, name, blurb, on, ratio, onPress }: { image: ImageSource; name: string; blurb?: string; on: boolean; ratio: number; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ checked: on }} style={[styles.look, on && styles.lookOn]}>
      <View>
        <Image source={image} style={[styles.lookImage, { aspectRatio: ratio }]} contentFit="cover" />
        {on ? (
          <View style={styles.lookCheck}>
            <SymbolView name={{ ios: "checkmark", android: "check" }} size={11} weight="bold" tintColor={colors.white} />
          </View>
        ) : null}
      </View>
      <Text style={styles.lookName}>{name}</Text>
      {blurb ? <Text style={styles.lookBlurb}>{blurb}</Text> : null}
    </Pressable>
  );
}

/** An infographic's look, as pictures to pick from (web: Infographic ThemePicker). Also in a report's add dialog. */
export function ThemePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <View style={styles.looks}>
      {INFOGRAPHIC_THEMES.map((t) => (
        <ImageChoice key={t.id} image={LOOK_IMAGES[t.id]} name={t.name} blurb={t.blurb} on={value === t.id} ratio={1400 / 991} onPress={() => onChange(t.id)} />
      ))}
    </View>
  );
}

type DeckFormat = (typeof DECK_FORMATS)[number]["id"];
type DeckLength = (typeof DECK_LENGTHS)[number]["id"];

/** The slide deck settings (web: SlideDeck.tsx SlideDeckDialog). */
export function SlidesDialog({ notebook, chats, currentChatId, onCreate }: DialogProps) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [theme, setTheme] = useState<string>("dark-space");
  const [format, setFormat] = useState<DeckFormat>("detailed");
  const [length, setLength] = useState<DeckLength>("default");
  const [language, setLanguage] = useState("English");
  const [prompt, setPrompt] = useState("");
  return (
    <View style={createStyles.stack}>
      <View style={createStyles.field}>
        <Label>Visual style</Label>
        <View style={styles.looks}>
          {SLIDE_THEMES.map((t) => (
            <ImageChoice key={t.id} image={SLIDE_IMAGES[t.id]} name={t.name} on={theme === t.id} ratio={16 / 9} onPress={() => setTheme(t.id)} />
          ))}
        </View>
      </View>
      <View style={createStyles.field}>
        <Label>Format</Label>
        <Pills<DeckFormat> value={format} onChange={setFormat} options={DECK_FORMATS} />
        <Hint>{DECK_FORMATS.find((f) => f.id === format)?.blurb}</Hint>
      </View>
      <View style={styles.row}>
        <View style={[createStyles.field, styles.half]}>
          <Label>Length</Label>
          <Select<DeckLength> label="Length" value={length} onChange={setLength} options={DECK_LENGTHS.map((l) => ({ value: l.id, label: l.label }))} />
          <Hint>{DECK_LENGTHS.find((l) => l.id === length)?.range}</Hint>
        </View>
        <View style={[createStyles.field, styles.half]}>
          <Label>Language</Label>
          <Select label="Language" value={language} onChange={setLanguage} options={LANGUAGE_OPTIONS} />
        </View>
      </View>
      <SourceFocusFields notebookId={notebook.id} docs={notebook.documents} chats={chats} currentChatId={currentChatId} what="slide deck" noFocus onChange={setSel} />
      <View style={createStyles.field}>
        <Label optional>Describe the slide deck you want to create</Label>
        <TextArea
          value={prompt}
          onChange={setPrompt}
          max={4000}
          rows={3}
          placeholder={'Add a high-level outline, or guide the audience, style, and focus: "Create a deck for beginners with a focus on step-by-step instructions."'}
        />
      </View>
      <Foot note={!sel?.ready && "Select at least one post or chat to make a slide deck."}>
        <PillButton
          title="Generate slide deck"
          variant="primary"
          disabled={!sel?.ready}
          onPress={() => sel && onCreate({ ...sel.request, theme, deck_format: format, deck_length: length, language, instructions: prompt.trim() })}
        />
      </Foot>
    </View>
  );
}

/** The infographic settings (web: Infographic.tsx InfographicDialog). */
export function InfographicDialog({ notebook, chats, currentChatId, onCreate }: DialogProps) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [theme, setTheme] = useState<string>("midnight");
  const [style, setStyle] = useState<string>("auto");
  const [prompt, setPrompt] = useState("");
  return (
    <View style={createStyles.stack}>
      <View style={createStyles.field}>
        <Label>Layout</Label>
        <Pills value={style} onChange={setStyle} options={INFOGRAPHIC_STYLES.map((t) => ({ id: t.id as string, label: t.name }))} />
        <Hint>{INFOGRAPHIC_STYLES.find((t) => t.id === style)?.blurb}. The AI builds the page around it.</Hint>
      </View>
      <View style={createStyles.field}>
        <Label>Look</Label>
        <ThemePicker value={theme} onChange={setTheme} />
      </View>
      <SourceFocusFields notebookId={notebook.id} docs={notebook.documents} chats={chats} currentChatId={currentChatId} what="infographic" noFocus onChange={setSel} />
      <View style={createStyles.field}>
        <Label optional>What should it show?</Label>
        <TextArea value={prompt} onChange={setPrompt} max={600} rows={6} placeholder="e.g. The main stages of the idea, in order, for someone new to it" />
        <Hint>{prompt.length}/600 · It follows this, as far as the posts and chats cover it.</Hint>
      </View>
      <Foot note={!sel?.ready && "Select at least one post or chat to make an infographic."}>
        <PillButton
          title="Generate Infographic"
          variant="primary"
          disabled={!sel?.ready}
          onPress={() => sel && onCreate({ ...sel.request, theme, ig_style: style, instructions: prompt.trim() })}
        />
      </Foot>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 12 },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 8 },
  gridCell: { width: "48.8%" },
  half: { flex: 1 },
  looks: { flexDirection: "row", gap: 10 },
  look: { flex: 1, gap: 6, padding: 6, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.line },
  lookOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  lookImage: { width: "100%", borderRadius: radius.sm },
  lookCheck: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.blue,
  },
  lookName: { color: colors.text, fontSize: 15, fontWeight: "600", paddingHorizontal: 4 },
  lookBlurb: { color: colors.text3, fontSize: 12.5, lineHeight: 17, paddingHorizontal: 4, paddingBottom: 2 },
});

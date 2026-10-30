import { notebooksApi } from "@notestack/shared/endpoints";
import type { AnswerFeedback as Feedback, ChatArtifact } from "@notestack/shared/types";
import * as Clipboard from "expo-clipboard";
import { Image, type ImageSource } from "expo-image";
import { SymbolView } from "expo-symbols";
import { type ReactNode, useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { colors, fonts, radius } from "@/ui/theme";
import { PillButton } from "@/ui/widgets";

const REASONS: { id: string; label: string }[] = [
  { id: "forgot_chat", label: "Forgot something we said" },
  { id: "mixed_chat", label: "Mixed up an earlier chat" },
  { id: "wrong", label: "Wrong or made up" },
  { id: "missed", label: "Missed something in my posts" },
  { id: "bad_sources", label: "Bad sources" },
  { id: "other", label: "Something else" },
];

/** The answer as plain text for pasting: the [1] citation markers are left out. */
const forCopy = (text: string) => text.replace(/\s*\[\d+\](?:\[\d+\])*/g, "").trim();

/**
 * Copy and thumbs down under an answer (web: components/AnswerFeedback.tsx). A thumbs down opens a few reasons and an
 * optional note. Saved as soon as it is chosen; `extra` ends the row (the last answer's next step).
 */
export function AnswerFeedback({ messageId, initial, text, extra }: {
  messageId: string;
  initial?: Feedback | null;
  text: string;
  extra?: ReactNode;
}) {
  const [fb, setFb] = useState<Feedback | null>(initial ?? null);
  const [open, setOpen] = useState(false);
  const [reasons, setReasons] = useState<string[]>(initial?.reasons ?? []);
  const [comment, setComment] = useState(initial?.comment ?? "");
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    await Clipboard.setStringAsync(forCopy(text));
    setCopied(true);
  };

  const save = async (rating: "down" | null, r: string[] = [], c = "") => {
    const before = fb;
    setError(false);
    setFb(rating ? { rating, reasons: r, comment: c || null } : null); // shows at once; undone if the save fails
    try {
      const res = await notebooksApi.rate(messageId, { rating, reasons: r, comment: c || undefined });
      setFb(res.feedback);
    } catch {
      setFb(before);
      setError(true);
    }
  };

  const down = fb?.rating === "down";
  const toggleDown = () => {
    if (down) {
      setOpen(false);
      void save(null);
    } else {
      setOpen(true);
      void save("down", reasons);
    }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Pressable onPress={() => void copy()} hitSlop={6} accessibilityRole="button" accessibilityLabel={copied ? "Copied" : "Copy answer"} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
          <SymbolView
            name={copied ? { ios: "checkmark", android: "check" } : { ios: "doc.on.doc", android: "content_copy" }}
            size={19}
            tintColor={copied ? colors.blue : colors.text2}
          />
        </Pressable>
        <Pressable
          onPress={toggleDown}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Bad answer"
          accessibilityState={{ selected: down }}
          style={({ pressed }) => [styles.btn, down && styles.btnOn, pressed && styles.pressed]}>
          <SymbolView
            name={down ? { ios: "hand.thumbsdown.fill", android: "thumb_down" } : { ios: "hand.thumbsdown", android: "thumb_down" }}
            size={19}
            tintColor={down ? colors.blue : colors.text2}
          />
        </Pressable>
        {extra}
      </View>
      {error ? <Text style={styles.error}>Could not save that. Try again.</Text> : null}
      {open && down ? (
        <View style={styles.why}>
          <Text style={styles.whyLabel}>What went wrong? (optional)</Text>
          <View style={styles.chips}>
            {REASONS.map((r) => {
              const on = reasons.includes(r.id);
              return (
                <Pressable
                  key={r.id}
                  onPress={() => setReasons((list) => (on ? list.filter((x) => x !== r.id) : [...list, r.id]))}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}>
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{r.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput
            style={styles.note}
            value={comment}
            onChangeText={setComment}
            maxLength={1000}
            multiline
            placeholder="Tell us more, like what it should have said"
            placeholderTextColor={colors.text3}
            accessibilityLabel="What went wrong"
          />
          <View style={styles.end}>
            <PillButton small title="Skip" onPress={() => setOpen(false)} />
            <PillButton
              small
              variant="primary"
              title="Send"
              onPress={async () => {
                await save("down", reasons, comment.trim());
                setOpen(false);
              }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

export type NextStep = { kind: ChatArtifact; label: string; icon: ImageSource };

/** The steps suggested under the last answer (web: NotebookView nextSteps): with the answer's topic each one names it. */
export function nextSteps(topic?: string): NextStep[] {
  const t = topic?.trim();
  const say = (plain: string, named: (t: string) => string) => (t ? named(t) : plain);
  return [
    { kind: "audio_overview", label: say("Make an audio overview", (x) => `Hear an audio overview of ${x}`), icon: require("@/assets/images/create/headphones.png") },
    { kind: "slide_deck", label: say("Create a slide deck", (x) => `Turn ${x} into a slide deck`), icon: require("@/assets/images/create/slides.png") },
    { kind: "video", label: say("Make a video", (x) => `Make a video about ${x}`), icon: require("@/assets/images/create/video.png") },
    { kind: "report", label: say("Generate a report", (x) => `Write a report on ${x}`), icon: require("@/assets/images/create/report.png") },
    { kind: "quiz", label: say("Take a quiz", (x) => `Quiz yourself on ${x}`), icon: require("@/assets/images/create/quiz.png") },
    { kind: "infographic", label: say("Generate an infographic", (x) => `Make an infographic on ${x}`), icon: require("@/assets/images/create/infographic.png") },
    { kind: "mind_map", label: say("Explore a Mind Constellation", (x) => `Map ${x} in a Mind Constellation`), icon: require("@/assets/images/create/telescope.png") },
    { kind: "flashcards", label: say("Study with flashcards", (x) => `Study ${x} with flashcards`), icon: require("@/assets/images/create/flashcards.png") },
  ];
}

// Long enough to read a label that names the answer's topic.
const EVERY_MS = 6000;

/** 0..n-1 in a random order (Fisher-Yates); `notFirst` keeps a new round from opening with the step just shown. */
function shuffled(n: number, notFirst?: number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (n > 1 && out[0] === notFirst) [out[0], out[1]] = [out[1], out[0]];
  return out;
}

/** One suggested next step beside the last answer, switching every few seconds; every step shows once before any repeats (web: NextStepHint). */
export function NextStepPill({ steps, onPick }: { steps: NextStep[]; onPick: (kind: ChatArtifact) => void }) {
  const [round, setRound] = useState(() => ({ order: shuffled(steps.length), pos: 0 }));
  useEffect(() => {
    if (steps.length < 2) return;
    const t = setInterval(() => {
      setRound(({ order, pos }) => (pos + 1 < order.length ? { order, pos: pos + 1 } : { order: shuffled(steps.length, order[pos]), pos: 0 }));
    }, EVERY_MS);
    return () => clearInterval(t);
  }, [steps.length]);

  const step = steps[(round.order[round.pos] ?? 0) % steps.length];
  if (!step) return null;
  return (
    <Pressable onPress={() => onPick(step.kind)} accessibilityRole="button" accessibilityLabel={step.label} style={({ pressed }) => [styles.next, pressed && styles.pressed]}>
      <Image source={step.icon} style={styles.nextIcon} tintColor={colors.text2} />
      <Text style={styles.nextLabel} numberOfLines={2}>
        {step.label}
      </Text>
      <Text style={styles.nextArrow}>→</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  btn: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  btnOn: { backgroundColor: colors.blue20 },
  pressed: { opacity: 0.7 },
  error: { color: colors.danger, fontSize: 13 },
  why: { gap: 10, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  whyLabel: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  chipOn: { borderColor: colors.blue, backgroundColor: colors.blue20 },
  chipText: { color: colors.text2, fontSize: 13 },
  chipTextOn: { color: colors.text },
  note: {
    minHeight: 64,
    maxHeight: 140,
    padding: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    color: colors.text,
    fontSize: 14.5,
    textAlignVertical: "top",
  },
  end: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  next: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginLeft: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  nextIcon: { width: 15, height: 15 },
  nextLabel: { flexShrink: 1, color: colors.text2, fontSize: 13.5, lineHeight: 18 },
  nextArrow: { color: colors.text3, fontSize: 13.5 },
});

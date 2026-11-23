import { CARD_LEVELS, QUIZ_LEVELS, QUIZ_TYPES } from "@/create/options";
import type { GenerateBody } from "@notestack/shared/endpoints";
import type { ChatPreset, ChatSummary, Notebook, QuizQuestionType } from "@notestack/shared/types";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { Check, createStyles, Foot, Label, Pills, Select, SourceFocusFields, type SourceSelection, TextArea } from "@/create/fields";
import { colors, radius } from "@/ui/theme";
import { PillButton } from "@/ui/widgets";
import i18n from "@/i18n";

export type CreateBody = Omit<GenerateBody, "type">;
export type DialogProps = {
  notebook: Notebook;
  chats: ChatSummary[];
  currentChatId: string | null;
  /** What the chat asked for ("a hard quiz on pricing"): the settings start there (web: each dialog's `initial`). */
  initial?: ChatPreset;
  onClose: () => void;
  onCreate: (body: CreateBody) => void;
};

/** The quiz settings (web: Quiz.tsx QuizDialog): difficulty and question types, then what it is made from and its focus. */
export function QuizDialog({ notebook, chats, currentChatId, initial, onCreate }: DialogProps) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [level, setLevel] = useState<(typeof QUIZ_LEVELS)[number]["id"]>(() => QUIZ_LEVELS.find((l) => l.id === initial?.level)?.id ?? "medium");
  const [types, setTypes] = useState<Set<QuizQuestionType>>(() => {
    const asked = QUIZ_TYPES.map((t) => t.id).filter((t) => initial?.types?.includes(t));
    return new Set(asked.length ? asked : ["multiple_choice"]);
  });
  const toggleType = (t: QuizQuestionType) =>
    setTypes((cur) => {
      const next = new Set(cur);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next.size ? next : cur; // at least one stays on
    });
  const first = QUIZ_TYPES.find((t) => types.has(t.id))!;

  return (
    <View style={createStyles.stack}>
      <View style={styles.row}>
        <View style={[createStyles.field, styles.half]}>
          <Label>{i18n.t("dialogs.difficulty")}</Label>
          <Select label={i18n.t("dialogs.levelOfDifficulty")} value={level} onChange={setLevel} options={QUIZ_LEVELS.map((l) => ({ value: l.id, label: l.label }))} />
        </View>
        <View style={[createStyles.field, styles.half]}>
          <Label>{i18n.t("dialogs.questionTypes")}</Label>
          <Select<QuizQuestionType>
            label={i18n.t("dialogs.questionTypes")}
            multiple
            value={first.id}
            isOn={(t) => types.has(t)}
            onChange={toggleType}
            display={types.size === 1 ? first.label : i18n.t("dialogs.typesCount", { count: types.size })}
            options={QUIZ_TYPES.map((t) => ({ value: t.id, label: t.label }))}
          />
        </View>
      </View>
      <SourceFocusFields
        notebookId={notebook.id}
        docs={notebook.documents}
        chats={chats}
        currentChatId={currentChatId}
        initialCustom={initial?.focus}
        preselectChat
        largeSelection
        what="quiz"
        onChange={setSel}
      />
      <Foot note={!sel?.ready && i18n.t("dialogs.quizNote")}>
        <PillButton
          title={i18n.t("dialogs.generateQuiz")}
          variant="primary"
          disabled={!sel?.ready || sel.loading}
          onPress={() => sel && onCreate({ ...sel.request, difficulty: level, question_types: QUIZ_TYPES.map((t) => t.id).filter((t) => types.has(t)) })}
        />
      </Foot>
    </View>
  );
}

/** The flashcard settings (web: Flashcards.tsx FlashcardsDialog): how hard, then the source and focus. */
export function FlashcardsDialog({ notebook, chats, currentChatId, initial, onCreate }: DialogProps) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [level, setLevel] = useState<(typeof CARD_LEVELS)[number]["id"]>(() => CARD_LEVELS.find((l) => l.id === initial?.level)?.id ?? "medium");
  return (
    <View style={createStyles.stack}>
      <View style={createStyles.field}>
        <Label>{i18n.t("dialogs.levelOfDifficulty")}</Label>
        <Pills value={level} options={CARD_LEVELS} onChange={setLevel} />
      </View>
      <SourceFocusFields
        notebookId={notebook.id}
        docs={notebook.documents}
        chats={chats}
        currentChatId={currentChatId}
        initialCustom={initial?.focus}
        preselectChat
        largeSelection
        what="flashcard set"
        onChange={setSel}
      />
      <Foot note={!sel?.ready && i18n.t("dialogs.cardsNote")}>
        <PillButton
          title={i18n.t("dialogs.generateCards")}
          variant="primary"
          disabled={!sel?.ready || sel.loading}
          onPress={() => sel && onCreate({ ...sel.request, difficulty: level })}
        />
      </Foot>
    </View>
  );
}

/** The Mind Constellation settings (web: MindMap.tsx MindMapDialog): the posts to chart and what it centres on. */
export function MindMapDialog({ notebook, initial, onClose, onCreate }: DialogProps) {
  const docs = notebook.documents;
  const [picked, setPicked] = useState<Set<string>>(() => new Set(docs.map((d) => d.id)));
  const [focus, setFocus] = useState(initial?.focus ?? "");
  const [open, setOpen] = useState(false);
  const all = picked.size === docs.length;
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <View style={createStyles.stack}>
      <View style={createStyles.field}>
        <Text style={styles.h}>{i18n.t("dialogs.sources")}</Text>
        <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.toggle}>
          <Text style={styles.toggleText}>
            {picked.size} of {docs.length} posts
          </Text>
          <SymbolView name={open ? { ios: "chevron.up", android: "expand_less" } : { ios: "chevron.down", android: "expand_more" }} size={13} tintColor={colors.text2} />
        </Pressable>
        {open ? (
          <View style={styles.pick}>
            <Pressable
              onPress={() => setPicked(all ? new Set() : new Set(docs.map((d) => d.id)))}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: all }}
              style={[styles.item, styles.itemAll]}>
              <Check on={all} />
              <Text style={styles.itemText}>{i18n.t("dialogs.selectAll")}</Text>
            </Pressable>
            {docs.map((d) => (
              <Pressable key={d.id} onPress={() => toggle(d.id)} accessibilityRole="checkbox" accessibilityState={{ checked: picked.has(d.id) }} style={styles.item}>
                <Check on={picked.has(d.id)} />
                <Text style={styles.itemText} numberOfLines={2}>
                  {d.title}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
      <View style={createStyles.field}>
        <Text style={styles.h}>{i18n.t("dialogs.topicQuestion")}</Text>
        <TextArea
          value={focus}
          onChange={setFocus}
          max={500}
          rows={5}
          placeholder={i18n.t("dialogs.topicPlaceholder")}
        />
      </View>
      <Foot>
        <PillButton title={i18n.t("common.cancel")} onPress={onClose} />
        <PillButton
          title={i18n.t("dialogs.generate")}
          variant="primary"
          disabled={picked.size === 0}
          onPress={() =>
            onCreate({ document_ids: picked.size === docs.length ? undefined : [...picked], focus: focus.trim() || undefined })
          }
        />
      </Foot>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 12 },
  half: { flex: 1 },
  h: { color: colors.text, fontSize: 17, fontWeight: "700" },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  toggleText: { color: colors.text, fontSize: 16 },
  pick: { borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  item: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 11, borderTopWidth: 1, borderTopColor: colors.line },
  itemAll: { borderTopWidth: 0, backgroundColor: colors.surface },
  itemText: { flex: 1, color: colors.text, fontSize: 15.5 },
});

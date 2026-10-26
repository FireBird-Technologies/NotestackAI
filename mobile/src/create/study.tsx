import { CARD_LEVELS, QUIZ_LEVELS, QUIZ_TYPES } from "@notestack/shared/create-options";
import type { GenerateBody } from "@notestack/shared/endpoints";
import type { ChatSummary, Notebook, QuizQuestionType } from "@notestack/shared/types";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Check, createStyles, Foot, Label, Pills, Select, SourceFocusFields, type SourceSelection, TextArea } from "@/create/fields";
import { colors, radius } from "@/theme";
import { PillButton } from "@/widgets";

export type CreateBody = Omit<GenerateBody, "type">;
export type DialogProps = {
  notebook: Notebook;
  chats: ChatSummary[];
  currentChatId: string | null;
  onClose: () => void;
  onCreate: (body: CreateBody) => void;
};

/** The quiz settings (web: Quiz.tsx QuizDialog): difficulty and question types, then what it is made from and its focus. */
export function QuizDialog({ notebook, chats, currentChatId, onCreate }: DialogProps) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [level, setLevel] = useState<(typeof QUIZ_LEVELS)[number]["id"]>("medium");
  const [types, setTypes] = useState<Set<QuizQuestionType>>(() => new Set(["multiple_choice"]));
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
          <Label>Difficulty</Label>
          <Select label="Level of difficulty" value={level} onChange={setLevel} options={QUIZ_LEVELS.map((l) => ({ value: l.id, label: l.label }))} />
        </View>
        <View style={[createStyles.field, styles.half]}>
          <Label>Question types</Label>
          <Select<QuizQuestionType>
            label="Question types"
            multiple
            value={first.id}
            isOn={(t) => types.has(t)}
            onChange={toggleType}
            display={types.size === 1 ? first.label : `${types.size} types`}
            options={QUIZ_TYPES.map((t) => ({ value: t.id, label: t.label }))}
          />
        </View>
      </View>
      <SourceFocusFields
        notebookId={notebook.id}
        docs={notebook.documents}
        chats={chats}
        currentChatId={currentChatId}
        preselectChat
        largeSelection
        what="quiz"
        onChange={setSel}
      />
      <Foot note={!sel?.ready && "Select at least one post or chat to generate a quiz."}>
        <PillButton
          title="Generate Quiz"
          variant="primary"
          disabled={!sel?.ready || sel.loading}
          onPress={() => sel && onCreate({ ...sel.request, difficulty: level, question_types: QUIZ_TYPES.map((t) => t.id).filter((t) => types.has(t)) })}
        />
      </Foot>
    </View>
  );
}

/** The flashcard settings (web: Flashcards.tsx FlashcardsDialog): how hard, then the source and focus. */
export function FlashcardsDialog({ notebook, chats, currentChatId, onCreate }: DialogProps) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [level, setLevel] = useState<(typeof CARD_LEVELS)[number]["id"]>("medium");
  return (
    <View style={createStyles.stack}>
      <View style={createStyles.field}>
        <Label>Level of difficulty</Label>
        <Pills value={level} options={CARD_LEVELS} onChange={setLevel} />
      </View>
      <SourceFocusFields
        notebookId={notebook.id}
        docs={notebook.documents}
        chats={chats}
        currentChatId={currentChatId}
        preselectChat
        largeSelection
        what="flashcard set"
        onChange={setSel}
      />
      <Foot note={!sel?.ready && "Select at least one post or chat to generate flashcards."}>
        <PillButton
          title="Generate Flashcards"
          variant="primary"
          disabled={!sel?.ready || sel.loading}
          onPress={() => sel && onCreate({ ...sel.request, difficulty: level })}
        />
      </Foot>
    </View>
  );
}

/** The Mind Constellation settings (web: MindMap.tsx MindMapDialog): the posts to chart and what it centres on. */
export function MindMapDialog({ notebook, onClose, onCreate }: DialogProps) {
  const docs = notebook.documents;
  const [picked, setPicked] = useState<Set<string>>(() => new Set(docs.map((d) => d.id)));
  const [focus, setFocus] = useState("");
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
        <Text style={styles.h}>Sources</Text>
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
              <Text style={styles.itemText}>Select all</Text>
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
        <Text style={styles.h}>What should the topic be?</Text>
        <TextArea
          value={focus}
          onChange={setFocus}
          max={500}
          rows={5}
          placeholder={'Things to try\n- Centre it on one idea (e.g. "how I price my work")\n- Focus only on the arguments I changed my mind about\n- Help me study the key concepts across these posts'}
        />
      </View>
      <Foot>
        <PillButton title="Cancel" onPress={onClose} />
        <PillButton
          title="Generate"
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

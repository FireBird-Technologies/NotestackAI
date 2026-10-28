import { ApiError } from "@notestack/shared/client";
import { notebooksApi } from "@notestack/shared/endpoints";
import { STARTERS } from "@notestack/shared/notebook";
import { streamSSE } from "@notestack/shared/stream";
import type { Citation, Notebook } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { planQuery } from "@/shell/nav-drawer";
import { AnswerText } from "@/notebook/answer-text";
import { RingSpinner } from "@/ui/spinner";
import { colors, fonts, gutter, radius } from "@/ui/theme";
import { Loading } from "@/ui";
import { useUpgrade } from "@/account/upgrade";

type Turn = { key: string; role: "user" | "assistant"; text: string; citations?: Citation[]; status?: string };
type ChatQuota = { used: number; limit: number; left: number };

/** A streaming draft as shown: [n] markers (and a half-written "[12" at the end) are hidden until they are verified. */
function streamingText(draft: string): string {
  return draft.replace(/ ?\[\d+\]/g, "").replace(/ ?\[\d*$/, "");
}

/**
 * The text as it is revealed on screen: an answer that grows (streaming) runs out a few characters a frame, faster the
 * further behind it is, so bursts from the network read as an even flow. Anything else (a saved answer, the final one
 * with its markers) shows at once.
 */
function useSmoothText(text: string): string {
  const [shown, setShown] = useState(text);
  const shownRef = useRef(text);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const cur = shownRef.current;
      if (cur === text) return;
      const next = text.startsWith(cur)
        ? text.slice(0, cur.length + Math.max(2, Math.ceil((text.length - cur.length) / 8)))
        : text;
      shownRef.current = next;
      setShown(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text]);
  return shown;
}

/** The notebook bar's height under the status bar, for keeping the ask bar above the keyboard. */
const BAR_HEIGHT = 60;

/**
 * The Chat tab (web: NotebookView's chat pane): the open chat's turns, or the telescope and starter questions, the Free
 * plan's chat limit, and the ask bar. `chatId` null is a new chat; the first answer names it through `onStarted`.
 */
export function ChatTab({ notebook, chatId, onStarted }: { notebook: Notebook; chatId: string | null; onStarted: (id: string) => void }) {
  const queryClient = useQueryClient();
  const upgrade = useUpgrade();
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<Turn>>(null);
  const asked = useRef(0); // numbers this screen's questions, for their turns' keys
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  // Free's chat questions: the latest answer's count, else the billing meter. null = unlimited.
  const [answerQuota, setAnswerQuota] = useState<ChatQuota | null | undefined>(undefined);
  const plan = useQuery(planQuery);

  const messages = useQuery({
    queryKey: ["chat", chatId, "messages"],
    queryFn: () => notebooksApi.messages(chatId!),
    enabled: Boolean(chatId),
  });

  const meter = plan.data?.more_meters.find((m) => m.key === "chat_messages");
  const quota =
    answerQuota !== undefined
      ? answerQuota
      : meter && meter.limit >= 0
        ? { used: meter.used, limit: meter.limit, left: Math.max(meter.limit - meter.used, 0) }
        : null;
  const outOfChat = quota !== null && quota.left <= 0;
  const posts = notebook.documents.length;

  const ask = async (input: string) => {
    const text = input.trim();
    if (!text || busy || outOfChat) return;
    setQuestion("");
    setBusy(true);
    const n = ++asked.current;
    const answerKey = `answer-${n}`;
    setPending((t) => [...t, { key: `ask-${n}`, role: "user", text }, { key: answerKey, role: "assistant", text: "", status: "Scanning" }]);
    const patch = (p: Partial<Turn>) => setPending((t) => t.map((x) => (x.key === answerKey ? { ...x, ...p } : x)));
    let draft = "";
    let answered = false;
    let newChatId: string | null = null;
    try {
      await streamSSE(
        `/api/notebooks/${notebook.id}/chat`,
        (event, data) => {
          const d = data as Record<string, unknown>;
          if (event === "status") {
            if (d.chat_id) newChatId = d.chat_id as string;
            patch({ status: d.message as string });
          } else if (event === "step") {
            patch({ status: d.message as string });
          } else if (event === "delta") {
            draft += d.text as string;
            patch({ text: streamingText(draft), status: undefined });
          } else if (event === "reset") {
            draft = "";
            patch({ text: "" });
          } else if (event === "error") {
            answered = true;
            patch({ text: d.message as string, status: undefined });
          } else if (event === "answer") {
            answered = true;
            patch({ text: d.text as string, citations: d.citations as Citation[], status: undefined });
            const left = d.quota as ChatQuota | null | undefined;
            if (left !== undefined) setAnswerQuota(left);
          }
        },
        { method: "POST", body: JSON.stringify({ question: text, chat_id: chatId }) },
      );
      if (!answered) patch({ text: "Lost signal. Try again.", status: undefined });
    } catch (e) {
      // Out of chat messages: take the question back and say so. Plans change on the web, so there is no purchase button.
      if (e instanceof ApiError && e.status === 402) {
        setPending((t) => t.filter((x) => x.key !== answerKey && !(x.role === "user" && x.text === text)));
        setQuestion(text);
        if (quota) setAnswerQuota({ used: quota.limit, limit: quota.limit, left: 0 });
      } else {
        patch({ text: "Lost signal. Try again.", status: undefined });
        setAnswerQuota(undefined);
      }
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: planQuery.queryKey });
      const saved = newChatId ?? chatId;
      if (saved) {
        // Load the saved messages, then swap the streamed turns for them.
        await queryClient.fetchQuery({ queryKey: ["chat", saved, "messages"], queryFn: () => notebooksApi.messages(saved) });
        await queryClient.invalidateQueries({ queryKey: ["notebook", notebook.id, "chats"] });
        if (newChatId && newChatId !== chatId) onStarted(newChatId);
        setPending((t) => (t.some((x) => x.key === answerKey && x.citations) ? [] : t));
      }
    }
  };

  if (chatId && messages.isPending && !pending.length) return <Loading />;

  const turns: Turn[] = [
    ...(messages.data ?? []).map((m) => ({ key: m.id, role: m.role, text: m.text, citations: m.citations })),
    ...pending,
  ];
  const off = busy || !posts || outOfChat;

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={insets.top + BAR_HEIGHT}>
      <View style={styles.card}>
        <FlatList
          ref={list}
          data={turns}
          keyExtractor={(t) => t.key}
          contentContainerStyle={[styles.turns, turns.length === 0 && styles.turnsEmpty]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          // While an answer streams in, follow it without animating, so the scroll never lags behind the text
          onContentSizeChange={() => turns.length && list.current?.scrollToEnd({ animated: !busy })}
          renderItem={({ item }) => <TurnView turn={item} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Image source={require("@/assets/images/create/telescope.png")} style={styles.telescope} tintColor={colors.blue} />
              <Text style={styles.emptyText}>
                Ask anything about {posts} {posts === 1 ? "post" : "posts"}. Answers cite the passage they came from.
              </Text>
              {posts > 0
                ? STARTERS.map((s) => (
                    <Pressable
                      key={s}
                      onPress={() => void ask(s)}
                      disabled={off}
                      accessibilityRole="button"
                      style={({ pressed }) => [styles.starter, pressed && styles.pressed]}>
                      <Text style={styles.starterText}>{s}</Text>
                    </Pressable>
                  ))
                : null}
            </View>
          }
        />
        {quota && quota.limit > 0 ? (
          <View style={styles.limit}>
            <View
              style={styles.track}
              accessibilityRole="progressbar"
              accessibilityLabel="Free chat messages used"
              accessibilityValue={{ min: 0, max: quota.limit, now: Math.min(quota.used, quota.limit) }}>
              <View
                style={[
                  styles.bar,
                  { width: `${Math.min(100, (quota.used / quota.limit) * 100)}%` },
                  outOfChat ? styles.barOut : quota.left <= 3 ? styles.barLow : null,
                ]}
              />
            </View>
            <Text style={styles.limitText}>
              Free plan chat limit{" "}
              <Text style={styles.limitCount}>
                {Math.min(quota.used, quota.limit)}/{quota.limit}
              </Text>{" "}
              ·{" "}
              <Text style={styles.upgrade} onPress={() => upgrade({ highlight: "writer" })} accessibilityRole="link">
                Upgrade
              </Text>
            </Text>
          </View>
        ) : null}
        <View style={[styles.ask, { marginBottom: Math.max(insets.bottom, 12) }]}>
          <TextInput
            style={styles.input}
            value={question}
            onChangeText={setQuestion}
            placeholder={
              outOfChat ? "You have used all your free chat messages" : posts ? "What have I written about pricing?" : "Add posts to start asking"
            }
            placeholderTextColor={colors.text3}
            multiline
            editable={!off}
            accessibilityLabel="Ask your notebook"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={busy ? "Researching" : "Send message"}
            onPress={() => void ask(question)}
            disabled={off || !question.trim()}
            style={({ pressed }) => [styles.send, (off || !question.trim()) && !busy && styles.sendOff, pressed && styles.pressed]}>
            {busy ? (
              <RingSpinner size={20} color={colors.white} />
            ) : (
              <SymbolView name={{ ios: "arrow.up", android: "arrow_upward" }} size={20} weight="semibold" tintColor={colors.white} />
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

/** One turn: the question on the right in blue, the answer full width with its sources under it. */
function TurnView({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(false);
  const text = useSmoothText(turn.text);
  if (turn.role === "user") {
    return (
      <View style={styles.mine}>
        <Text style={styles.mineText} selectable>
          {turn.text}
        </Text>
      </View>
    );
  }
  const sources = turn.citations ?? [];
  return (
    <View style={styles.answer}>
      {turn.status ? (
        <View style={styles.statusRow}>
          <RingSpinner size={16} />
          <Text style={styles.status}>{turn.status}...</Text>
        </View>
      ) : null}
      {text ? <AnswerText text={text} /> : null}
      {sources.length > 0 ? (
        <View style={styles.sources}>
          <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.sourcesHead}>
            <SymbolView
              name={open ? { ios: "chevron.down", android: "expand_more" } : { ios: "chevron.right", android: "chevron_right" }}
              size={12}
              tintColor={colors.text3}
            />
            <Text style={styles.sourcesLabel}>
              {sources.length} {sources.length === 1 ? "source" : "sources"}
            </Text>
          </Pressable>
          {open
            ? sources.map((c) => (
                <Pressable
                  key={`${c.marker}-${c.path}-${c.line_start}`}
                  disabled={!c.document_id}
                  onPress={() => c.document_id && router.push({ pathname: "/sources/post/[id]", params: { id: c.document_id } })}
                  style={({ pressed }) => [styles.source, pressed && styles.pressed]}>
                  <Text style={styles.sourceMarker}>[{c.marker}]</Text>
                  <View style={styles.sourceText}>
                    <Text style={styles.sourceTitle} numberOfLines={2}>
                      {c.title}
                    </Text>
                    {c.kind === "chat" ? (
                      <Text style={styles.sourceMeta}>Earlier in this notebook&apos;s chats</Text>
                    ) : (
                      <Text style={styles.sourceMeta}>
                        lines {c.line_start}–{c.line_end}
                      </Text>
                    )}
                  </View>
                </Pressable>
              ))
            : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  card: {
    flex: 1,
    marginHorizontal: 10,
    marginTop: 10,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(10, 12, 18, 0.72)",
    overflow: "hidden",
  },
  turns: { padding: gutter, gap: 18 },
  turnsEmpty: { flexGrow: 1, justifyContent: "center" },
  empty: { alignItems: "center", gap: 14, paddingHorizontal: 8 },
  telescope: { width: 34, height: 34 },
  emptyText: { color: colors.text2, fontSize: 17, lineHeight: 25, textAlign: "center" },
  starter: {
    alignSelf: "stretch",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  starterText: { color: colors.text, fontSize: 16, lineHeight: 23 },
  mine: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderBottomRightRadius: 6,
    backgroundColor: colors.blue,
  },
  mineText: { color: colors.white, fontSize: 16, lineHeight: 23 },
  answer: { gap: 10 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  status: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13 },
  sources: { gap: 6 },
  sourcesHead: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  sourcesLabel: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5 },
  source: {
    flexDirection: "row",
    gap: 10,
    padding: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  sourceMarker: { color: colors.blue, fontFamily: fonts.mono, fontSize: 12.5 },
  sourceText: { flex: 1, gap: 2 },
  sourceTitle: { color: colors.text, fontSize: 14.5, lineHeight: 20 },
  sourceMeta: { color: colors.text3, fontFamily: fonts.mono, fontSize: 11.5 },
  limit: { alignItems: "flex-end", gap: 8, paddingHorizontal: gutter + 8, paddingTop: 14, paddingBottom: 6 },
  track: { alignSelf: "stretch", marginLeft: "30%", height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" },
  bar: { height: 4, borderRadius: 2, backgroundColor: colors.blue },
  barLow: { backgroundColor: "#f5b041" },
  barOut: { backgroundColor: colors.danger },
  limitText: { color: colors.text3, fontSize: 13.5 },
  limitCount: { color: colors.text, fontWeight: "600" },
  upgrade: { color: colors.text, textDecorationLine: "underline", textDecorationColor: colors.blue },
  ask: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    marginHorizontal: 14,
    marginTop: 18,
    padding: 6,
    paddingLeft: 18,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  input: { flex: 1, maxHeight: 120, minHeight: 44, color: colors.text, fontSize: 16, paddingTop: 12, paddingBottom: 12 },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.blue,
    boxShadow: "0 0 18px rgba(33, 124, 255, 0.45)",
  },
  sendOff: { opacity: 0.5 },
  pressed: { opacity: 0.75 },
});

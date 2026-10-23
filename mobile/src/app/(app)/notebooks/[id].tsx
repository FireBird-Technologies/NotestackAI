import { ApiError } from "@notestack/shared/client";
import { notebooksApi } from "@notestack/shared/endpoints";
import { streamSSE } from "@notestack/shared/stream";
import type { Citation } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, gutter, radius } from "@/theme";
import { Body, Button, Centered, Loading } from "@/ui";

type Turn = { key: string; role: "user" | "assistant"; text: string; citations?: Citation[]; status?: string };

/** A streaming draft as shown: [n] markers (and a half-written "[12" at the end) are hidden until they are verified. */
function streamingText(draft: string): string {
  return draft.replace(/ ?\[\d+\]/g, "").replace(/ ?\[\d*$/, "");
}

/** Navigation bar height below the status bar, for keeping the composer above the keyboard. */
const HEADER_HEIGHT = Platform.select({ ios: 44, default: 56 });

/** A notebook: its latest chat, and an ask box whose answers stream in. */
export default function NotebookScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<Turn>>(null);

  const notebook = useQuery({ queryKey: ["notebook", id], queryFn: () => notebooksApi.get(id) });
  const chats = useQuery({ queryKey: ["notebook", id, "chats"], queryFn: () => notebooksApi.chats(id) });
  // The chat being continued: the newest one, or the one a first question here just started.
  const [startedChatId, setStartedChatId] = useState<string | null>(null);
  const chatId = startedChatId ?? chats.data?.[0]?.id ?? null;
  const messages = useQuery({
    queryKey: ["chat", chatId, "messages"],
    queryFn: () => notebooksApi.messages(chatId!),
    enabled: Boolean(chatId),
  });

  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  const header = <Stack.Screen options={{ title: notebook.data?.title ?? title ?? "" }} />;
  const failed = notebook.error ?? chats.error ?? messages.error;

  if (notebook.isPending || chats.isPending || (chatId && messages.isPending && !pending.length)) {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }
  if (failed && !pending.length) {
    return (
      <Centered>
        {header}
        <Body muted>{failed.message}</Body>
        <Button
          title="Try again"
          onPress={() => {
            void notebook.refetch();
            void chats.refetch();
            if (chatId) void messages.refetch();
          }}
        />
      </Centered>
    );
  }

  const ask = async () => {
    const text = question.trim();
    if (!text || busy) return;
    setQuestion("");
    setBusy(true);
    const answerKey = `answer-${Date.now()}`;
    setPending((t) => [...t, { key: `ask-${Date.now()}`, role: "user", text }, { key: answerKey, role: "assistant", text: "", status: "Scanning" }]);
    const patch = (p: Partial<Turn>) => setPending((t) => t.map((x) => (x.key === answerKey ? { ...x, ...p } : x)));
    let draft = "";
    let answered = false;
    let newChatId: string | null = null;
    try {
      await streamSSE(
        `/api/notebooks/${id}/chat`,
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
          }
        },
        { method: "POST", body: JSON.stringify({ question: text, chat_id: chatId }) },
      );
      if (!answered) patch({ text: "Lost signal. Try again.", status: undefined });
    } catch (e) {
      // Out of chat messages: say so plainly. Upgrading happens on the web, so there is no purchase button here.
      const limit = e instanceof ApiError && e.status === 402;
      patch({
        text: limit
          ? "You have used this plan's chat messages. You can change your plan on notestack.ai."
          : "Lost signal. Try again.",
        status: undefined,
      });
    } finally {
      setBusy(false);
      if (newChatId && newChatId !== chatId) setStartedChatId(newChatId);
      // Swap the streamed turns for the saved messages once they are reloaded.
      const saved = newChatId ?? chatId;
      if (saved) {
        await queryClient.invalidateQueries({ queryKey: ["chat", saved, "messages"] });
        await queryClient.invalidateQueries({ queryKey: ["notebook", id, "chats"] });
        setPending((t) => (t.some((x) => x.key === answerKey && x.citations) ? [] : t));
      }
    }
  };

  const turns: Turn[] = [
    ...(messages.data ?? []).map((m) => ({ key: m.id, role: m.role, text: m.text, citations: m.citations })),
    ...pending,
  ];
  const posts = notebook.data?.documents.length ?? 0;

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={insets.top + HEADER_HEIGHT}>
      {header}
      <FlatList
        ref={list}
        data={turns}
        keyExtractor={(t) => t.key}
        contentContainerStyle={styles.list}
        keyboardDismissMode="interactive"
        onContentSizeChange={() => pending.length && list.current?.scrollToEnd({ animated: true })}
        ListHeaderComponent={
          <View style={styles.intro}>
            <Text style={styles.meta}>
              {posts} {posts === 1 ? "post" : "posts"}
            </Text>
            {notebook.data?.summary ? <Body muted>{notebook.data.summary}</Body> : null}
          </View>
        }
        renderItem={({ item }) => <Message turn={item} />}
        ListEmptyComponent={<Body muted>Ask anything about the posts in this notebook.</Body>}
      />
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <TextInput
          style={styles.input}
          value={question}
          onChangeText={setQuestion}
          placeholder="Ask your archive"
          placeholderTextColor={colors.text3}
          multiline
          editable={!busy}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          onPress={ask}
          disabled={busy || !question.trim()}
          style={({ pressed }) => [styles.send, (busy || !question.trim()) && styles.off, pressed && styles.pressed]}>
          <Text style={styles.sendText}>{busy ? "..." : "Ask"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Message({ turn }: { turn: Turn }) {
  const mine = turn.role === "user";
  const sources = turn.citations?.length ?? 0;
  return (
    <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
      {turn.status ? <Text style={styles.meta}>{turn.status}...</Text> : null}
      {turn.text ? (
        <Text style={styles.text} selectable>
          {turn.text}
        </Text>
      ) : null}
      {!mine && sources > 0 ? (
        <Text style={styles.meta}>
          {sources} {sources === 1 ? "source" : "sources"}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.black },
  list: { padding: gutter, gap: 12 },
  intro: { gap: 8, marginBottom: 8 },
  bubble: { padding: 14, borderRadius: radius.md, gap: 8, maxWidth: "92%" },
  mine: { alignSelf: "flex-end", backgroundColor: colors.blue },
  theirs: { alignSelf: "flex-start", backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line },
  text: { color: colors.text, fontSize: 16, lineHeight: 23 },
  meta: { color: colors.text3, fontSize: 13 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: gutter,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.black,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 11,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
  },
  send: {
    height: 44,
    paddingHorizontal: 18,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.blue,
  },
  off: { opacity: 0.5 },
  pressed: { opacity: 0.75 },
  sendText: { color: colors.white, fontSize: 16, fontWeight: "600" },
});

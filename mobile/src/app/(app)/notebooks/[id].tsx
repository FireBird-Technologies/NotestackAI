import { notebooksApi } from "@notestack/shared/endpoints";
import type { Artifact } from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { isMaking } from "@/artifacts/artifact-card";
import { prefetchFocus, prefetchSuggestions, useArtifactLimits } from "@/create/fields";
import { ChatTab } from "@/notebook/chat";
import { CreateTab, type Kind } from "@/notebook/create-tab";
import { LibraryTab } from "@/notebook/library-tab";
import { SourcesTab } from "@/notebook/sources-tab";
import { NotebookBar, type NotebookTab } from "@/notebook/tabs-bar";
import { Starfield } from "@/shell/starfield";
import { colors } from "@/ui/theme";
import { Body, Button, Centered, Loading } from "@/ui";

/**
 * A notebook, as the web app shows it on a phone: Sources (its chats and posts), Chat, Create and Library tabs. All four
 * stay mounted, so an answer keeps streaming while another tab is open.
 */
export default function NotebookScreen() {
  const { id } = useLocalSearchParams<{ id: string; title?: string }>();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<NotebookTab>("chat");
  // The chat on screen: null a new one (where a notebook opens, as on the web), else the one picked in Sources.
  const [selected, setSelected] = useState<string | null>(null);
  // Bumped when another chat is picked, so the Chat tab starts clean (an answer's own new chat id does not bump it).
  const [session, setSession] = useState(0);
  const [starting, setStarting] = useState<string[]>([]);
  const [makeError, setMakeError] = useState("");
  // The Create tab's open settings sheet; a next-step suggestion under an answer opens one from the Chat tab.
  const [making, setMaking] = useState<Kind | null>(null);

  const limits = useArtifactLimits();
  const notebook = useQuery({ queryKey: ["notebook", id], queryFn: () => notebooksApi.get(id) });
  const chats = useQuery({ queryKey: ["notebook", id, "chats"], queryFn: () => notebooksApi.chats(id) });
  const artifacts = useQuery({
    queryKey: ["notebook", id, "artifacts"],
    queryFn: () => notebooksApi.artifacts(id),
    // Something still being made: ask again every few seconds, so its bar moves, until it is ready.
    refetchInterval: (q) => (q.state.data?.some(isMaking) ? 4_000 : false),
  });

  // The dialogs' topic suggestions and report templates, asked for now so they are waiting when a dialog opens.
  const startIds = useMemo(() => {
    const docs = notebook.data?.documents ?? [];
    return docs.filter((d) => !d.locked).slice(0, limits.posts).map((d) => d.id).join(",");
  }, [notebook.data, limits.posts]);
  useEffect(() => {
    if (!startIds) return;
    prefetchFocus(id, startIds.split(","));
    prefetchSuggestions(id, startIds.split(","));
  }, [id, startIds]);

  const header = <Stack.Screen options={{ header: () => <NotebookBar tab={tab} onTab={setTab} /> }} />;
  const chatId = selected;

  if (notebook.isPending || chats.isPending) {
    return (
      <View style={styles.screen}>
        {header}
        <Loading />
      </View>
    );
  }
  if (notebook.error || chats.error) {
    return (
      <Centered>
        {header}
        <Body muted>{(notebook.error ?? chats.error)?.message}</Body>
        <Button
          title="Try again"
          onPress={() => {
            void notebook.refetch();
            void chats.refetch();
          }}
        />
      </Centered>
    );
  }

  const openChat = (next: string | null) => {
    setSelected(next);
    setSession((s) => s + 1);
    setTab("chat");
  };

  // Every make works the same way: Library opens (once the settings sheet has gone) with a "Starting your ..." card,
  // which the made thing replaces as soon as the server has it. Several can be on their way at once.
  const make = async (label: string, request: () => Promise<Artifact>) => {
    setMakeError("");
    setStarting((l) => [...l, label]);
    try {
      const a = await request();
      queryClient.setQueryData<Artifact[]>(["notebook", id, "artifacts"], (list) => [a, ...(list ?? []).filter((x) => x.id !== a.id)]);
    } catch (e) {
      setMakeError(e instanceof Error ? e.message : "Could not start it. Try again.");
    } finally {
      setStarting((l) => {
        const i = l.indexOf(label);
        return i < 0 ? l : [...l.slice(0, i), ...l.slice(i + 1)];
      });
      void queryClient.invalidateQueries({ queryKey: ["notebook", id, "artifacts"] });
      void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
    }
  };

  const nb = notebook.data;
  return (
    <View style={styles.screen}>
      {header}
      <Starfield />
      <View style={[styles.fill, tab !== "sources" && styles.hidden]}>
        <SourcesTab
          notebook={nb}
          chats={chats.data}
          chatId={chatId}
          onOpenChat={openChat}
          onNewChat={() => openChat(null)}
          onChatRemoved={(gone) => {
            if (gone === chatId) {
              setSelected(null);
              setSession((s) => s + 1);
            }
            void chats.refetch();
          }}
          onPostsChanged={() => void queryClient.invalidateQueries({ queryKey: ["notebook", id] })}
        />
      </View>
      <View style={[styles.fill, tab !== "chat" && styles.hidden]}>
        <ChatTab
          key={session}
          notebook={nb}
          chatId={chatId}
          onStarted={(started) => setSelected(started)}
          onNextStep={(kind) => {
            setTab("create");
            setMaking(kind);
          }}
        />
      </View>
      <View style={[styles.fill, tab !== "create" && styles.hidden]}>
        <CreateTab
          notebook={nb}
          chats={chats.data}
          chatId={chatId}
          making={making}
          onMaking={setMaking}
          onMake={(label, request) => void make(label, request)}
          onStarted={() => setTab("library")}
        />
      </View>
      <View style={[styles.fill, tab !== "library" && styles.hidden]}>
        <LibraryTab
          artifacts={artifacts.data}
          starting={starting}
          error={makeError || (artifacts.error?.message ?? "")}
          refreshing={artifacts.isRefetching}
          onRefresh={() => void artifacts.refetch()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.black },
  fill: { flex: 1 },
  hidden: { display: "none" },
});

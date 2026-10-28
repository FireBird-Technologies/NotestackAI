import { MAX_CHATS } from "@notestack/shared/create-options";
import { type GenerateBody, reportsApi, settingsApi, videosApi } from "@notestack/shared/endpoints";
import type { ChatSummary, Doc, ReportTemplate, VideoFocusSource, VideoFocusTopic } from "@notestack/shared/types";
import { useQuery } from "@tanstack/react-query";
import { SymbolView } from "expo-symbols";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, fonts, radius } from "@/ui/theme";
import { formatDate } from "@/ui";
import { pageStyles } from "@/ui/widgets";

/* ---------- Small pieces ---------- */

/** A field's heading (web: .vw-label), with "(optional)" after it when asked. */
export function Label({ children, optional }: { children: ReactNode; optional?: boolean }) {
  return (
    <Text style={styles.label}>
      {children}
      {optional ? <Text style={styles.optional}> (optional)</Text> : null}
    </Text>
  );
}

/** A muted note under a field (web: small.muted). */
export function Hint({ children, style }: { children: ReactNode; style?: object }) {
  return <Text style={[styles.hint, style]}>{children}</Text>;
}

/** One-of-several pills (web: Pills, the video wizard's "Video style" chips). */
export function Pills<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.chips} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            style={[styles.chip, on && styles.chipOn]}>
            <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A choice drawn as a card with a title, a line under it and a tick when chosen (audio styles, report formats). */
export function ChoiceCard({
  title,
  blurb,
  on,
  disabled,
  onPress,
  lines = 2,
  style,
}: {
  title: string;
  blurb: string;
  on: boolean;
  disabled?: boolean;
  onPress: () => void;
  /** How many lines of the blurb show. */
  lines?: number;
  style?: object;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ checked: on, disabled }}
      style={({ pressed }) => [styles.choice, on && styles.choiceOn, disabled && styles.off, pressed && styles.pressed, style]}>
      <View style={styles.choiceHead}>
        <Text style={styles.choiceTitle}>{title}</Text>
        <View style={[styles.radio, on && styles.radioOn]}>
          {on ? <SymbolView name={{ ios: "checkmark", android: "check" }} size={10} weight="bold" tintColor={colors.white} /> : null}
        </View>
      </View>
      <Text style={styles.choiceBlurb} numberOfLines={lines}>
        {blurb}
      </Text>
    </Pressable>
  );
}

/** A multi-line text box with a character count under it (web: textarea.input). */
export function TextArea({
  value,
  onChange,
  placeholder,
  max,
  rows = 4,
  count,
}: {
  value: string;
  onChange: (t: string) => void;
  placeholder?: string;
  max: number;
  rows?: number;
  /** Show "n/max" under it. */
  count?: boolean;
}) {
  return (
    <>
      <TextInput
        style={[styles.area, { minHeight: 24 * rows + 24 }]}
        value={value}
        onChangeText={(t) => onChange(t.slice(0, max))}
        placeholder={placeholder}
        placeholderTextColor={colors.text3}
        multiline
        maxLength={max}
        textAlignVertical="top"
      />
      {count ? (
        <Text style={styles.count}>
          {value.length}/{max}
        </Text>
      ) : null}
    </>
  );
}

/* ---------- The dropdown ---------- */

export type Option<T extends string> = { value: T; label: string; hint?: string };

/**
 * The web's Dropdown: a field showing the choice, which opens the list. `multiple` ticks several (the quiz's question
 * types): a tap flips one and the list stays open.
 */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  multiple,
  isOn,
  display,
  disabled,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  multiple?: boolean;
  isOn?: (v: T) => boolean;
  display?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  const on = (v: T) => (isOn ? isOn(v) : v === value);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${display ?? current?.label ?? ""}`}
        style={({ pressed }) => [styles.select, disabled && styles.off, pressed && styles.pressed]}>
        <Text style={styles.selectText} numberOfLines={1}>
          {display ?? current?.label ?? ""}
        </Text>
        <SymbolView name={{ ios: "chevron.down", android: "expand_more" }} size={14} tintColor={colors.text2} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Close">
          <Pressable style={styles.menu} onPress={() => {}}>
            <Text style={styles.menuTitle}>{label}</Text>
            <ScrollView style={styles.menuList}>
              {options.map((o) => {
                const picked = on(o.value);
                return (
                  <Pressable
                    key={o.value}
                    onPress={() => {
                      onChange(o.value);
                      if (!multiple) setOpen(false);
                    }}
                    accessibilityRole={multiple ? "checkbox" : "radio"}
                    accessibilityState={multiple ? { checked: picked } : { selected: picked }}
                    style={({ pressed }) => [styles.option, picked && styles.optionOn, pressed && styles.pressed]}>
                    <View style={styles.optionText}>
                      <Text style={[styles.optionLabel, picked && styles.optionLabelOn]}>{o.label}</Text>
                      {o.hint ? <Text style={styles.optionHint}>{o.hint}</Text> : null}
                    </View>
                    {picked ? <SymbolView name={{ ios: "checkmark", android: "check" }} size={14} tintColor={colors.blue} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
            {multiple ? (
              <Pressable onPress={() => setOpen(false)} style={styles.done} accessibilityRole="button">
                <Text style={styles.doneText}>Done</Text>
              </Pressable>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/* ---------- Ticking boxes ---------- */

export function Check({ on, disabled }: { on: boolean; disabled?: boolean }) {
  return (
    <View style={[styles.box, on && styles.boxOn, disabled && styles.off]}>
      {on ? <SymbolView name={{ ios: "checkmark", android: "check" }} size={12} weight="bold" tintColor={colors.white} /> : null}
    </View>
  );
}

/** A full-screen list over a sheet: a title, a close button and a scrolling body. */
export function ListSheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={pageStyles.sheet} edges={["top", "bottom"]}>
        <View style={pageStyles.sheetHead}>
          <Text style={pageStyles.sheetTitle}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Done">
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
        {children}
      </SafeAreaView>
    </Modal>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const chatTitle = (c: ChatSummary) => c.title?.trim() || "Untitled chat";

/**
 * "Made from" (web: video/PostsMenu.tsx SourcesMenu): the field says what is ticked; it opens the notebook's posts and
 * chats with a search, Select All and a box on each row.
 */
export function SourcesMenu({
  docs,
  postIds,
  onPostIds,
  maxPosts,
  chats,
  chatIds,
  onChatIds,
  maxChats,
}: {
  docs: Doc[];
  postIds: string[];
  onPostIds: (ids: string[]) => void;
  maxPosts: number;
  chats: ChatSummary[];
  chatIds: string[];
  onChatIds: (ids: string[]) => void;
  maxChats: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const posts = useMemo(
    () =>
      [...docs]
        .sort((a, b) => (Date.parse(b.added_at ?? "") || 0) - (Date.parse(a.added_at ?? "") || 0))
        .filter((d) => !needle || d.title.toLowerCase().includes(needle) || (d.source_title ?? "").toLowerCase().includes(needle)),
    [docs, needle],
  );
  const chatRows = useMemo(() => chats.filter((c) => !needle || chatTitle(c).toLowerCase().includes(needle)), [chats, needle]);

  // Select All ticks as many of the posts and chats in view as can be ticked; it reads as ticked once those are all in.
  const allPosts = posts.filter((d) => !d.locked).slice(0, maxPosts).map((d) => d.id);
  const allChats = chatRows.slice(0, maxChats).map((c) => c.id);
  const allOn = allPosts.length + allChats.length > 0 && allPosts.every((id) => postIds.includes(id)) && allChats.every((id) => chatIds.includes(id));
  const selectAll = () => {
    if (allOn) {
      onPostIds(postIds.filter((id) => !allPosts.includes(id)));
      onChatIds(chatIds.filter((id) => !allChats.includes(id)));
    } else {
      onPostIds([...new Set([...postIds, ...allPosts])].slice(0, maxPosts));
      onChatIds([...new Set([...chatIds, ...allChats])].slice(0, maxChats));
    }
  };
  const toggle = (ids: string[], id: string, max: number, set: (ids: string[]) => void) =>
    set(ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < max ? [...ids, id] : ids);

  const label = [postIds.length ? plural(postIds.length, "post") : "", chatIds.length ? plural(chatIds.length, "chat") : ""].filter(Boolean).join(" + ") || "Nothing selected";
  const empty = docs.length === 0 && chats.length === 0;

  if (empty) return <Hint>No posts yet. Add some from the Sources tab.</Hint>;
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Choose posts and chats: ${label}`}
        style={({ pressed }) => [styles.select, pressed && styles.pressed]}>
        <Text style={styles.selectText} numberOfLines={1}>
          {label}
        </Text>
        <SymbolView name={{ ios: "chevron.down", android: "expand_more" }} size={14} tintColor={colors.text2} />
      </Pressable>
      <ListSheet visible={open} title="Made from" onClose={() => setOpen(false)}>
        <View style={styles.pickerBar}>
          <TextInput
            style={[pageStyles.input, styles.pickerSearch]}
            value={q}
            onChangeText={setQ}
            placeholder={chats.length ? "Search posts and chats" : "Search posts"}
            placeholderTextColor={colors.text3}
            clearButtonMode="while-editing"
            autoCapitalize="none"
          />
          <Pressable
            onPress={selectAll}
            disabled={allPosts.length + allChats.length === 0}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: allOn }}
            style={styles.selectAll}>
            <Check on={allOn} />
            <Text style={styles.selectAllText}>Select All</Text>
          </Pressable>
          <Text style={styles.limitNote}>
            Up to {[Number.isFinite(maxPosts) ? `${maxPosts} posts` : "", chats.length ? `${maxChats} chats` : ""].filter(Boolean).join(" and ")}
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.pickerList} keyboardShouldPersistTaps="handled">
          {posts.map((d) => {
            const on = postIds.includes(d.id);
            const off = d.locked || (!on && postIds.length >= maxPosts);
            return (
              <Pressable
                key={`p:${d.id}`}
                disabled={off}
                onPress={() => toggle(postIds, d.id, maxPosts, onPostIds)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled: off }}
                style={[styles.pickRow, on && styles.pickRowOn, d.locked && styles.off]}>
                <Check on={on} disabled={off && !on} />
                <View style={styles.pickText}>
                  <Text style={styles.pickTitle} numberOfLines={2}>
                    <Text style={styles.tag}>POST </Text>
                    {d.title}
                  </Text>
                  <Text style={pageStyles.mono}>
                    {formatDate(d.published_at)} · {d.locked ? "Not indexed on your plan" : `${d.words} words`}
                  </Text>
                </View>
              </Pressable>
            );
          })}
          {chatRows.map((c) => {
            const on = chatIds.includes(c.id);
            const off = !on && chatIds.length >= maxChats;
            return (
              <Pressable
                key={`c:${c.id}`}
                disabled={off}
                onPress={() => toggle(chatIds, c.id, maxChats, onChatIds)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled: off }}
                style={[styles.pickRow, on && styles.pickRowOn]}>
                <Check on={on} disabled={off} />
                <View style={styles.pickText}>
                  <Text style={styles.pickTitle} numberOfLines={2}>
                    <Text style={styles.tag}>CHAT </Text>
                    {chatTitle(c)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
          {posts.length + chatRows.length === 0 ? <Hint>Nothing matches.</Hint> : null}
        </ScrollView>
      </ListSheet>
    </>
  );
}

/* ---------- Source and focus ---------- */

/** Posts a report or infographic reads; a quiz or flashcard set can pick as many as the plan indexes (web: useArtifactLimits). */
export function useArtifactLimits() {
  const q = useQuery({ queryKey: ["settings", "limits"], queryFn: settingsApi.limits, staleTime: 10 * 60_000 });
  return { posts: q.data?.posts ?? 20, selectable: q.data?.selectable_posts ?? 20 };
}

/** Focus suggestions already fetched, by source: reopening a dialog, or ticking back to an earlier choice, is instant. */
const topicCache = new Map<string, VideoFocusTopic[]>();
const topicWaiting = new Map<string, Promise<VideoFocusTopic[]>>();
const focusKey = (postIds: string[], chatIds: string[]) => (postIds.length ? `p:${[...postIds].sort().join(",")}` : `c:${[...chatIds].sort().join(",")}`);
const MAX_FOCUS_POSTS = 200;

function fetchTopics(key: string, fields: VideoFocusSource): Promise<VideoFocusTopic[]> {
  const hit = topicCache.get(key);
  if (hit) return Promise.resolve(hit);
  let wait = topicWaiting.get(key);
  if (!wait) {
    wait = videosApi
      .focusTopics(fields)
      .then((r) => {
        if (r.topics.length) topicCache.set(key, r.topics);
        return r.topics;
      })
      .finally(() => topicWaiting.delete(key));
    topicWaiting.set(key, wait);
  }
  return wait;
}

/** Ask for a notebook's focus suggestions ahead of time (the posts a dialog starts with ticked). */
export function prefetchFocus(notebookId: string, postIds: string[]) {
  if (!postIds.length) return;
  fetchTopics(`${notebookId}|${focusKey(postIds, [])}`, { document_ids: postIds, notebook_id: notebookId }).catch(() => undefined);
}

/** The suggested report templates for some sources, shared between asking early and the dialog asking when it opens. */
const suggestAsked = new Map<string, Promise<ReportTemplate[]>>();
export function suggestTemplates(body: Record<string, unknown>): Promise<ReportTemplate[]> {
  const key = JSON.stringify(body);
  let found = suggestAsked.get(key);
  if (!found) {
    found = reportsApi
      .suggest(body)
      .then((r) => r.templates)
      .catch((e) => {
        suggestAsked.delete(key);
        throw e;
      });
    suggestAsked.set(key, found);
  }
  return found;
}

export function prefetchSuggestions(notebookId: string, postIds: string[]) {
  if (postIds.length) suggestTemplates({ document_ids: postIds, notebook_id: notebookId }).catch(() => undefined);
}

export type SourceRequest = Pick<GenerateBody, "chat_ids" | "document_id" | "document_ids" | "notebook_id" | "topic">;
export type SourceSelection = { ready: boolean; loading: boolean; request: SourceRequest; label: string };

/** The sparkle cards of suggested topics (three grey ones while they come), picked one at a time. */
export function FocusCards({
  topics,
  picked,
  onPick,
}: {
  topics: VideoFocusTopic[] | null;
  picked: VideoFocusTopic | null;
  onPick: (t: VideoFocusTopic | null) => void;
}) {
  if (topics?.length === 0) return null;
  return (
    <View style={styles.focusGrid}>
      {topics === null
        ? [0, 1, 2].map((i) => (
            <View key={i} style={[styles.focusCard, styles.focusWait]}>
              <Text style={styles.sparkle}>✦</Text>
              <View style={styles.focusText}>
                <View style={styles.bar} />
                <View style={[styles.bar, styles.barShort]} />
              </View>
            </View>
          ))
        : topics.map((t) => {
            const on = picked?.title === t.title;
            return (
              <Pressable
                key={t.title}
                onPress={() => onPick(on ? null : t)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={({ pressed }) => [styles.focusCard, on && styles.focusOn, pressed && styles.pressed]}>
                <Text style={[styles.sparkle, on && styles.sparkleOn]}>✦</Text>
                <View style={styles.focusText}>
                  <Text style={styles.focusTitle}>{t.title}</Text>
                  {t.description ? (
                    <Text style={styles.focusDesc} numberOfLines={2}>
                      {t.description}
                    </Text>
                  ) : null}
                </View>
                {on ? <SymbolView name={{ ios: "checkmark", android: "check" }} size={14} tintColor={colors.blue} /> : null}
              </Pressable>
            );
          })}
    </View>
  );
}

/** The user's own topic, with its count and a line on how it is used. */
export function CustomTopic({
  title = "Custom topic",
  value,
  onChange,
  onFocus,
  note,
  rows = 4,
}: {
  title?: string;
  value: string;
  onChange: (t: string) => void;
  onFocus?: () => void;
  note: string;
  rows?: number;
}) {
  return (
    <View style={[styles.custom, value.trim() ? styles.customOn : null]}>
      <Text style={styles.customHead}>{title}</Text>
      <TextInput
        style={[styles.customInput, { minHeight: 22 * rows }]}
        value={value}
        onChangeText={(t) => onChange(t.slice(0, 500))}
        onFocus={onFocus}
        placeholder="Describe your own, e.g. how rebalancing protects a long-term portfolio"
        placeholderTextColor={colors.text3}
        multiline
        maxLength={500}
        textAlignVertical="top"
      />
      <View style={styles.customFoot}>
        <Text style={[styles.hint, styles.flex]}>{note}</Text>
        <Text style={styles.count}>{value.length}/500</Text>
      </View>
    </View>
  );
}

/**
 * What it is made from (the notebook's posts and chats, ticked to start with) and what to focus on (suggested cards or
 * your own topic): the web's SourceFocusFields, shared by the quiz, flashcard, report, infographic, audio and slide
 * dialogs. It reports the choice through onChange.
 */
export function SourceFocusFields({
  notebookId,
  docs,
  chats,
  currentChatId,
  preselectChat = false,
  largeSelection = false,
  what,
  noFocus = false,
  initialCustom,
  onChange,
}: {
  notebookId: string;
  docs: Doc[];
  chats: ChatSummary[];
  currentChatId?: string | null;
  preselectChat?: boolean;
  largeSelection?: boolean;
  what: string;
  noFocus?: boolean;
  initialCustom?: string;
  onChange: (s: SourceSelection) => void;
}) {
  const limits = useArtifactLimits();
  const max = largeSelection ? limits.selectable : limits.posts;
  // Every dialog starts with as many of the notebook's posts and chats ticked as can be; untick to narrow it down.
  const [postIds, setPostIds] = useState<string[]>(() => docs.filter((d) => !d.locked).slice(0, max).map((d) => d.id));
  const [chatIds, setChatIds] = useState<string[]>(() => {
    const open = preselectChat && currentChatId ? chats.filter((c) => c.id === currentChatId) : [];
    return [...open, ...chats.filter((c) => c.id !== currentChatId || !open.length)].slice(0, MAX_CHATS).map((c) => c.id);
  });
  const [topics, setTopics] = useState<{ key: string; list: VideoFocusTopic[] } | null>(null);
  const [focus, setFocus] = useState<VideoFocusTopic | null>(null);
  const [custom, setCustom] = useState((initialCustom ?? "").slice(0, 500));

  const sourceReady = chatIds.length > 0 || postIds.length > 0;
  const sourceKey = !sourceReady ? "" : `p:${[...postIds].sort().join(",")}|c:${[...chatIds].sort().join(",")}`;
  const shownTopics = topics?.key === sourceKey ? topics.list : null;

  // The cards belong to one source choice: asked for once it settles (a run of ticks makes one request).
  useEffect(() => {
    if (noFocus || !sourceReady) return;
    const fields: VideoFocusSource = postIds.length ? { document_ids: postIds.slice(0, MAX_FOCUS_POSTS), notebook_id: notebookId } : { chat_ids: chatIds };
    const cacheKey = `${notebookId}|${focusKey(postIds, chatIds)}`;
    const key = sourceKey;
    let live = true;
    const t = setTimeout(
      () => {
        fetchTopics(cacheKey, fields)
          .then((list) => live && setTopics({ key, list }))
          .catch(() => live && setTopics({ key, list: [] }));
      },
      topicCache.has(cacheKey) ? 0 : 600,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, noFocus]);

  const topic = focus ? `${focus.title}. ${focus.description}`.trim() : custom.trim();
  const waiting = shownTopics === null;
  const selection = useMemo<SourceSelection>(() => {
    const request: SourceRequest = {};
    if (postIds.length) {
      request.document_ids = postIds;
      request.notebook_id = notebookId;
    }
    if (chatIds.length) request.chat_ids = chatIds;
    if (topic) request.topic = topic;
    const label = [postIds.length ? plural(postIds.length, "post") : "", chatIds.length ? plural(chatIds.length, "chat") : ""].filter(Boolean).join(" + ") || "no sources";
    return { ready: sourceReady, loading: !noFocus && sourceReady && waiting, request, label };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, topic, waiting, noFocus]);
  const report = useRef(onChange);
  useEffect(() => {
    report.current = onChange;
  }, [onChange]);
  useEffect(() => report.current(selection), [selection]);

  return (
    <>
      <View style={styles.field}>
        <Label>Made from</Label>
        <SourcesMenu
          docs={docs}
          postIds={postIds}
          onPostIds={setPostIds}
          maxPosts={max}
          chats={chats}
          chatIds={chatIds}
          onChatIds={setChatIds}
          maxChats={MAX_CHATS}
        />
      </View>
      {!sourceReady && !noFocus ? <Hint>Pick at least one post or chat to see topic suggestions.</Hint> : null}
      {sourceReady && !noFocus ? (
        <View style={styles.field}>
          <Label>What should the {what} focus on?</Label>
          <FocusCards
            topics={shownTopics}
            picked={focus}
            onPick={(t) => {
              setFocus(t);
              setCustom("");
            }}
          />
          <CustomTopic
            value={custom}
            onChange={(t) => {
              setCustom(t);
              setFocus(null);
            }}
            onFocus={() => setFocus(null)}
            note="Keep it to what the selected material covers; anything it doesn't cover is left out."
          />
          {shownTopics ? (
            <Hint>
              {focus
                ? `The ${what} is mainly about this topic.`
                : custom.trim()
                  ? `The ${what} follows your topic, as far as the material covers it.`
                  : `None picked: the ${what} covers the material as a whole.`}
            </Hint>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

/** The bottom of a dialog: a note (why Generate is off, or an error) and the Generate button. */
export function Foot({ note, error, children }: { note?: string | false; error?: string; children: ReactNode }) {
  return (
    <View style={styles.foot}>
      {note ? <Hint>{note}</Hint> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.footRow}>{children}</View>
    </View>
  );
}

export const createStyles = StyleSheet.create({
  stack: { gap: 18 },
  field: { gap: 8 },
});

const styles = StyleSheet.create({
  field: { gap: 8 },
  flex: { flex: 1 },
  label: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase" },
  optional: { color: colors.text3, textTransform: "none", letterSpacing: 0 },
  hint: { color: colors.text3, fontSize: 13.5, lineHeight: 19 },
  count: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, alignSelf: "flex-end" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  chipOn: { backgroundColor: colors.blue, borderColor: colors.blue },
  chipText: { color: colors.text2, fontSize: 15 },
  chipTextOn: { color: colors.white, fontWeight: "600" },
  choice: { gap: 3, paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  choiceOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  choiceHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  choiceTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  choiceBlurb: { color: colors.text2, fontSize: 13, lineHeight: 18 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" },
  radioOn: { backgroundColor: colors.blue, borderColor: colors.blue },
  area: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 22,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  select: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  selectText: { flex: 1, color: colors.text, fontSize: 16 },
  backdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.6)", alignItems: "center", justifyContent: "center", padding: 28 },
  menu: {
    alignSelf: "stretch",
    maxHeight: "75%",
    paddingVertical: 12,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "#111214",
  },
  menuTitle: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12, textAlign: "center", paddingBottom: 8 },
  menuList: { flexGrow: 0 },
  option: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 46, marginHorizontal: 8, paddingHorizontal: 12, borderRadius: radius.sm },
  optionOn: { backgroundColor: colors.blue10 },
  optionText: { flex: 1, paddingVertical: 8 },
  optionLabel: { color: colors.text2, fontSize: 16 },
  optionLabelOn: { color: colors.text, fontWeight: "600" },
  optionHint: { color: colors.text3, fontSize: 13 },
  done: { alignSelf: "center", marginTop: 8, paddingHorizontal: 22, paddingVertical: 8 },
  doneText: { color: colors.blue, fontSize: 16, fontWeight: "600" },
  box: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: colors.blue, borderColor: colors.blue },
  pickerBar: { gap: 10, paddingHorizontal: 16, paddingTop: 12 },
  pickerSearch: { fontSize: 16 },
  selectAll: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  selectAllText: { color: colors.text2, fontFamily: fonts.mono, fontSize: 13 },
  limitNote: { color: colors.text3, fontSize: 12.5 },
  pickerList: { padding: 16, gap: 8 },
  pickRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line },
  pickRowOn: { borderColor: "rgba(33, 124, 255, 0.5)", backgroundColor: colors.blue10 },
  pickText: { flex: 1, gap: 3 },
  pickTitle: { color: colors.text, fontSize: 15.5, lineHeight: 21 },
  tag: { color: colors.blue, fontFamily: fonts.mono, fontSize: 11 },
  focusGrid: { gap: 8 },
  focusCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  focusWait: { opacity: 0.6 },
  focusOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  sparkle: { color: colors.text3, fontSize: 15, lineHeight: 20 },
  sparkleOn: { color: colors.blue },
  focusText: { flex: 1, gap: 2 },
  focusTitle: { color: colors.text, fontSize: 14.5, fontWeight: "600", lineHeight: 19 },
  focusDesc: { color: colors.text2, fontSize: 12.5, lineHeight: 17 },
  bar: { height: 8, borderRadius: 4, backgroundColor: colors.surface2 },
  barShort: { width: "60%" },
  custom: { gap: 8, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  customOn: { borderColor: colors.blue },
  customHead: { color: colors.text, fontSize: 15, fontWeight: "600" },
  customInput: { color: colors.text, fontSize: 15.5, lineHeight: 21, padding: 0 },
  customFoot: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  foot: { gap: 10, paddingTop: 4 },
  footRow: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
});

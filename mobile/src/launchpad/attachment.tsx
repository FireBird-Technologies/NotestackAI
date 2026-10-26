import { launchpadApi } from "@notestack/shared/endpoints";
import type { PostableArtifact } from "@notestack/shared/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { colors, fonts, radius } from "@/theme";
import { Body, ErrorText, Loading } from "@/ui";
import { Pager, pageStyles, PillButton } from "@/widgets";

const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** What an attachment carries, in a few words (web: launchpad/Attachment.tsx mediaLabel). */
export function mediaLabel(a: PostableArtifact): string {
  if (a.type === "upload") return a.media === "video" ? `Your video${a.duration_s ? ` ${fmtDuration(a.duration_s)}` : ""}` : "Your image";
  if (a.media === "audio") return `Audio${a.duration_s ? ` ${fmtDuration(a.duration_s)}` : ""} · download only`;
  if (a.media === "video" && a.rendering) return "Rendering: wait for it to finish";
  if (a.media === "video" && a.needs_render) return "Not rendered yet: render it first";
  if (a.media === "video") return a.duration_s ? `Video ${fmtDuration(a.duration_s)}` : "Video";
  if (a.media === "image") return a.media_count > 1 ? `${a.media_count} images` : "Image";
  if (a.media === "document") return "Document";
  return "Text";
}

function Thumb({ a }: { a: PostableArtifact }) {
  return a.thumb_url ? (
    <Image source={{ uri: a.thumb_url }} style={styles.thumb} contentFit="cover" />
  ) : (
    <View style={[styles.thumb, styles.thumbBlank]}>
      <SymbolView name={{ ios: a.media === "video" ? "play.rectangle" : "doc.text", android: a.media === "video" ? "smart_display" : "description" }} size={20} tintColor={colors.text3} />
    </View>
  );
}

/** The attached thing: its picture, title and kind, with Change and remove (web: AttachmentChip). */
export function AttachmentChip({ a, onChange, onRemove }: { a: PostableArtifact; onChange?: () => void; onRemove?: () => void }) {
  return (
    <View style={styles.chip}>
      <Thumb a={a} />
      <View style={styles.chipText}>
        <Text style={styles.title} numberOfLines={2}>
          {a.title}
        </Text>
        <Text style={pageStyles.mono}>
          {a.type_label} · {mediaLabel(a)}
        </Text>
      </View>
      {onChange ? <PillButton title="Change" small onPress={onChange} /> : null}
      {onRemove ? (
        <Pressable onPress={onRemove} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Remove ${a.title}`}>
          <SymbolView name={{ ios: "xmark", android: "close" }} size={14} tintColor={colors.text2} />
        </Pressable>
      ) : null}
    </View>
  );
}

const KINDS = [
  { id: "all", label: "All" },
  { id: "video", label: "Videos" },
  { id: "decks", label: "Slide decks" },
  { id: "reports", label: "Reports" },
  { id: "infographics", label: "Infographics" },
  { id: "uploads", label: "Uploads" },
] as const;

const PAGE = 10;

/** Pick something from the Library to attach (web: AttachPicker), ten at a time, by kind or search. */
export function AttachPicker({ onPick }: { onPick: (a: PostableArtifact) => void }) {
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("all");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q);
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const list = useQuery({
    queryKey: ["launchpad", "library", kind, search, page],
    queryFn: () => launchpadApi.library({ q: search, kind, kits: false, limit: PAGE, offset: page * PAGE }),
    placeholderData: keepPreviousData,
  });

  return (
    <View style={styles.picker}>
      <TextInput
        style={pageStyles.input}
        value={q}
        onChangeText={setQ}
        placeholder="Search your Library"
        placeholderTextColor={colors.text3}
        clearButtonMode="while-editing"
      />
      <View style={styles.kinds}>
        {KINDS.map((k) => {
          const on = k.id === kind;
          return (
            <Pressable
              key={k.id}
              onPress={() => {
                setKind(k.id);
                setPage(0);
              }}
              style={[styles.kind, on && styles.kindOn]}>
              <Text style={[styles.kindText, on && styles.kindTextOn]}>{k.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {list.isPending ? <Loading /> : null}
      {list.error ? <ErrorText>{list.error.message}</ErrorText> : null}
      {list.data && list.data.items.length === 0 ? <Body muted>Nothing to attach here yet.</Body> : null}
      {list.data?.items.map((a) => {
        const blocked = a.media === "audio" || (a.media === "video" && (a.needs_render || a.rendering));
        return (
          <Pressable key={a.id} disabled={blocked} onPress={() => onPick(a)} style={({ pressed }) => [styles.row, blocked && styles.blocked, pressed && styles.pressed]}>
            <Thumb a={a} />
            <View style={styles.chipText}>
              <Text style={styles.title} numberOfLines={2}>
                {a.title}
              </Text>
              <Text style={pageStyles.mono}>
                {a.type_label} · {mediaLabel(a)}
              </Text>
            </View>
          </Pressable>
        );
      })}
      <Pager page={page} pages={Math.ceil((list.data?.total ?? 0) / PAGE)} onChange={setPage} />
    </View>
  );
}

const styles = StyleSheet.create({
  thumb: { width: 52, height: 52, borderRadius: radius.sm, backgroundColor: colors.surface2 },
  thumbBlank: { alignItems: "center", justifyContent: "center" },
  chip: { flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong },
  chipText: { flex: 1, gap: 3 },
  title: { color: colors.text, fontSize: 15.5, fontWeight: "600" },
  picker: { gap: 12 },
  kinds: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  kind: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  kindOn: { backgroundColor: colors.blue, borderColor: colors.blue },
  kindText: { color: colors.text2, fontSize: 14, fontFamily: fonts.mono },
  kindTextOn: { color: colors.white },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
  blocked: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});

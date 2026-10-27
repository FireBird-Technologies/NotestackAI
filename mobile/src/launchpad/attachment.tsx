import type { PostableArtifact } from "@notestack/shared/types";
import { Image } from "expo-image";
import { SymbolView, type AndroidSymbol, type SFSymbol } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { LibraryPicker } from "@/launchpad/library-picker";
import { colors, radius } from "@/theme";
import { pageStyles, PillButton, Sheet } from "@/widgets";

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

/** An icon for each kind, when there is no picture (iOS SF Symbol, Android Material). */
function symbolOf(a: PostableArtifact): { ios: SFSymbol; android: AndroidSymbol } {
  if (a.type === "launch_kit") return { ios: "sparkle", android: "auto_awesome" };
  if (a.media === "video") return { ios: "film", android: "movie" };
  if (a.media === "audio") return { ios: "waveform", android: "graphic_eq" };
  if (a.type === "slide_deck") return { ios: "rectangle.on.rectangle", android: "slideshow" };
  if (a.type === "infographic") return { ios: "chart.bar", android: "bar_chart" };
  if (a.media === "image") return { ios: "photo", android: "image" };
  return { ios: "doc.text", android: "description" };
}

export function Thumb({ a }: { a: PostableArtifact }) {
  return a.thumb_url ? (
    <Image source={{ uri: a.thumb_url }} style={styles.thumb} contentFit="cover" />
  ) : (
    <View style={[styles.thumb, styles.thumbBlank]}>
      <SymbolView name={symbolOf(a)} size={20} tintColor={colors.text2} />
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

/** Pick something from the Library to attach, in a sheet over the composer (web: AttachPicker). Launch kits are never
 * attachments; `onCreateKit` links to making one. */
export function AttachSheet({ visible, onPick, onCreateKit, onClose }: {
  visible: boolean;
  onPick: (a: PostableArtifact) => void;
  onCreateKit?: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} title="Attach from your Library" onClose={onClose}>
      {visible ? <LibraryPicker onPick={onPick} onCreateKit={onCreateKit} /> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  thumb: { width: 46, height: 46, borderRadius: radius.sm + 2, backgroundColor: colors.surface2 },
  thumbBlank: { alignItems: "center", justifyContent: "center" },
  chip: { flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong },
  chipText: { flex: 1, gap: 3 },
  title: { color: colors.text, fontSize: 15.5, fontWeight: "600" },
});

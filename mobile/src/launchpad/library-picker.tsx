import { artifactsApi, launchpadApi, videosApi } from "@notestack/shared/endpoints";
import type { UploadSource } from "@notestack/shared/client";
import type { PostableArtifact } from "@notestack/shared/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { AudioOnlyDialog } from "@/artifacts/card-dialogs";
import { extOf, fileName, saveFile } from "@/lib/downloads";
import { ArrowRightIcon, MoreIcon, UploadIcon } from "@/ui/icons";
import { mediaLabel, Thumb } from "@/launchpad/attachment";
import { RenderVideoDialog } from "@/launchpad/render-dialog";
import { colors, radius } from "@/ui/theme";
import { ErrorText, formatDate, Loading } from "@/ui";
import { confirm, Dialog, Pager, pageStyles, PillButton, PopMenu, Sheet, type MenuItem } from "@/ui/widgets";

type Kind = "all" | "kits" | "video" | "decks" | "reports" | "infographics" | "audio" | "uploads";
const PAGE = 10;
const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "kits", label: "Launch Kits" },
  { id: "video", label: "Videos" },
  { id: "decks", label: "Slide Decks" },
  { id: "reports", label: "Reports" },
  { id: "infographics", label: "Infographics" },
  { id: "audio", label: "Audio" },
  { id: "uploads", label: "Uploads" },
];

const EMPTY: Record<Kind, string> = {
  all: "Nothing to attach here yet.",
  kits: "No launch kits yet: create a new one.",
  video: "Nothing to attach here yet.",
  decks: "No slide decks yet: make one from a notebook.",
  reports: "No reports yet: make one from a notebook.",
  infographics: "No infographics yet: make one from a notebook.",
  audio: "No audio overviews yet: make one from a notebook.",
  uploads: "Nothing uploaded yet.",
};

/** The warning before deleting, by kind: what goes, and what happens to the posts that carry it. */
function deleteWording(a: PostableArtifact): { title: string; body: string } {
  if (a.type === "upload") return { title: "Delete this upload?", body: "The file is deleted for good. Posts on your calendar that carry it are removed too." };
  if (a.type === "launch_kit") {
    return { title: "Delete this launch kit?", body: "Its LinkedIn post and hooks are deleted for good. Posts already scheduled from it stay on your calendar." };
  }
  if (a.media === "video") {
    return { title: "Delete this video?", body: "It's deleted here and on the video service, for good. Posts on your calendar that carry it are removed too." };
  }
  return { title: "Delete this item?", body: "It's deleted for good. Posts on your calendar that carry it are removed too." };
}

const MB = 1024 * 1024;

/** What LinkedIn takes, checked before uploading (the backend checks again; web: uploadProblem). */
function uploadProblem(a: ImagePicker.ImagePickerAsset): string | null {
  const video = a.type === "video";
  const ext = (a.fileName ?? a.uri).split(".").pop()?.toLowerCase() ?? "";
  const mime = a.mimeType ?? "";
  if (video ? !(mime === "video/mp4" || ext === "mp4") : !(["image/png", "image/jpeg", "image/gif"].includes(mime) || ["png", "jpg", "jpeg", "gif"].includes(ext))) {
    return "LinkedIn takes JPG, PNG or GIF images and MP4 videos.";
  }
  const size = a.fileSize ?? 0;
  if (!video && size > 36 * MB) return `This image is ${Math.round(size / MB)} MB; LinkedIn takes up to 36 MB.`;
  if (video && size > 300 * MB) return `This video is ${Math.round(size / MB)} MB; uploads are limited to 300 MB.`;
  if (video && size && size < 75 * 1024) return "This video is too small for LinkedIn (at least 75 KB).";
  return null;
}

function badgeOf(a: PostableArtifact): { label: string; tone: "video" | "kit" | "deck" | null } {
  if (a.type === "upload") return { label: "Upload", tone: null };
  if (a.media === "video") return { label: "Video", tone: "video" };
  if (a.media === "audio") return { label: "Audio", tone: null };
  if (a.type === "launch_kit") return { label: "Launch Kit", tone: "kit" };
  return { label: a.type_label, tone: a.type === "slide_deck" ? "deck" : null };
}

/**
 * What can go out with a post, ten at a time, by kind or search (web: launchpad/Attachment.tsx LibraryPicker). With
 * `onPickKit` (the Schedule a launch page) launch kits are listed too and open their page; with `onReschedule` an item
 * already scheduled opens that post. A video with no MP4 yet opens the render dialog; audio offers a download.
 */
export function LibraryPicker({ onPick, onPickKit, onCreateKit, onReschedule, onDuplicate, refreshKey = 0, openingId }: {
  onPick: (a: PostableArtifact) => void;
  onPickKit?: (a: PostableArtifact) => void;
  onCreateKit?: () => void;
  onReschedule?: (a: PostableArtifact, itemId: string) => void;
  onDuplicate?: (a: PostableArtifact, itemId: string) => void;
  /** Changed by the page to load the list again (a post was rescheduled, moved or deleted). */
  refreshKey?: number;
  /** The item whose scheduled post is being opened: its row shows a spinner and takes no taps meanwhile. */
  openingId?: string | null;
}) {
  const kits = Boolean(onPickKit);
  const [kind, setKind] = useState<Kind>("all");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const [rendering, setRendering] = useState<PostableArtifact | null>(null);
  const [audio, setAudio] = useState<PostableArtifact | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string; busy?: boolean } | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q);
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const list = useQuery({
    queryKey: ["launchpad", "library", kind, search, page, kits, refreshKey],
    queryFn: () => launchpadApi.library({ q: search, kind, kits, limit: PAGE, offset: page * PAGE }),
    placeholderData: keepPreviousData,
  });
  // Another kind, search or page: the loader until its items arrive, never the last ones meanwhile (the pager keeps
  // the last total so it doesn't jump).
  const loading = list.isPending || list.isPlaceholderData;
  const items = loading ? undefined : list.data?.items;
  const total = list.data?.total ?? 0;

  // Videos rendering (from here, the editor, or the web): check on them, and reload once one is done.
  const renderingIds = useMemo(() => (items ?? []).filter((a) => a.rendering).map((a) => a.id).join(","), [items]);
  const { refetch } = list;
  useEffect(() => {
    if (!renderingIds) return;
    const t = setInterval(async () => {
      const states = await Promise.all(renderingIds.split(",").map((id) => videosApi.status(id).catch(() => null)));
      if (states.some((s) => s && s.artifact_status !== "rendering")) void refetch();
    }, 8000);
    return () => clearInterval(t);
  }, [renderingIds, refetch]);

  const rendered = (id: string, schedule: boolean) => {
    void refetch();
    if (!schedule) return;
    // Asked for by id: once rendered it may sit on another page of the list.
    launchpadApi.postableOne(id).then(
      (found) => {
        setRendering(null);
        if (!found.needs_render) onPick(found);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : "Could not open the video. Try again."),
    );
  };

  const remove = (a: PostableArtifact) => {
    const w = deleteWording(a);
    confirm(w.title, "Delete", () => {
      artifactsApi.remove(a.id).then(
        // The last item on a page past the first: the page before it.
        () => (items?.length === 1 && page > 0 ? setPage(page - 1) : void refetch()),
        (e: unknown) => setError(e instanceof Error ? e.message : "Could not delete it. Try again."),
      );
    }, `${a.title}\n\n${w.body}`);
  };

  const saveName = async () => {
    if (!renaming) return;
    const title = renaming.title.trim();
    if (!title) return setError("Give it a name.");
    setRenaming({ ...renaming, busy: true });
    try {
      await artifactsApi.update(renaming.id, { title });
      setRenaming(null);
      setError("");
      void refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename it. Try again.");
      setRenaming((cur) => cur && { ...cur, busy: false });
    }
  };

  /** A photo or video from the phone: uploaded, made postable, then picked like anything else. */
  const upload = async () => {
    setError("");
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 1, allowsEditing: false });
    const asset = res.canceled ? null : res.assets?.[0];
    if (!asset) return;
    const problem = uploadProblem(asset);
    if (problem) return setError(problem);
    setUploading(true);
    try {
      const item = await launchpadApi.uploadToPost(new File(asset.uri) as unknown as UploadSource, asset.duration ? asset.duration / 1000 : undefined);
      void refetch();
      onPick(item);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload it. Try again.");
    } finally {
      setUploading(false);
    }
  };

  const menu = (a: PostableArtifact, next: { id: string } | undefined): MenuItem[] => {
    const kit = a.type === "launch_kit";
    return [
      ...(a.view_url ? [{ label: "Preview", onPress: () => void WebBrowser.openBrowserAsync(a.view_url!, { controlsColor: colors.blue }) }] : []),
      ...(a.download_url
        ? [{ label: "Download", onPress: () => void saveFile({ url: a.download_url! }, fileName(a.title, a.type_label), extOf(a.download_url!, "bin")).catch(() => undefined) }]
        : []),
      ...(next && onDuplicate ? [{ label: "Duplicate schedule", onPress: () => onDuplicate(a, next.id) }] : []),
      // Several posts of it coming up: each can be opened.
      ...(next && a.scheduled!.length > 1
        ? a.scheduled!.map((sc) => ({ label: `Edit schedule: ${formatDate(sc.scheduled_at, true)}`, onPress: () => onReschedule!(a, sc.id) }))
        : []),
      ...(a.type === "upload" ? [{ label: "Rename", onPress: () => setRenaming({ id: a.id, title: a.title }) }] : []),
      ...(kit
        ? [{ label: "Open kit", onPress: () => (onPickKit ? onPickKit(a) : router.push({ pathname: "/launchpad/kits/[id]", params: { id: a.id } })) }]
        : a.editable_video
          ? [{ label: "Open", onPress: () => router.push({ pathname: "/library/videos/[id]", params: { id: a.id } }) }]
          : []),
      { label: kit ? "Delete kit" : "Delete", danger: true, onPress: () => remove(a) },
    ];
  };

  return (
    <View style={styles.stack}>
      <View style={styles.kinds} accessibilityRole="radiogroup">
        {KINDS.filter((k) => kits || k.id !== "kits").map((k) => {
          const on = k.id === kind;
          return (
            <Pressable
              key={k.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
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
      {onCreateKit ? (
        <Pressable onPress={onCreateKit} accessibilityRole="link" style={styles.kitLink}>
          <Text style={styles.kitLinkText}>Create a new launch kit</Text>
          <ArrowRightIcon size={16} color={colors.text} />
        </Pressable>
      ) : null}
      {kind === "uploads" ? (
        <Pressable onPress={() => void upload()} disabled={uploading} accessibilityRole="button" style={({ pressed }) => [styles.drop, pressed && styles.pressed]}>
          {uploading ? <ActivityIndicator color={colors.blue} /> : <UploadIcon size={22} color={colors.blue} />}
          <Text style={styles.dropTitle}>{uploading ? "Uploading..." : "Upload a photo or video"}</Text>
          {!uploading ? <Text style={styles.dropHint}>JPG, PNG or GIF up to 36 MB · MP4 video up to 300 MB</Text> : null}
        </Pressable>
      ) : null}
      <TextInput
        style={pageStyles.input}
        value={q}
        onChangeText={setQ}
        placeholder="Search by title"
        placeholderTextColor={colors.text3}
        clearButtonMode="while-editing"
        accessibilityLabel="Search"
      />
      <ErrorText>{error}</ErrorText>
      {list.error ? <ErrorText>{list.error.message}</ErrorText> : null}
      {loading && !list.error ? <Loading /> : null}
      {items && items.length === 0 ? <Text style={styles.empty}>{EMPTY[kind]}</Text> : null}

      {items?.map((a) => {
        const kit = a.type === "launch_kit";
        // Already on the calendar (and this list offers it): open that post rather than start another one.
        const next = onReschedule && !kit && a.media !== "audio" ? a.scheduled?.[0] : undefined;
        const opening = openingId === a.id;
        const go = () => {
          if (opening) return;
          if (a.media === "audio") return setAudio(a);
          if (a.needs_render || a.rendering) return setRendering(a);
          if (next) return onReschedule!(a, next.id);
          if (kit && onPickKit) return onPickKit(a);
          onPick(a);
        };
        const badge = badgeOf(a);
        const sub = [
          kit ? "LinkedIn post and hooks ready to schedule" : mediaLabel(a),
          next ? `Scheduled ${formatDate(next.scheduled_at, true)}${a.scheduled!.length > 1 ? ` +${a.scheduled!.length - 1} more` : ""}` : a.created_at ? formatDate(a.created_at) : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <View key={a.id} style={styles.row}>
            <Pressable onPress={go} accessibilityRole="button" accessibilityState={{ busy: opening }} style={({ pressed }) => [styles.main, pressed && styles.pressed]}>
              <Thumb a={a} />
              <View style={styles.text}>
                <Text style={styles.title} numberOfLines={1}>
                  {a.title}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {sub}
                </Text>
              </View>
              {opening || a.rendering ? (
                <ActivityIndicator size="small" color={colors.blue} />
              ) : (
                <View style={[styles.badge, badge.tone === "video" && styles.badgeVideo, badge.tone === "kit" && styles.badgeKit, badge.tone === "deck" && styles.badgeDeck]}>
                  <Text style={[styles.badgeText, badge.tone && styles.badgeTextOn]}>{badge.label}</Text>
                </View>
              )}
            </Pressable>
            <PopMenu label={`Options for ${a.title}`} items={menu(a, next)} style={({ pressed }) => [styles.more, pressed && styles.pressed]}>
              <MoreIcon size={18} color={colors.text2} />
            </PopMenu>
          </View>
        );
      })}

      <Pager page={page} pages={Math.ceil(total / PAGE)} onChange={setPage} />

      {rendering ? <RenderVideoDialog video={rendering} onClose={() => setRendering(null)} onRendered={rendered} /> : null}
      <AudioOnlyDialog title={audio?.title ?? ""} downloadUrl={audio?.download_url} visible={audio !== null} onClose={() => setAudio(null)} />
      <Dialog visible={renaming !== null} title="Rename" onClose={() => !renaming?.busy && setRenaming(null)}>
        <TextInput
          style={pageStyles.input}
          value={renaming?.title ?? ""}
          onChangeText={(title) => setRenaming((cur) => cur && { ...cur, title })}
          maxLength={200}
          autoFocus
          editable={!renaming?.busy}
          accessibilityLabel="Name"
          onSubmitEditing={() => void saveName()}
        />
        <View style={styles.end}>
          <PillButton title="Cancel" onPress={() => setRenaming(null)} disabled={renaming?.busy} />
          <PillButton title={renaming?.busy ? "Saving..." : "Save"} variant="primary" busy={renaming?.busy} onPress={() => void saveName()} />
        </View>
      </Dialog>
    </View>
  );
}

/** The web's dark blue outline on chips and video badges. */
const CHIP_LINE = "rgba(33, 124, 255, 0.35)";

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
  stack: { gap: 14 },
  kinds: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  kind: { paddingHorizontal: 15, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: CHIP_LINE },
  kindOn: { backgroundColor: colors.blue, borderColor: colors.blue },
  kindText: { color: colors.text2, fontSize: 15 },
  kindTextOn: { color: colors.white },
  kitLink: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", paddingVertical: 4 },
  kitLinkText: { color: colors.text, fontSize: 17, fontWeight: "500" },
  drop: {
    alignItems: "center",
    gap: 6,
    padding: 18,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.lineStrong,
  },
  dropTitle: { color: colors.text, fontSize: 15.5, fontWeight: "600" },
  dropHint: { color: colors.text3, fontSize: 13, textAlign: "center" },
  empty: { color: colors.text2, fontSize: 15, lineHeight: 22 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingLeft: 12,
    paddingRight: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  main: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  text: { flex: 1, gap: 3 },
  title: { color: colors.text, fontSize: 16.5, fontWeight: "700" },
  sub: { color: colors.text2, fontSize: 14 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  badgeVideo: { borderColor: CHIP_LINE },
  badgeKit: { borderColor: colors.blue },
  badgeDeck: { borderStyle: "dashed", borderColor: colors.blue },
  badgeText: { color: colors.text2, fontSize: 13 },
  badgeTextOn: { color: colors.text },
  more: { width: 36, height: 44, alignItems: "center", justifyContent: "center" },
  end: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  pressed: { opacity: 0.7 },
});

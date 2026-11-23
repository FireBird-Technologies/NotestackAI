import { artifactsApi, launchpadApi, videosApi } from "@notestack/shared/endpoints";
import type { UploadSource } from "@notestack/shared/client";
import type { PostableArtifact } from "@notestack/shared/types";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { AudioOnlyDialog } from "@/artifacts/card-dialogs";
import { extOf, fileName, saveFile } from "@/lib/downloads";
import { ArrowRightIcon, MoreIcon, UploadIcon } from "@/ui/icons";
import { mediaLabel, Thumb } from "@/launchpad/attachment";
import { RenderVideoDialog } from "@/launchpad/render-dialog";
import { colors, radius } from "@/ui/theme";
import { ErrorText, formatDate, Loading } from "@/ui";
import { confirm, Dialog, Pager, pageStyles, PillButton, PopMenu, Sheet, type MenuItem } from "@/ui/widgets";
import i18n from "@/i18n";

type Kind = "all" | "kits" | "video" | "decks" | "reports" | "infographics" | "audio" | "uploads";
const PAGE = 10;
const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: i18n.t("lp.filter.all") },
  { id: "kits", label: i18n.t("lp.filter.kits") },
  { id: "video", label: i18n.t("lp.filter.video") },
  { id: "decks", label: i18n.t("lp.filter.decks") },
  { id: "reports", label: i18n.t("lp.filter.reports") },
  { id: "infographics", label: i18n.t("lp.filter.infographics") },
  { id: "audio", label: i18n.t("lp.filter.audio") },
  { id: "uploads", label: i18n.t("lp.filter.uploads") },
];

const EMPTY: Record<Kind, string> = {
  all: i18n.t("lp.empty.all"),
  kits: i18n.t("lp.empty.kits"),
  video: i18n.t("lp.empty.video"),
  decks: i18n.t("lp.empty.decks"),
  reports: i18n.t("lp.empty.reports"),
  infographics: i18n.t("lp.empty.infographics"),
  audio: i18n.t("lp.empty.audio"),
  uploads: i18n.t("lp.empty.uploads"),
};

/** The warning before deleting, by kind: what goes, and what happens to the posts that carry it. */
function deleteWording(a: PostableArtifact): { title: string; body: string } {
  if (a.type === "upload") return { title: i18n.t("lp.deleteUpload"), body: i18n.t("lp.deleteUploadBody") };
  if (a.type === "launch_kit") {
    return { title: i18n.t("lp.deleteKit"), body: i18n.t("lp.deleteKitBody") };
  }
  if (a.media === "video") {
    return { title: i18n.t("lp.deleteVideo"), body: i18n.t("lp.deleteVideoBody") };
  }
  return { title: i18n.t("lp.deleteItem"), body: i18n.t("lp.deleteItemBody") };
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
  if (a.type === "upload") return { label: i18n.t("lp.badgeUpload"), tone: null };
  if (a.media === "video") return { label: i18n.t("lp.badgeVideo"), tone: "video" };
  if (a.media === "audio") return { label: i18n.t("lp.badgeAudio"), tone: null };
  if (a.type === "launch_kit") return { label: i18n.t("lp.badgeKit"), tone: "kit" };
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
      (e: unknown) => setError(e instanceof Error ? e.message : i18n.t("lp.openVideoFailed")),
    );
  };

  const remove = (a: PostableArtifact) => {
    const w = deleteWording(a);
    confirm(w.title, i18n.t("common.delete"), () => {
      artifactsApi.remove(a.id).then(
        // The last item on a page past the first: the page before it.
        () => (items?.length === 1 && page > 0 ? setPage(page - 1) : void refetch()),
        (e: unknown) => setError(e instanceof Error ? e.message : i18n.t("lp.deleteFailed")),
      );
    }, `${a.title}\n\n${w.body}`);
  };

  const saveName = async () => {
    if (!renaming) return;
    const title = renaming.title.trim();
    if (!title) return setError(i18n.t("lp.giveName"));
    setRenaming({ ...renaming, busy: true });
    try {
      await artifactsApi.update(renaming.id, { title });
      setRenaming(null);
      setError("");
      void refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : i18n.t("lp.renameFailed"));
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
      setError(e instanceof Error ? e.message : i18n.t("lp.uploadFailed"));
    } finally {
      setUploading(false);
    }
  };

  const menu = (a: PostableArtifact, next: { id: string } | undefined): MenuItem[] => {
    const kit = a.type === "launch_kit";
    return [
      ...(a.view_url ? [{ label: i18n.t("lp.menuPreview"), onPress: () => void WebBrowser.openBrowserAsync(a.view_url!, { controlsColor: colors.blue }) }] : []),
      ...(a.download_url
        ? [{ label: i18n.t("lp.menuDownload"), onPress: () => void saveFile({ url: a.download_url! }, fileName(a.title, a.type_label), extOf(a.download_url!, "bin")).catch(() => undefined) }]
        : []),
      ...(next && onDuplicate ? [{ label: i18n.t("lp.duplicate"), onPress: () => onDuplicate(a, next.id) }] : []),
      // Several posts of it coming up: each can be opened.
      ...(next && a.scheduled!.length > 1
        ? a.scheduled!.map((sc) => ({ label: i18n.t("lp.editSchedule", { date: formatDate(sc.scheduled_at, true) }), onPress: () => onReschedule!(a, sc.id) }))
        : []),
      ...(a.type === "upload" ? [{ label: i18n.t("lp.rename"), onPress: () => setRenaming({ id: a.id, title: a.title }) }] : []),
      ...(kit
        ? [{ label: i18n.t("lp.openKit"), onPress: () => (onPickKit ? onPickKit(a) : router.push({ pathname: "/launchpad/kits/[id]", params: { id: a.id } })) }]
        : a.editable_video
          ? [{ label: i18n.t("lp.open"), onPress: () => router.push({ pathname: "/library/videos/[id]", params: { id: a.id } }) }]
          : []),
      { label: kit ? i18n.t("lp.deleteKitShort") : i18n.t("common.delete"), danger: true, onPress: () => remove(a) },
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
          <Text style={styles.kitLinkText}>{i18n.t("lp.newKit")}</Text>
          <ArrowRightIcon size={16} color={colors.text} />
        </Pressable>
      ) : null}
      {kind === "uploads" ? (
        <Pressable onPress={() => void upload()} disabled={uploading} accessibilityRole="button" style={({ pressed }) => [styles.drop, pressed && styles.pressed]}>
          {uploading ? <ActivityIndicator color={colors.blue} /> : <UploadIcon size={22} color={colors.blue} />}
          <Text style={styles.dropTitle}>{uploading ? i18n.t("lp.uploading") : i18n.t("lp.uploadMedia")}</Text>
          {!uploading ? <Text style={styles.dropHint}>{i18n.t("lp.uploadHint")}</Text> : null}
        </Pressable>
      ) : null}
      <TextInput
        style={pageStyles.input}
        value={q}
        onChangeText={setQ}
        placeholder={i18n.t("lp.searchTitle")}
        placeholderTextColor={colors.text3}
        clearButtonMode="while-editing"
        accessibilityLabel={i18n.t("lp.search")}
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
          kit ? i18n.t("lp.kitReady") : mediaLabel(a),
          next
            ? a.scheduled!.length > 1
              ? i18n.t("lp.scheduledMore", { date: formatDate(next.scheduled_at, true), count: a.scheduled!.length - 1 })
              : i18n.t("lp.scheduled", { date: formatDate(next.scheduled_at, true) })
            : a.created_at ? formatDate(a.created_at) : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <View key={a.id} style={styles.row}>
            <Pressable silent onPress={go} accessibilityRole="button" accessibilityState={{ busy: opening }} style={({ pressed }) => [styles.main, pressed && styles.pressed]}>
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
            <PopMenu label={i18n.t("lp.options", { title: a.title })} items={menu(a, next)} style={({ pressed }) => [styles.more, pressed && styles.pressed]}>
              <MoreIcon size={18} color={colors.text2} />
            </PopMenu>
          </View>
        );
      })}

      <Pager page={page} pages={Math.ceil(total / PAGE)} onChange={setPage} />

      {rendering ? <RenderVideoDialog video={rendering} onClose={() => setRendering(null)} onRendered={rendered} /> : null}
      <AudioOnlyDialog title={audio?.title ?? ""} downloadUrl={audio?.download_url} visible={audio !== null} onClose={() => setAudio(null)} />
      <Dialog visible={renaming !== null} title={i18n.t("lp.rename")} onClose={() => !renaming?.busy && setRenaming(null)}>
        <TextInput
          style={pageStyles.input}
          value={renaming?.title ?? ""}
          onChangeText={(title) => setRenaming((cur) => cur && { ...cur, title })}
          maxLength={200}
          autoFocus
          editable={!renaming?.busy}
          accessibilityLabel={i18n.t("lp.name")}
          onSubmitEditing={() => void saveName()}
        />
        <View style={styles.end}>
          <PillButton title={i18n.t("common.cancel")} onPress={() => setRenaming(null)} disabled={renaming?.busy} />
          <PillButton title={renaming?.busy ? i18n.t("common.saving") : i18n.t("common.save")} variant="primary" busy={renaming?.busy} onPress={() => void saveName()} />
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
    <Sheet visible={visible} title={i18n.t("lp.attachTitle")} onClose={onClose}>
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
  kitLinkText: { color: colors.text, fontSize: 17, fontWeight: "500", textDecorationLine: "underline", textDecorationColor: colors.white },
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

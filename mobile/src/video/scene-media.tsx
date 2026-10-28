import { ApiError } from "@notestack/shared/client";
import { type StockClip, videoEditApi } from "@notestack/shared/endpoints";
import { withoutMedia } from "@notestack/shared/sceneCode";
import type { VideoAsset, VideoScene } from "@notestack/shared/types";
import { File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { CheckIcon, CloseIcon, ListIcon } from "@/ui/icons";
import { colors, fonts, radius } from "@/ui/theme";
import { Dialog, PillButton, Sheet } from "@/ui/widgets";

import type { PanelProps } from "./types";
import { clock, ClipView, Spinner, vstyles } from "./ui";

/* The scene media dialogs (web: components/video/SceneMedia.tsx): pick an existing image or clip, upload, search stock
   footage, and write / review an AI image. A scene has one visual slot, so whatever is picked replaces the current one. */

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const IMAGE_MAX = 5 * 1024 * 1024; // blog2video's limit for a scene image

const message = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong. Try again.");

/** Cancel and a confirm button in one row, as the web's .vw-nav. */
function Nav({ busy, danger, confirm, busyLabel, onCancel, onConfirm, disabled, note }: {
  busy: boolean;
  danger?: boolean;
  confirm: string;
  busyLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <View style={vstyles.end}>
      {note ? <Text style={[vstyles.muted, vstyles.small, styles.grow]}>{note}</Text> : null}
      <PillButton small title="Cancel" disabled={busy} onPress={onCancel} />
      <PillButton small variant={danger ? "danger" : "primary"} title={busy ? busyLabel : confirm} busy={busy} disabled={disabled} onPress={onConfirm} />
    </View>
  );
}

/** Two big choices: reuse something this video already has, or bring in a new one. */
export function ChoiceModal({ title, subtitle, existing, fresh, freshIcon, onPick, onClose }: {
  title: string;
  subtitle: string;
  existing: string;
  fresh: string;
  freshIcon: ReactNode;
  onPick: (choice: "existing" | "new") => void;
  onClose: () => void;
}) {
  return (
    <Dialog visible title={title} onClose={onClose}>
      <Text style={vstyles.muted}>{subtitle}</Text>
      <View style={styles.choice}>
        <Pressable onPress={() => onPick("existing")} accessibilityRole="button" style={({ pressed }) => [styles.choiceBtn, pressed && styles.pressed]}>
          <ListIcon size={22} />
          <Text style={styles.choiceText}>{existing}</Text>
        </Pressable>
        <Pressable onPress={() => onPick("new")} accessibilityRole="button" style={({ pressed }) => [styles.choiceBtn, pressed && styles.pressed]}>
          {freshIcon}
          <Text style={styles.choiceText}>{fresh}</Text>
        </Pressable>
      </View>
    </Dialog>
  );
}

/** The video's own images or clips; the picked one goes on this scene (the same one can sit on several scenes). */
export function AssetPickerModal(p: PanelProps & { scene: VideoScene; kind: "image" | "video"; onNew: () => void; onClose: () => void }) {
  const assets: VideoAsset[] = (p.project.assets ?? []).filter((a) => a.asset_type === p.kind && !a.excluded && a.r2_url);
  const onScene = new Set((p.scene.images ?? []).map((i) => i.filename));
  const [picked, setPicked] = useState<VideoAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const noun = p.kind === "image" ? "image" : "clip";

  async function use() {
    if (!picked) return;
    setBusy(true);
    setFailed(false);
    // A still is assigned by its asset id, a clip by its file name.
    const ok = await p.act(() => (p.kind === "image" ? videoEditApi.assignImage(p.id, p.scene.id, picked.id) : videoEditApi.linkStock(p.id, p.scene.id, picked.filename)));
    setBusy(false);
    if (ok) p.onClose();
    else setFailed(true);
  }

  return (
    <Sheet visible title={p.kind === "image" ? "Use an existing image" : "Choose existing stock footage"} onClose={busy ? () => undefined : p.onClose}>
      {assets.length === 0 ? (
        <View style={styles.empty}>
          <Text style={vstyles.muted}>This video has no {p.kind === "image" ? "images" : "stock clips"} yet.</Text>
          <PillButton small title={p.kind === "image" ? "Upload an image" : "Find a new clip"} onPress={p.onNew} />
        </View>
      ) : (
        <>
          <Text style={[vstyles.muted, vstyles.small]}>Replaces this scene&apos;s current image or clip.</Text>
          <View style={styles.grid}>
            {assets.map((a) => {
              const on = picked?.id === a.id;
              return (
                <Pressable key={a.id} onPress={() => setPicked(a)} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: on }} style={[styles.asset, on && styles.assetOn]}>
                  {p.kind === "video" ? <ClipView uri={a.r2_url!} playing={on} /> : <Image source={{ uri: a.r2_url! }} style={styles.fill} contentFit="cover" />}
                  {onScene.has(a.filename) ? <Text style={styles.tag}>On this scene</Text> : null}
                  {a.duration_seconds ? <Text style={styles.time}>{clock(a.duration_seconds)}</Text> : null}
                  {on ? (
                    <View style={styles.check}>
                      <CheckIcon size={13} color={colors.white} />
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </>
      )}
      {failed ? <Text style={vstyles.error}>Couldn&apos;t add it. Try again.</Text> : null}
      <Nav busy={busy} confirm={`Use this ${noun}`} busyLabel="Adding..." disabled={!picked} onCancel={p.onClose} onConfirm={() => void use()} />
    </Sheet>
  );
}

/** Search the stock libraries; the picked clip is downloaded into the video and put on this scene. */
export function StockSearchModal(p: PanelProps & { scene: VideoScene; onClose: () => void }) {
  const [query, setQuery] = useState(p.scene.title ?? "");
  const [clips, setClips] = useState<StockClip[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [picked, setPicked] = useState<StockClip | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const search = async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError("");
    setPicked(null);
    try {
      setClips((await videoEditApi.searchStock(p.id, q.trim())).clips);
    } catch (e) {
      setSearchError(message(e));
    } finally {
      setSearching(false);
    }
  };

  // The first search runs by itself, on the scene's title.
  const [first] = useState(p.scene.title ?? "");
  useEffect(() => {
    const t = setTimeout(() => void search(first), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first]);

  async function use() {
    if (!picked) return;
    setBusy(true);
    setFailed(false);
    const ok = await p.act(async () => {
      // Downloading makes the clip an asset; linking puts it on this scene.
      const added = await videoEditApi.useStock(p.id, p.scene.id, picked);
      await videoEditApi.linkStock(p.id, p.scene.id, added.filename);
    });
    setBusy(false);
    if (ok) p.onClose();
    else setFailed(true);
  }

  return (
    <Sheet visible title="Add stock footage" onClose={busy ? () => undefined : p.onClose}>
      <Text style={vstyles.muted}>Clips are converted to 30 fps so they stay in sync with your video.</Text>
      <View style={styles.search}>
        <TextInput
          style={[vstyles.input, styles.grow]}
          value={query}
          onChangeText={setQuery}
          placeholder="Search stock footage"
          placeholderTextColor={colors.text3}
          editable={!busy}
          returnKeyType="search"
          onSubmitEditing={() => void search(query)}
        />
        <PillButton small variant="primary" title="Search" disabled={!query.trim() || searching || busy} onPress={() => void search(query)} />
      </View>
      {searching ? <Spinner /> : null}
      {searchError ? <Text style={vstyles.error}>{searchError}</Text> : null}
      {!searching && clips?.length === 0 ? <Text style={vstyles.muted}>No clips found. Try other words.</Text> : null}
      {!searching && clips && clips.length > 0 ? (
        <View style={styles.grid}>
          {clips.map((c) => {
            const on = picked === c;
            return (
              <Pressable key={`${c.provider}${c.id}`} onPress={() => setPicked(c)} disabled={busy} accessibilityRole="radio" accessibilityState={{ checked: on }} style={styles.clipCard}>
                <View style={[styles.asset, styles.clipThumb, on && styles.assetOn]}>
                  {/* The picked clip plays; the others show their poster */}
                  {on ? <ClipView uri={c.preview_url} playing /> : <Image source={{ uri: c.thumbnail_url }} style={styles.fill} contentFit="cover" />}
                  {c.duration ? <Text style={styles.time}>{clock(c.duration)}</Text> : null}
                  {on ? (
                    <View style={styles.check}>
                      <CheckIcon size={13} color={colors.white} />
                    </View>
                  ) : null}
                </View>
                <View style={styles.clipMeta}>
                  <Text style={styles.author} numberOfLines={1}>
                    {c.author || "Unknown"}
                  </Text>
                  <Text style={styles.provider}>{c.provider}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {failed ? <Text style={vstyles.error}>Couldn&apos;t add the clip. Try again.</Text> : null}
      <Nav busy={busy} confirm="Use this clip" busyLabel="Adding the clip..." disabled={!picked} note="Uses 1 AI edit" onCancel={p.onClose} onConfirm={() => void use()} />
    </Sheet>
  );
}

/** A confirmation that stays open (loading) until its change is done and the video reloaded. */
function ConfirmModal({ title, body, confirm, busyLabel, failedText, run, onClose }: {
  title: string;
  body: ReactNode;
  confirm: string;
  busyLabel: string;
  failedText: string;
  run: () => Promise<boolean>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const go = async () => {
    setBusy(true);
    setFailed(false);
    const ok = await run();
    setBusy(false);
    if (ok) onClose();
    else setFailed(true);
  };
  return (
    <Dialog visible title={title} onClose={busy ? () => undefined : onClose}>
      <Text style={vstyles.body}>{body}</Text>
      {failed ? <Text style={vstyles.error}>{failedText}</Text> : null}
      <Nav busy={busy} danger confirm={confirm} busyLabel={busyLabel} onCancel={onClose} onConfirm={() => void go()} />
    </Dialog>
  );
}

/** Take one image or clip off a scene. */
export function RemoveMediaModal(p: PanelProps & { scene: VideoScene; filename: string; kind: string; onClose: () => void }) {
  return (
    <ConfirmModal
      title={p.kind === "video" ? "Remove this stock clip?" : "Remove this image?"}
      body="It comes off this scene only. It stays in the video's media, so you can add it back from Images/footage."
      confirm="Remove"
      busyLabel="Removing..."
      failedText="Couldn't remove it. Try again."
      run={() => p.act(() => videoEditApi.updateScene(p.id, p.scene.id, { remotion_code: withoutMedia(p.scene, p.project.template, p.filename) }))}
      onClose={p.onClose}
    />
  );
}

/** Delete an image or clip from the video for good (blog2video removes its files and takes it off any scene). */
export function DeleteAssetModal(p: PanelProps & { asset: { id: number; kind: string }; onClose: () => void }) {
  const clip = p.asset.kind === "video";
  return (
    <ConfirmModal
      title={clip ? "Delete this stock clip?" : "Delete this image?"}
      body={`This permanently deletes the ${clip ? "stock clip" : "image"} from this video. It can't be recovered, and you'll need to add it again if you want it back.`}
      confirm="Delete"
      busyLabel="Deleting..."
      failedText="Couldn't delete it. Try again."
      run={() => p.act(() => videoEditApi.deleteAsset(p.id, p.asset.id))}
      onClose={p.onClose}
    />
  );
}

export { ConfirmModal };

/** The prompt for an AI image. Generating runs in the background (see the scene list), so this closes straight away. */
export function AiImageModal({ scene, aiEditsLeft, onGenerate, onClose }: { scene: VideoScene; aiEditsLeft: number | null; onGenerate: (prompt: string) => void; onClose: () => void }) {
  const [prompt, setPrompt] = useState("");
  return (
    <Sheet visible title="Generate image with AI" onClose={onClose}>
      <Text style={vstyles.muted}>
        Describe the image you want. Uses 1 AI edit{aiEditsLeft !== null ? ` · ${aiEditsLeft} left` : ""}.
      </Text>
      <Text style={styles.fieldLabel}>IMAGE DESCRIPTION</Text>
      <TextInput
        style={[vstyles.input, styles.prompt]}
        value={prompt}
        onChangeText={setPrompt}
        multiline
        maxLength={4000}
        autoFocus
        placeholder={scene.visual_description || "What should the image show?"}
        placeholderTextColor={colors.text3}
      />
      <Text style={[vstyles.muted, vstyles.small]}>The scene&apos;s description is also used to generate the image.</Text>
      <Nav busy={false} confirm="Generate" busyLabel="Generate" disabled={prompt.trim().length < 3} onCancel={onClose} onConfirm={() => onGenerate(prompt.trim())} />
    </Sheet>
  );
}

/** A generated image, not on the scene yet: keep uploads it (as blog2video does), discard drops it. */
export function AiReviewModal(p: PanelProps & { scene: VideoScene; base64: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function keep() {
    setBusy(true);
    setFailed(false);
    // Written to a file first: the upload sends a file, as the web sends the image's bytes.
    const file = new File(Paths.cache, `scene_${p.scene.id}_ai.png`);
    if (file.exists) file.delete();
    file.create();
    await file.write(p.base64, { encoding: "base64" });
    const ok = await p.act(() => videoEditApi.uploadImage(p.id, p.scene.id, file as unknown as globalThis.File));
    setBusy(false);
    if (ok) p.onDone();
    else setFailed(true);
  }

  return (
    <Sheet visible title="AI generated image" onClose={busy ? () => undefined : p.onDone}>
      <Image source={{ uri: `data:image/png;base64,${p.base64}` }} style={styles.preview} contentFit="contain" accessibilityLabel="The generated image" />
      <Text style={[vstyles.muted, vstyles.small]}>{busy ? "Adding the image to the scene..." : "Keeping it replaces this scene's current image or clip. The AI edit is used either way."}</Text>
      {failed ? <Text style={vstyles.error}>Couldn&apos;t add the image. Try again.</Text> : null}
      <View style={vstyles.end}>
        <Pressable onPress={() => void keep()} disabled={busy} accessibilityRole="button" accessibilityLabel="Keep the image" style={[styles.round, styles.keep]}>
          {busy ? <Spinner /> : <CheckIcon size={18} color={colors.white} />}
        </Pressable>
        <Pressable onPress={p.onDone} disabled={busy} accessibilityRole="button" accessibilityLabel="Discard the image" style={styles.round}>
          <CloseIcon size={18} />
        </Pressable>
      </View>
    </Sheet>
  );
}

export { message as errorMessage };

const styles = StyleSheet.create({
  grow: { flex: 1 },
  pressed: { opacity: 0.75 },
  choice: { flexDirection: "row", gap: 10 },
  choiceBtn: { flex: 1, alignItems: "center", gap: 10, paddingVertical: 18, paddingHorizontal: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface },
  choiceText: { color: colors.text, fontSize: 14, fontWeight: "600", textAlign: "center" },
  empty: { gap: 10, alignItems: "flex-start" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  asset: { width: "48%", aspectRatio: 16 / 9, borderRadius: radius.sm, overflow: "hidden", borderWidth: 2, borderColor: "transparent", backgroundColor: "#111" },
  assetOn: { borderColor: colors.blue },
  fill: { width: "100%", height: "100%" },
  tag: { position: "absolute", left: 6, top: 6, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: "hidden", backgroundColor: "rgba(0,0,0,0.7)", color: colors.white, fontSize: 11 },
  time: { position: "absolute", right: 6, bottom: 6, paddingHorizontal: 5, borderRadius: 4, overflow: "hidden", backgroundColor: "rgba(0,0,0,0.7)", color: colors.white, fontFamily: fonts.mono, fontSize: 11 },
  check: { position: "absolute", right: 6, top: 6, width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: colors.blue },
  search: { flexDirection: "row", alignItems: "center", gap: 8 },
  clipCard: { width: "48%", gap: 5 },
  clipThumb: { width: "100%" },
  clipMeta: { flexDirection: "row", justifyContent: "space-between", gap: 6 },
  author: { flex: 1, color: colors.text, fontSize: 12.5 },
  provider: { color: colors.text3, fontFamily: fonts.mono, fontSize: 11 },
  fieldLabel: { color: colors.text3, fontFamily: fonts.mono, fontSize: 11.5, letterSpacing: 1.4 },
  prompt: { minHeight: 160, textAlignVertical: "top" },
  preview: { width: "100%", aspectRatio: 16 / 9, borderRadius: radius.sm, backgroundColor: "#111" },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.lineStrong },
  keep: { backgroundColor: colors.blue, borderColor: colors.blue },
});

import { videoEditApi } from "@notestack/shared/endpoints";
import { fontDefaults, layoutName, withProps } from "@notestack/shared/sceneCode";
import type { VideoScene } from "@notestack/shared/types";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { ChevronIcon, FilmIcon, SparkleIcon, TrashIcon, UploadIcon } from "@/icons";
import { colors, fonts, radius } from "@/theme";
import { Dialog, PillButton } from "@/widgets";

import { FontSliders, SceneEditModal } from "./scene-edit";
import { AiImageModal, AiReviewModal, AssetPickerModal, ChoiceModal, ConfirmModal, errorMessage, IMAGE_MAX, IMAGE_TYPES, RemoveMediaModal, StockSearchModal } from "./scene-media";
import type { PanelProps } from "./types";
import { clock, GroupHead, inFives, Label, MediaThumb, NumBadge, Spinner, StatePill, vstyles } from "./ui";

const sorted = (scenes: VideoScene[]) => [...scenes].sort((a, b) => a.order - b.order);

/** An AI image being made for a scene. It is not on the scene until the user keeps it. */
type AiJob = { status: "running" } | { status: "ready"; base64: string } | { status: "failed"; error: string };

/** Scenes as rows, like blog2video's editor (web: SceneList): grouped by five, each row expands to its details. */
export function SceneList(p: PanelProps & { aiEditsLeft: number | null }) {
  const scenes = sorted(p.project.scenes);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [openGroup, setOpenGroup] = useState<number | null>(0); // one group of five open at a time, the first to start
  const [editing, setEditing] = useState<VideoScene | null>(null);
  const [adding, setAdding] = useState<number | null>(null); // position for the new scene
  const [deleting, setDeleting] = useState<VideoScene | null>(null);
  // AI images per scene id, kept here so collapsing the row does not lose one; leaving the editor does (as on blog2video).
  const [aiJobs, setAiJobs] = useState<Record<number, AiJob>>({});
  const [reviewing, setReviewing] = useState<number | null>(null);
  const summary = p.project.summary;

  /** Runs in the background (not through act, so other edits carry on); the review opens when it is done. */
  async function generateAi(sceneId: number, prompt: string) {
    setAiJobs((j) => ({ ...j, [sceneId]: { status: "running" } }));
    try {
      const out = await videoEditApi.generateImage(p.id, sceneId, prompt);
      setAiJobs((j) => ({ ...j, [sceneId]: { status: "ready", base64: out.image_base64 } }));
      setReviewing((r) => r ?? sceneId);
    } catch (e) {
      setAiJobs((j) => ({ ...j, [sceneId]: { status: "failed", error: errorMessage(e) } }));
    }
  }

  function closeReview(sceneId: number) {
    setAiJobs(({ [sceneId]: _gone, ...rest }) => rest);
    // Another scene's image may be waiting too.
    const next = Object.entries(aiJobs).find(([id, j]) => Number(id) !== sceneId && j.status === "ready");
    setReviewing(next ? Number(next[0]) : null);
  }

  const reviewScene = reviewing === null ? undefined : scenes.find((sc) => sc.id === reviewing);
  const reviewJob = reviewing === null ? undefined : aiJobs[reviewing];

  return (
    <View style={vstyles.stack}>
      <View style={styles.head}>
        <Text style={vstyles.h2}>{p.project.name}</Text>
        <Text style={vstyles.muted}>
          {summary?.scenes ?? scenes.length} scenes{summary ? `: ${summary.images} images, ${summary.clips ?? 0} stock clips` : ""}. Tap <Text style={vstyles.accent}>Edit</Text> on any scene to change it.
        </Text>
      </View>

      {inFives(scenes).map((group, g) => {
        const first = g * 5 + 1;
        const open = openGroup === g;
        return (
          <View key={g} style={styles.group}>
            <GroupHead label={`Scenes ${first}–${first + group.length - 1}`} open={open} onPress={() => setOpenGroup(open ? null : g)} />
            {open
              ? group.map((s) => {
                  const i = scenes.indexOf(s);
                  const isOpen = expanded === s.id;
                  return (
                    <View key={s.id} style={[styles.row, isOpen && styles.rowOpen]}>
                      <View style={styles.line}>
                        <NumBadge n={i + 1} />
                        <Pressable onPress={() => setExpanded(isOpen ? null : s.id)} style={styles.titleBtn} accessibilityRole="button">
                          <Text style={styles.title} numberOfLines={2}>
                            {s.title || `Scene ${i + 1}`}
                          </Text>
                        </Pressable>
                      </View>
                      <View style={styles.actions}>
                        <PillButton small title="Edit" disabled={p.disabled} onPress={() => setEditing(s)} />
                        <StatePill label="Scene" ok={!!s.layout} />
                        <StatePill label="Audio" ok={!!s.audio_url} />
                        <Text style={styles.duration}>{Number(s.duration_seconds ?? 0).toFixed(1)}s</Text>
                        <View style={styles.grow} />
                        <Pressable onPress={() => setExpanded(isOpen ? null : s.id)} hitSlop={6} accessibilityRole="button" accessibilityLabel={isOpen ? "Collapse" : "Expand"} style={styles.iconBtn}>
                          <View style={isOpen && styles.flip}>
                            <ChevronIcon size={16} />
                          </View>
                        </Pressable>
                        <Pressable onPress={() => setDeleting(s)} disabled={p.disabled} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Delete scene ${i + 1}`} style={[styles.iconBtn, p.disabled && styles.off]}>
                          <TrashIcon size={17} />
                        </Pressable>
                      </View>
                      {isOpen ? (
                        <SceneDetail
                          {...p}
                          scene={s}
                          aiJob={aiJobs[s.id]}
                          onGenerateAi={(prompt) => void generateAi(s.id, prompt)}
                          onReviewAi={() => setReviewing(s.id)}
                          onDismissAi={() => setAiJobs(({ [s.id]: _gone, ...rest }) => rest)}
                        />
                      ) : null}
                    </View>
                  );
                })
              : null}
          </View>
        );
      })}

      {scenes.length === 0 ? <PillButton title="＋ Add the first scene" disabled={p.disabled} onPress={() => setAdding(1)} /> : null}

      {editing ? (
        <SceneEditModal
          id={p.id}
          scene={editing}
          index={scenes.findIndex((s) => s.id === editing.id)}
          template={p.project.template}
          aiEditsLeft={p.aiEditsLeft}
          layoutInfo={p.layoutInfo}
          layoutNames={p.layoutNames}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void p.act(async () => undefined);
          }}
        />
      ) : null}
      {reviewScene && reviewJob?.status === "ready" ? <AiReviewModal {...p} scene={reviewScene} base64={reviewJob.base64} onDone={() => closeReview(reviewScene.id)} /> : null}
      {deleting ? (
        <ConfirmModal
          title={`Delete scene ${scenes.findIndex((sc) => sc.id === deleting.id) + 1}?`}
          body={`"${deleting.title || "This scene"}" and its voiceover will be deleted from this video. This can't be undone.`}
          confirm="Delete"
          busyLabel="Deleting..."
          failedText="Couldn't delete the scene. Try again."
          run={() => p.act(() => videoEditApi.deleteScene(p.id, deleting.id))}
          onClose={() => setDeleting(null)}
        />
      ) : null}
      {adding !== null ? (
        <AddSceneModal
          position={adding}
          onClose={() => setAdding(null)}
          onAdd={(prompt) => {
            setAdding(null);
            void p.startJob("Adding a scene", () => videoEditApi.addScene(p.id, prompt, adding), () => videoEditApi.addSceneStatus(p.id));
          }}
        />
      ) : null}
    </View>
  );
}

function AddSceneModal({ position, onClose, onAdd }: { position: number; onClose: () => void; onAdd: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState("");
  return (
    <Dialog visible title={`Add a scene at position ${position}`} onClose={onClose}>
      <TextInput
        style={[vstyles.input, vstyles.area]}
        value={prompt}
        onChangeText={setPrompt}
        multiline
        maxLength={2000}
        autoFocus
        placeholder="What should the new scene cover?"
        placeholderTextColor={colors.text3}
      />
      <Text style={[vstyles.muted, vstyles.small]}>AI writes the scene, its narration and its layout. Uses 1 AI edit.</Text>
      <View style={vstyles.end}>
        <PillButton small title="Cancel" onPress={onClose} />
        <PillButton small variant="primary" title="Add scene" disabled={prompt.trim().length < 3} onPress={() => onAdd(prompt.trim())} />
      </View>
    </Dialog>
  );
}

/** A scene's voiceover with play / pause and where it is (web: an <audio controls>). */
function SceneAudio({ url }: { url: string }) {
  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);
  const pct = status.duration ? Math.min(100, (status.currentTime / status.duration) * 100) : 0;
  return (
    <View style={styles.audio}>
      <Pressable
        onPress={() => {
          if (status.playing) return player.pause();
          if (status.duration && status.currentTime >= status.duration - 0.1) void player.seekTo(0);
          player.play();
        }}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? "Pause" : "Play"}
        style={styles.play}>
        {status.playing ? <View style={styles.pause} /> : <View style={styles.tri} />}
      </Pressable>
      <Text style={styles.time}>{clock(status.currentTime)}</Text>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.time}>{clock(status.duration || 0)}</Text>
    </View>
  );
}

/** The expanded row: display text, visual description, layout, typography, audio, images and footage. */
function SceneDetail(p: PanelProps & { scene: VideoScene; aiEditsLeft: number | null; aiJob?: AiJob; onGenerateAi: (prompt: string) => void; onReviewAi: () => void; onDismissAi: () => void }) {
  const s = p.scene;
  const [title, setTitle] = useState<number | null>(s.title_font_size ?? null);
  const [desc, setDesc] = useState<number | null>(s.desc_font_size ?? null);
  // Which media dialog is open: the AI prompt, the image / stock choice, the existing-media pickers, the stock search.
  const [modal, setModal] = useState<"ai" | "image" | "stock" | "pick-image" | "pick-clip" | "search" | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [removing, setRemoving] = useState<{ filename: string; kind: string } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Which font sizes are changed but not yet saved and applied; their spinners show until the save finishes.
  const [fontSaving, setFontSaving] = useState({ title: false, desc: false });
  const saveSeq = useRef(0);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // Font sizes save by themselves a moment after the slider stops, like blog2video.
  function setFont(kind: "title" | "desc", value: number) {
    const next = { title, desc, [kind]: value };
    if (kind === "title") setTitle(value);
    else setDesc(value);
    setFontSaving((f) => ({ ...f, [kind]: true }));
    const seq = ++saveSeq.current;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await p.act(() =>
        videoEditApi.updateScene(p.id, s.id, {
          remotion_code: withProps(s, p.project.template, { titleFontSize: next.title ?? undefined, descriptionFontSize: next.desc ?? undefined }),
        }),
      );
      if (saveSeq.current === seq) setFontSaving({ title: false, desc: false });
    }, 500);
  }

  /** A photo from the phone's library: PNG, JPEG or WebP up to 5 MB, as the web's file input. */
  async function pickAndUpload() {
    setUploadError("");
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, allowsEditing: false });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    const type = a.mimeType ?? "";
    if ((type && !IMAGE_TYPES.includes(type)) || (a.fileSize ?? 0) > IMAGE_MAX) {
      setUploadError("Pick a PNG, JPEG or WebP image of 5 MB or less.");
      return;
    }
    setUploading(true);
    await p.act(() => videoEditApi.uploadImage(p.id, s.id, new File(a.uri) as unknown as globalThis.File));
    setUploading(false);
  }

  // The photo library opens once the dialog that asked for it has gone: iOS can't show one screen while another closes.
  const pickSoon = () => setTimeout(() => void pickAndUpload(), 450);
  const aiRunning = p.aiJob?.status === "running";

  return (
    <View style={styles.detail}>
      <View style={styles.block}>
        <Label>Display text</Label>
        <Text style={vstyles.body}>{s.display_text || <Text style={vstyles.muted}>None</Text>}</Text>
      </View>
      {s.visual_description ? (
        <View style={styles.block}>
          <Label>Visual description</Label>
          <Text style={[vstyles.muted, styles.italic]}>{s.visual_description}</Text>
        </View>
      ) : null}
      <View style={styles.block}>
        <Label>Layout</Label>
        <Text style={styles.layoutPill}>{layoutName(s.layout, p.layoutNames)}</Text>
      </View>
      <FontSliders
        title={title}
        desc={desc}
        defaults={fontDefaults(p.layoutSchema, s.layout, p.project.aspect_ratio)}
        saving={fontSaving}
        onTitle={(v) => setFont("title", v)}
        onDesc={(v) => setFont("desc", v)}
      />
      <View style={styles.block}>
        <Label>Audio</Label>
        {s.audio_url ? <SceneAudio url={s.audio_url} /> : <Text style={vstyles.muted}>No voiceover yet.</Text>}
      </View>
      <View style={styles.block}>
        <Label>Images/footage ({s.images?.length ?? 0})</Label>
        <View style={styles.tiles}>
          {(s.images ?? []).map((img) => (
            <View key={img.filename} style={styles.tile}>
              <MediaThumb uri={img.url} kind={img.kind} />
              <Pressable onPress={() => setRemoving({ filename: img.filename, kind: img.kind })} disabled={p.disabled} accessibilityRole="button" accessibilityLabel="Remove from scene" style={styles.tileX}>
                <Text style={styles.tileXText}>✕</Text>
              </Pressable>
            </View>
          ))}
          {aiRunning ? (
            <View style={[styles.tile, styles.loading]} accessibilityLabel="Generating an image">
              <Spinner />
            </View>
          ) : null}
          {uploading ? (
            <View style={[styles.tile, styles.loading]} accessibilityLabel="Uploading the image">
              <Spinner />
            </View>
          ) : null}
          {/* Add tiles: icon in a tinted circle, label under it */}
          <AddTile label="AI image" ai disabled={p.disabled || aiRunning} onPress={() => setModal("ai")} icon={<SparkleIcon size={18} color={colors.blue} />} />
          <AddTile label="Image" disabled={p.disabled || uploading} onPress={() => setModal("image")} icon={<UploadIcon size={18} />} />
          <AddTile label="Stock footage" disabled={p.disabled} onPress={() => setModal("stock")} icon={<FilmIcon size={18} />} />
        </View>
        {aiRunning ? (
          <View style={vstyles.row}>
            <Spinner />
            <Text style={vstyles.muted}>Generating image...</Text>
          </View>
        ) : null}
        {p.aiJob?.status === "ready" ? (
          <Text style={vstyles.muted}>
            Your AI image is ready.{" "}
            <Text style={styles.link} onPress={p.onReviewAi}>
              Review it
            </Text>
          </Text>
        ) : null}
        {p.aiJob?.status === "failed" ? (
          <Text style={vstyles.error}>
            {p.aiJob.error}{" "}
            <Text style={styles.link} onPress={p.onDismissAi}>
              Dismiss
            </Text>
          </Text>
        ) : null}
        {uploadError ? <Text style={vstyles.error}>{uploadError}</Text> : null}
      </View>

      {modal === "ai" ? (
        <AiImageModal
          scene={s}
          aiEditsLeft={p.aiEditsLeft}
          onClose={() => setModal(null)}
          onGenerate={(prompt) => {
            setModal(null);
            p.onGenerateAi(prompt);
          }}
        />
      ) : null}
      {modal === "image" ? (
        <ChoiceModal
          title="Add scene image"
          subtitle="Choose where to pick the image from."
          existing="Use existing images"
          fresh="Upload image file"
          freshIcon={<UploadIcon size={22} />}
          onClose={() => setModal(null)}
          onPick={(c) => {
            setModal(c === "existing" ? "pick-image" : null);
            if (c === "new") pickSoon();
          }}
        />
      ) : null}
      {modal === "stock" ? (
        <ChoiceModal
          title="Add stock footage"
          subtitle="Reuse a clip this video already has, or find a new one."
          existing="Choose existing stock footage"
          fresh="Add a new one"
          freshIcon={<FilmIcon size={22} />}
          onClose={() => setModal(null)}
          onPick={(c) => setModal(c === "existing" ? "pick-clip" : "search")}
        />
      ) : null}
      {modal === "pick-image" ? (
        <AssetPickerModal
          {...p}
          scene={s}
          kind="image"
          onClose={() => setModal(null)}
          onNew={() => {
            setModal(null);
            pickSoon();
          }}
        />
      ) : null}
      {modal === "pick-clip" ? <AssetPickerModal {...p} scene={s} kind="video" onClose={() => setModal(null)} onNew={() => setModal("search")} /> : null}
      {modal === "search" ? <StockSearchModal {...p} scene={s} onClose={() => setModal(null)} /> : null}
      {removing ? <RemoveMediaModal {...p} scene={s} filename={removing.filename} kind={removing.kind} onClose={() => setRemoving(null)} /> : null}
    </View>
  );
}

function AddTile({ label, icon, ai, disabled, onPress }: { label: string; icon: React.ReactNode; ai?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.tile, styles.addTile, disabled && styles.off, pressed && styles.pressed]}>
      <View style={[styles.addIcon, ai && styles.addIconAi]}>{icon}</View>
      <Text style={styles.addLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { gap: 6 },
  group: { gap: 8 },
  grow: { flex: 1 },
  off: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
  flip: { transform: [{ rotate: "180deg" }] },
  row: { gap: 10, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(12, 12, 14, 0.92)" },
  rowOpen: { borderColor: "rgba(33, 124, 255, 0.45)" },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  titleBtn: { flex: 1 },
  title: { color: colors.text, fontSize: 15.5, fontWeight: "600", lineHeight: 21 },
  actions: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  duration: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12 },
  iconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.lineStrong },
  detail: { gap: 14, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  block: { gap: 6 },
  italic: { fontStyle: "italic" },
  layoutPill: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, overflow: "hidden", backgroundColor: colors.blue10, color: colors.blue, fontSize: 13 },
  audio: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  play: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: colors.blue },
  tri: { width: 0, height: 0, marginLeft: 3, borderTopWidth: 6, borderBottomWidth: 6, borderLeftWidth: 10, borderTopColor: "transparent", borderBottomColor: "transparent", borderLeftColor: colors.white },
  pause: { width: 9, height: 11, borderLeftWidth: 3, borderRightWidth: 3, borderColor: colors.white },
  time: { color: colors.text2, fontFamily: fonts.mono, fontSize: 11.5 },
  track: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" },
  fill: { height: 4, backgroundColor: colors.blue },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: { width: "31%", aspectRatio: 16 / 10, borderRadius: radius.sm, overflow: "hidden", backgroundColor: "#111", borderWidth: 1, borderColor: colors.line },
  tileX: { position: "absolute", right: 4, top: 4, width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.7)" },
  tileXText: { color: colors.white, fontSize: 12 },
  loading: { alignItems: "center", justifyContent: "center" },
  addTile: { alignItems: "center", justifyContent: "center", gap: 4, borderStyle: "dashed", borderColor: colors.lineStrong, backgroundColor: colors.surface },
  addIcon: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 },
  addIconAi: { backgroundColor: colors.blue10 },
  addLabel: { color: colors.text2, fontSize: 11.5 },
  link: { color: colors.blue, textDecorationLine: "underline" },
});

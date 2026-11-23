import { videoEditApi, videoVoicesApi } from "@notestack/shared/endpoints";
import type { VideoCatalog, VideoSavedVoice, VideoTemplate } from "@notestack/shared/types";
import { FONTS } from "@notestack/shared/videoFonts";
import { type ComponentRef, type ReactNode, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, useWindowDimensions, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { useVoicePlayer } from "@/lib/audio";
import { Select } from "@/create/fields";
import { ColorField, TemplateThumb } from "@/create/video";
import { CheckIcon } from "@/ui/icons";
import { colors, fonts, radius } from "@/ui/theme";
import { PillButton, Sheet } from "@/ui/widgets";

import { ConfirmModal } from "./scene-media";
import type { PanelProps } from "./types";
import { Label, Slider, vstyles } from "./ui";
import i18n, { tKey } from "@/i18n";

const SPEEDS = [0.5, 1, 1.5, 2, 2.5];
const NO_VOICE = "__none";
const DEFAULT_FONT = "__default";
const cap = (s?: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "");

type SaveKey = "colors" | "font" | "captions" | "speed" | "template" | "voice" | "language";

/** A card's save button: off until something changed, a spinner while it saves. */
function SaveButton({ dirty, saving, off, onPress, title, busyLabel = i18n.t("common.saving") }: { dirty: boolean; saving: boolean; off: boolean; onPress: () => void; title: string; busyLabel?: string }) {
  return <PillButton small variant="primary" title={saving ? busyLabel : title} busy={saving} disabled={off || !dirty} onPress={onPress} />;
}

/** The built-in templates as a grid; the picked one replaces the video's template (a background job). */
function TemplatePickerModal({ templates, current, portrait, onPick, onClose }: { templates: VideoTemplate[]; current: string; portrait: boolean; onPick: (id: string) => Promise<unknown>; onClose: () => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // In a box of its own, as the new-video wizard's: about 4.3 rows show (at most most of the screen, so the buttons
  // under it stay in view), the rest scrolls inside; it opens on the current one.
  const [row, setRow] = useState(0);
  const win = useWindowDimensions();
  const boxHeight = Math.min(row ? BOX_PAD * 2 + row * 4.3 + GAP * 4 : 540, win.height * 0.68);
  const box = useRef<ComponentRef<typeof ScrollView>>(null);
  const scrolled = useRef(false);
  const go = async () => {
    if (!picked) return;
    setBusy(true);
    await onPick(picked);
    setBusy(false);
    onClose();
  };
  return (
    <Sheet visible title={i18n.t("videoSettings.changeTemplate")} onClose={busy ? () => undefined : onClose}>
      <Text style={vstyles.muted}>{i18n.t("videoSettings.templateHint")}</Text>
      <ScrollView
        ref={box}
        style={[styles.box, { height: boxHeight }]}
        contentContainerStyle={styles.boxBody}
        nestedScrollEnabled
        showsVerticalScrollIndicator>
        <View style={styles.templates} accessibilityRole="radiogroup">
          {templates.map((t, i) => {
            const isCurrent = t.id === current;
            const on = picked === t.id;
            return (
              <Pressable
                key={t.id}
                onLayout={(e) => {
                  const { y, height } = e.nativeEvent.layout;
                  if (i === 0 && height !== row) setRow(height);
                  if (isCurrent && !scrolled.current) {
                    scrolled.current = true;
                    box.current?.scrollTo({ y: Math.max(0, y - BOX_PAD), animated: false });
                  }
                }}
                onPress={() => setPicked(t.id)}
                disabled={isCurrent || busy}
                accessibilityRole="radio"
                accessibilityState={{ checked: on, disabled: isCurrent }}
                style={[styles.template, on && styles.templateOn, isCurrent && styles.templateCurrent]}>
                <TemplateThumb template={t} portrait={portrait} />
                {isCurrent ? <Text style={styles.badge}>CURRENT</Text> : null}
                <Text style={styles.templateName} numberOfLines={1}>
                  {t.name}
                </Text>
                {on ? (
                  <View style={styles.check}>
                    <CheckIcon size={13} color={colors.white} />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      <View style={vstyles.end}>
        <Text style={[vstyles.muted, vstyles.small, styles.grow]}>{i18n.t("videoSettings.usesVideo")}</Text>
        <PillButton small title={i18n.t("common.cancel")} disabled={busy} onPress={onClose} />
        <PillButton small variant="primary" title={busy ? i18n.t("common.starting") : i18n.t("videoSettings.changeTemplate")} busy={busy} disabled={!picked} onPress={() => void go()} />
      </View>
    </Sheet>
  );
}

function Card({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <View style={styles.setCard}>
      <Text style={vstyles.h3}>{title}</Text>
      <Text style={[vstyles.muted, vstyles.small]}>{note}</Text>
      <View style={vstyles.card}>{children}</View>
    </View>
  );
}

/**
 * Settings, laid out like blog2video's (web: LookPanel): each card saves on its own. Colours, fonts, speed and
 * captions are a project update; template, voice and language are background jobs.
 */
export function LookPanel(p: PanelProps & { catalog: VideoCatalog | null }) {
  const pr = p.project;
  const off = p.disabled;
  const draftsOf = () => ({
    colors: { accent_color: pr.accent_color, text_color: pr.text_color, bg_color: pr.bg_color },
    font: pr.font_family || DEFAULT_FONT,
    speed: pr.playback_speed ?? 1,
    captions: {
      captions_enabled: !!pr.captions_enabled,
      caption_offset: Number(pr.caption_offset ?? 0),
      caption_font_size: Number(pr.caption_font_size) || 36,
      caption_font_family: pr.caption_font_family || "inter",
    },
    voiceId: pr.voice_gender === "none" ? NO_VOICE : (pr.custom_voice_id ?? ""),
  });
  // Drafts, reset whenever the project reloads after a save.
  const [drafts, setDrafts] = useState(draftsOf);
  const [seen, setSeen] = useState(pr);
  if (seen !== pr) {
    setSeen(pr);
    setDrafts(draftsOf());
  }
  const { colors: col, font, speed, captions, voiceId } = drafts;
  const set = (patch: Partial<typeof drafts>) => setDrafts((d) => ({ ...d, ...patch }));
  const [picking, setPicking] = useState(false);
  const [deletingVoice, setDeletingVoice] = useState(false);
  const [language, setLanguage] = useState("");
  const [voices, setVoices] = useState<VideoSavedVoice[]>([]);
  const { playing, play } = useVoicePlayer();
  // The card being saved. Project updates clear it when act returns; template, voice and language are jobs, cleared
  // when the editor unlocks after the job.
  const [saving, setSaving] = useState<SaveKey | null>(null);
  const [jobSaving, setJobSaving] = useState(false);
  if (jobSaving && !off) {
    setJobSaving(false);
    setSaving(null);
  }

  useEffect(() => {
    // Every saved voice, the workspace's own included.
    videoVoicesApi
      .list()
      .then((v) => setVoices(v.saved))
      .catch(() => undefined);
  }, []);

  async function save(key: SaveKey, fn: () => Promise<unknown>) {
    setSaving(key);
    await p.act(fn);
    setSaving(null);
  }
  /** A background job: the button keeps loading until the job ends (the editor is locked meanwhile). */
  async function job(key: SaveKey, run: () => Promise<unknown>) {
    setSaving(key);
    await run();
    setJobSaving(true);
  }

  const templates = [...(p.catalog?.my_templates ?? []), ...(p.catalog?.templates ?? [])];
  const current = templates.find((t) => t.id === pr.template);
  // Only blog2video's built-in templates can be switched to (no custom ones).
  const builtIn = (p.catalog?.templates ?? []).filter((t) => !t.custom);
  const languages = p.catalog?.languages ?? [];
  const currentLanguage = languages.find((l) => l.code === pr.content_language)?.name ?? "Auto-detected";
  const currentVoice = voices.find((v) => v.voice_id === pr.custom_voice_id);
  const chosenVoice = voices.find((v) => v.voice_id === voiceId);
  const voiceChanged = voiceId !== (pr.voice_gender === "none" ? NO_VOICE : (pr.custom_voice_id ?? ""));
  const same = (a?: string | null, b?: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  const colorsChanged = !same(col.accent_color, pr.accent_color) || !same(col.text_color, pr.text_color) || !same(col.bg_color, pr.bg_color);
  const fontChanged = font !== (pr.font_family || DEFAULT_FONT);
  const captionsChanged =
    captions.captions_enabled !== !!pr.captions_enabled ||
    captions.caption_offset !== Number(pr.caption_offset ?? 0) ||
    captions.caption_font_size !== (Number(pr.caption_font_size) || 36) ||
    captions.caption_font_family !== (pr.caption_font_family || "inter");
  const speedChanged = Math.abs(speed - (pr.playback_speed ?? 1)) > 0.001;
  const fontOptions = FONTS.map((f) => ({ value: f.id, label: f.name }));

  function changeVoice() {
    const body =
      voiceId === NO_VOICE
        ? { voice_gender: "none" }
        : {
            voice_gender: chosenVoice?.gender === "male" ? "male" : "female",
            voice_accent: chosenVoice?.accent === "british" ? "british" : "american",
            custom_voice_id: voiceId,
          };
    void job("voice", () => p.startJob("Changing the voice", () => videoEditApi.changeVoice(p.id, body), () => videoEditApi.voiceStatus(p.id)));
  }
  const changeTemplate = (template: string) => job("template", () => p.startJob("Switching template", () => videoEditApi.changeTemplate(p.id, template), () => videoEditApi.templateStatus(p.id)));

  return (
    <View style={styles.settings}>
      <Card title={i18n.t("videoSettings.colorsFont")} note={i18n.t("videoSettings.colorsNote")}>
        <View style={styles.colors}>
          {(
            [
              ["accent_color", i18n.t("videoSettings.accent"), i18n.t("videoSettings.accentHint")],
              ["text_color", i18n.t("videoSettings.text"), i18n.t("videoSettings.textHint")],
              ["bg_color", i18n.t("videoSettings.background"), i18n.t("videoSettings.backgroundHint")],
            ] as const
          ).map(([k, label, hint]) => (
            <View key={k} style={styles.colorRow}>
              <ColorField label={label} value={col[k] || "#000000"} onChange={(c) => set({ colors: { ...col, [k]: c } })} />
              <Text style={[vstyles.muted, vstyles.small]}>{hint}</Text>
            </View>
          ))}
        </View>
        <View style={vstyles.end}>
          <SaveButton title={i18n.t("videoSettings.saveColors")} dirty={colorsChanged} saving={saving === "colors"} off={off} onPress={() => void save("colors", () => videoEditApi.updateProject(p.id, col))} />
        </View>
        <View style={styles.rule} />
        <View style={styles.field}>
          <Label>{i18n.t("videoSettings.fontFamily")}</Label>
          <Select label={i18n.t("videoSettings.fontFamily")} value={font} onChange={(v) => set({ font: v })} options={[{ value: DEFAULT_FONT, label: i18n.t("videoSettings.defaultFont") }, ...fontOptions]} />
        </View>
        <View style={vstyles.end}>
          <SaveButton title={i18n.t("videoSettings.saveFont")} dirty={fontChanged} saving={saving === "font"} off={off} onPress={() => void save("font", () => videoEditApi.updateProject(p.id, { font_family: font === DEFAULT_FONT ? null : font }))} />
        </View>
      </Card>

      <Card title={i18n.t("videoSettings.projectTemplate")} note={i18n.t("videoSettings.templateNote")}>
        <View style={styles.templateNow}>
          {current ? (
            <View style={styles.nowThumb}>
              <TemplateThumb template={current} portrait={pr.aspect_ratio === "portrait"} />
              <View style={styles.check}>
                <CheckIcon size={13} color={colors.white} />
              </View>
            </View>
          ) : null}
          <View style={styles.grow}>
            <Label>{i18n.t("videoSettings.currentTemplate")}</Label>
            <Text style={vstyles.strong}>{current?.name ?? pr.template}</Text>
            {current?.description ? (
              <Text style={[vstyles.muted, vstyles.small]} numberOfLines={3}>
                {current.description}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={vstyles.end}>
          <SaveButton title={i18n.t("videoSettings.changeTemplate")} busyLabel={i18n.t("videoSettings.changing")} dirty={builtIn.length > 0} saving={saving === "template"} off={off} onPress={() => setPicking(true)} />
        </View>
      </Card>

      <Card title={i18n.t("videoSettings.captionsSpeed")} note={i18n.t("videoSettings.captionsNote")}>
        <View style={styles.field}>
          <Text style={vstyles.strong}>{i18n.t("videoSettings.captions")}</Text>
          <Text style={[vstyles.muted, vstyles.small]}>{i18n.t("videoSettings.captionsHint")}</Text>
        </View>
        <View style={vstyles.row}>
          <Switch
            value={captions.captions_enabled}
            onValueChange={(v) => set({ captions: { ...captions, captions_enabled: v } })}
            trackColor={{ true: colors.blue, false: colors.surface2 }}
            accessibilityLabel={i18n.t("videoSettings.enableCaptions")}
          />
          <Text style={vstyles.body}>{i18n.t("videoSettings.enableCaptions")}</Text>
        </View>
        <View style={[styles.field, !captions.captions_enabled && styles.dim]} pointerEvents={captions.captions_enabled ? "auto" : "none"}>
          <View style={vstyles.between}>
            <Label>{i18n.t("videoSettings.offset")}</Label>
            <Text style={styles.value}>{captions.caption_offset === 0 ? "Default" : captions.caption_offset}</Text>
          </View>
          <Slider value={captions.caption_offset} min={-100} max={100} onChange={(v) => set({ captions: { ...captions, caption_offset: v } })} label={i18n.t("videoSettings.captionOffset")} />
          <View style={vstyles.between}>
            <Text style={[vstyles.muted, vstyles.small]}>{i18n.t("videoSettings.down")}</Text>
            <Text style={[vstyles.muted, vstyles.small]}>{i18n.t("videoSettings.up")}</Text>
          </View>
          <View style={vstyles.between}>
            <Label>{i18n.t("videoSettings.size")}</Label>
            <Text style={styles.value}>{captions.caption_font_size}px</Text>
          </View>
          <Slider value={captions.caption_font_size} min={12} max={64} onChange={(v) => set({ captions: { ...captions, caption_font_size: v } })} label={i18n.t("videoSettings.captionSize")} />
          <View style={vstyles.between}>
            <Text style={[vstyles.muted, vstyles.small]}>12</Text>
            <Text style={[vstyles.muted, vstyles.small]}>64px</Text>
          </View>
          <Label>{i18n.t("videoSettings.font")}</Label>
          <Select label={i18n.t("videoSettings.captionFont")} value={captions.caption_font_family} onChange={(v) => set({ captions: { ...captions, caption_font_family: v } })} options={fontOptions} />
        </View>
        <View style={vstyles.end}>
          <SaveButton title={i18n.t("videoSettings.saveCaptions")} dirty={captionsChanged} saving={saving === "captions"} off={off} onPress={() => void save("captions", () => videoEditApi.updateProject(p.id, captions))} />
        </View>
        <View style={styles.rule} />
        <View style={styles.field}>
          <Text style={vstyles.strong}>{i18n.t("videoSettings.speed")}</Text>
          <Text style={[vstyles.muted, vstyles.small]}>{i18n.t("videoSettings.speedHint")}</Text>
        </View>
        <View style={vstyles.row}>
          {SPEEDS.map((v) => (
            <Pressable key={v} onPress={() => set({ speed: v })} accessibilityRole="button" accessibilityState={{ selected: speed === v }} style={[styles.chip, speed === v && styles.chipOn]}>
              <Text style={[styles.chipText, speed === v && styles.chipTextOn]}>{v}×</Text>
            </Pressable>
          ))}
        </View>
        <View style={vstyles.between}>
          <Text style={vstyles.body}>{i18n.t("videoSettings.customSpeed")}</Text>
          <Text style={styles.value}>{speed.toFixed(2)}x</Text>
        </View>
        <Slider value={speed} min={0.5} max={2.5} step={0.05} onChange={(v) => set({ speed: Math.round(v * 100) / 100 })} label={i18n.t("videoSettings.speed")} />
        <View style={vstyles.end}>
          <SaveButton title={i18n.t("videoSettings.saveSpeed")} dirty={speedChanged} saving={saving === "speed"} off={off} onPress={() => void save("speed", () => videoEditApi.updateProject(p.id, { playback_speed: speed }))} />
        </View>
      </Card>

      <Card title={i18n.t("videoSettings.voiceLanguage")} note={i18n.t("videoSettings.voiceLanguageNote")}>
        <View style={styles.field}>
          <Text style={vstyles.strong}>{i18n.t("videoSettings.voice")}</Text>
          <Text style={[vstyles.muted, vstyles.small]}>{i18n.t("videoSettings.voiceHint")}</Text>
        </View>
        <View style={styles.voiceNow}>
          <Pressable
            onPress={() => currentVoice && play(currentVoice.voice_id, currentVoice.preview_url)}
            disabled={!currentVoice?.preview_url}
            accessibilityRole="button"
            accessibilityLabel={playing === currentVoice?.voice_id ? i18n.t("videoSettings.stopNamed", { name: currentVoice?.name }) : i18n.t("videoSettings.playNamed", { name: currentVoice?.name ?? i18n.t("videoSettings.voiceWord") })}
            style={[styles.play, !currentVoice?.preview_url && styles.dim]}>
            {playing === currentVoice?.voice_id ? <View style={styles.stop} /> : <View style={styles.tri} />}
          </Pressable>
          <View style={styles.grow}>
            <Text style={vstyles.strong}>{pr.voice_gender === "none" ? i18n.t("videoSettings.noVoiceover") : (currentVoice?.name ?? i18n.t("videoSettings.currentVoice"))}</Text>
            {currentVoice ? <Text style={[vstyles.muted, vstyles.small]}>{[cap(currentVoice.gender), cap(currentVoice.accent)].filter(Boolean).join(" • ")}</Text> : null}
          </View>
        </View>
        <Select
          label={i18n.t("videoSettings.voice")}
          value={voiceId || NO_VOICE}
          onChange={(v) => set({ voiceId: v })}
          options={[
            { value: NO_VOICE, label: i18n.t("videoSettings.noVoiceover") },
            ...voices.map((v) => ({ value: v.voice_id, label: v.name, hint: [cap(v.gender), cap(v.accent)].filter(Boolean).join(" • ") || undefined })),
          ]}
        />
        <View style={vstyles.row}>
          <PillButton small variant="danger" title={i18n.t("videoSettings.deleteVoiceover")} disabled={off || pr.voice_gender === "none"} onPress={() => setDeletingVoice(true)} />
          <SaveButton title={i18n.t("videoSettings.changeVoice")} busyLabel={i18n.t("videoSettings.changing")} dirty={voiceChanged} saving={saving === "voice"} off={off} onPress={changeVoice} />
        </View>
        <Text style={[vstyles.muted, vstyles.small]}>{i18n.t("videoSettings.voiceCredit")}</Text>
        <View style={styles.rule} />
        <View style={styles.field}>
          <Text style={vstyles.strong}>{i18n.t("videoSettings.language")}</Text>
          <Text style={[vstyles.muted, vstyles.small]}>{i18n.t("videoSettings.languageHint")}</Text>
        </View>
        <View style={styles.field}>
          <Text style={[vstyles.muted, vstyles.small]}>{i18n.t("videoSettings.currentLanguage")}</Text>
          <Text style={styles.langNow}>{currentLanguage}</Text>
        </View>
        <View style={styles.field}>
          <Text style={[vstyles.muted, vstyles.small]}>{i18n.t("videoSettings.translateTo")}</Text>
          <Select
            label={i18n.t("videoSettings.translateTo")}
            value={language}
            onChange={setLanguage}
            options={[{ value: "", label: i18n.t("videoSettings.selectLanguage") }, ...languages.filter((l) => l.code !== pr.content_language).map((l) => ({ value: l.code, label: tKey(`options.languages.${l.name}`, l.name) }))]}
          />
        </View>
        <View style={vstyles.row}>
          <SaveButton
            title={i18n.t("videoSettings.changeLanguage")}
            busyLabel={i18n.t("videoSettings.changing")}
            dirty={!!language}
            saving={saving === "language"}
            off={off}
            onPress={() => void job("language", () => p.startJob("Translating", () => videoEditApi.changeLanguage(p.id, language), () => videoEditApi.languageStatus(p.id)).then(() => setLanguage("")))}
          />
        </View>
        <Text style={[vstyles.muted, vstyles.small]}>{i18n.t("videoSettings.newVideoCredit")}</Text>
      </Card>

      {deletingVoice ? (
        <ConfirmModal
          title={i18n.t("videoSettings.deleteVoiceTitle")}
          body={i18n.t("videoSettings.deleteVoiceBody")}
          confirm={i18n.t("videoSettings.deleteVoiceover")}
          busyLabel={i18n.t("common.starting")}
          failedText={i18n.t("videoSettings.deleteVoiceFailed")}
          run={async () => {
            await job("voice", () => p.startJob("Deleting the voiceover", () => videoEditApi.deleteVoiceover(p.id), () => videoEditApi.voiceStatus(p.id)));
            return true;
          }}
          onClose={() => setDeletingVoice(false)}
        />
      ) : null}
      {picking ? <TemplatePickerModal templates={builtIn} current={pr.template} portrait={pr.aspect_ratio === "portrait"} onPick={changeTemplate} onClose={() => setPicking(false)} /> : null}
    </View>
  );
}

/** The template box's padding and the gap between its rows (its height is worked out from them). */
const BOX_PAD = 8;
const GAP = 10;

const styles = StyleSheet.create({
  settings: { gap: 20 },
  setCard: { gap: 6 },
  grow: { flex: 1 },
  dim: { opacity: 0.4 },
  field: { gap: 6 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: 4 },
  colors: { gap: 10 },
  colorRow: { gap: 4 },
  value: { color: colors.text2, fontFamily: fonts.mono, fontSize: 12.5 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  chipOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  chipText: { color: colors.text2, fontSize: 13.5 },
  chipTextOn: { color: colors.white, fontWeight: "600" },
  templateNow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  nowThumb: { width: 120, borderRadius: radius.sm, overflow: "hidden" },
  box: { flexGrow: 0, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(255, 255, 255, 0.02)" },
  boxBody: { padding: BOX_PAD },
  templates: { flexDirection: "row", flexWrap: "wrap", gap: GAP },
  template: { width: "47%", gap: 6, padding: 6, borderRadius: radius.sm + 2, borderWidth: 2, borderColor: colors.line },
  templateOn: { borderColor: colors.blue },
  templateCurrent: { opacity: 0.6 },
  templateName: { color: colors.text, fontSize: 13.5, fontWeight: "600" },
  badge: { position: "absolute", left: 10, top: 10, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: "hidden", backgroundColor: "rgba(0,0,0,0.75)", color: colors.white, fontFamily: fonts.mono, fontSize: 10 },
  check: { position: "absolute", right: 8, top: 8, width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: colors.blue },
  voiceNow: { flexDirection: "row", alignItems: "center", gap: 12 },
  play: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.blue },
  tri: { width: 0, height: 0, marginLeft: 3, borderTopWidth: 7, borderBottomWidth: 7, borderLeftWidth: 11, borderTopColor: "transparent", borderBottomColor: "transparent", borderLeftColor: colors.white },
  stop: { width: 11, height: 11, borderRadius: 2, backgroundColor: colors.white },
  langNow: { color: colors.text, fontSize: 15, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
});

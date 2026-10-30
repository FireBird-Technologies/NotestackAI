import { type LayoutInfo, videoEditApi } from "@notestack/shared/endpoints";
import { type FieldDef, isHiddenProp, keyLabel, layoutFieldDefs } from "@notestack/shared/layoutFields";
import { baseLayout, FONT, type FontDefaults, layoutName, MANAGED_PROPS, parseCode, propsOf, withLayout, withProps, wordsAndSeconds } from "@notestack/shared/sceneCode";
import type { VideoScene } from "@notestack/shared/types";
import { useState } from "react";
import { StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { Select } from "@/create/fields";
import { ChevronIcon } from "@/ui/icons";
import { colors, fonts, radius } from "@/ui/theme";
import { PillButton, Sheet } from "@/ui/widgets";

import { LayoutFields } from "./layout-fields";
import { errorMessage } from "./scene-media";
import { Label, Slider, Spinner, vstyles } from "./ui";

const KEEP = "__keep__"; // blog2video's "keep the current layout"
const AUTO = "__auto__"; // ours for "let AI choose": the layout is left out of the request

type Mode = "ai" | "manual";

/**
 * Edit one scene, as on blog2video (web: SceneEditModal): AI-assisted (narration, AI rewrite, re-record the voiceover,
 * scene style and layout) or manual (title, display text, extra hold, and the layout's own content fields).
 */
export function SceneEditModal({ id, scene, index, template, aiEditsLeft, layoutInfo, layoutNames, onClose, onSaved }: {
  id: string;
  scene: VideoScene;
  index: number;
  template: string;
  aiEditsLeft: number | null;
  layoutInfo: LayoutInfo | null;
  layoutNames: Record<string, string> | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const props = propsOf(parseCode(scene), template);
  const [mode, setMode] = useState<Mode>("ai");
  const [narration, setNarration] = useState(scene.narration_text);
  const [instruction, setInstruction] = useState("");
  const [askAi, setAskAi] = useState(false);
  const [rerecord, setRerecord] = useState(false);
  const [verbatim, setVerbatim] = useState(true);
  // Scene layout: KEEP, AUTO or a layout id (a sibling variant of the current one is a Scene style switch).
  const current = scene.layout ?? "";
  const [layout, setLayout] = useState<string>(KEEP);
  const [title, setTitle] = useState(scene.title);
  const [display, setDisplay] = useState(scene.display_text ?? "");
  const [hold, setHold] = useState(Number(scene.extra_hold_seconds ?? 0));
  // The fields the template declares for this layout, minus what is edited elsewhere; a layout that declares none
  // falls back to its plain text and number props.
  const declared = layoutFieldDefs(layoutInfo?.layout_prop_schema, scene.layout);
  const fields: FieldDef[] = declared.fields.length
    ? declared.fields
    : Object.entries(props)
        .filter(([k, v]) => !MANAGED_PROPS.has(k) && !isHiddenProp(k) && (typeof v === "string" || typeof v === "number"))
        .map(([k, v]) => ({ key: k, label: keyLabel(k), type: typeof v === "number" ? "number" : "string" }));
  const [content, setContent] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.key, props[f.key]])));
  const contentChanges = Object.fromEntries(fields.filter((f) => JSON.stringify(content[f.key] ?? null) !== JSON.stringify(props[f.key] ?? null)).map((f) => [f.key, content[f.key]]));
  const [open, setOpen] = useState({ settings: true, props: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const narrationChanged = narration !== scene.narration_text;
  const variants = layoutInfo?.layout_variants?.[baseLayout(current)] ?? [];
  const layoutChanged = layout !== KEEP && layout !== current;
  // Same family, other style: a plain descriptor update (no AI, text and images kept), unlike a new layout.
  const styleSwitch = layoutChanged && layout !== AUTO && baseLayout(layout) === baseLayout(current);
  const asked = askAi && instruction.trim().length > 0;
  const needsRegen = rerecord || asked || (layoutChanged && !styleSwitch);
  const aiChanged = narrationChanged || needsRegen || styleSwitch;
  const manualChanged = title !== scene.title || display !== (scene.display_text ?? "") || hold !== Number(scene.extra_hold_seconds ?? 0) || Object.keys(contentChanges).length > 0;

  /** Editing the narration turns re-recording on (as on blog2video): the old audio no longer matches the text. */
  function editNarration(text: string) {
    setNarration(text);
    if (text !== scene.narration_text) setRerecord(true);
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      if (mode === "ai") {
        // As blog2video's own editor: the edited narration first, then (if needed) one regenerate.
        if (narrationChanged) await videoEditApi.updateScene(id, scene.id, { narration_text: narration });
        if (needsRegen) {
          await videoEditApi.regenerateScene(id, scene.id, {
            description: asked ? instruction.trim() : undefined,
            narration_text: narration,
            regenerate_voiceover: rerecord,
            voiceover_verbatim: verbatim,
            // KEEP must be sent: left out, blog2video lets AI pick a new layout for the scene.
            layout: layout === AUTO ? undefined : layoutChanged ? layout : KEEP,
          });
        } else if (styleSwitch) {
          await videoEditApi.updateScene(id, scene.id, { remotion_code: withLayout(scene, layout) });
        }
      } else {
        // Only the fields that changed: font sizes and media props stay as saved.
        const remotion_code = withProps(scene, template, { ...contentChanges });
        await videoEditApi.updateScene(id, scene.id, { title, display_text: display, extra_hold_seconds: hold, remotion_code });
      }
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Sheet visible title={`Edit Scene ${index + 1}`} onClose={busy ? () => undefined : onClose}>
      <View style={styles.gap6}>
        <Label>Editing mode</Label>
        <Text style={[vstyles.muted, vstyles.small]}>
          Pick a tab: use <Text style={vstyles.strong}>AI-Assisted</Text> to let AI change the scene for you, or <Text style={vstyles.strong}>Manual</Text> to edit it yourself.
        </Text>
        <View style={styles.seg} accessibilityRole="tablist">
          {(["ai", "manual"] as const).map((m) => (
            <Pressable key={m} onPress={() => setMode(m)} accessibilityRole="tab" accessibilityState={{ selected: mode === m }} style={[styles.segBtn, mode === m && styles.segOn]}>
              <Text style={[styles.segText, mode === m && styles.segTextOn]}>{m === "ai" ? "AI-Assisted editing" : "Manual editing"}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {mode === "ai" ? (
        <>
          {aiEditsLeft !== null ? (
            <Text style={[vstyles.body, vstyles.small]}>
              AI edits remaining: <Text style={vstyles.strong}>{aiEditsLeft}</Text>{" "}
              <Text style={vstyles.muted}>({needsRegen ? "this edit uses 1" : "a voiceover, rewrite or new layout uses 1"})</Text>
            </Text>
          ) : null}
          <View style={styles.gap6}>
            <View style={vstyles.between}>
              <Text style={vstyles.strong}>Scene narration</Text>
              <Text style={[vstyles.muted, vstyles.small]}>{wordsAndSeconds(narration)}</Text>
            </View>
            <Text style={[vstyles.muted, vstyles.small]}>This is what&apos;s spoken in the voiceover. Edit it directly, or use AI below.</Text>
            <TextInput style={[vstyles.input, styles.narration]} value={narration} onChangeText={editNarration} multiline maxLength={6000} />
            {narrationChanged ? <Text style={styles.note}>⚠ You changed the narration, so the voiceover will be re-recorded on save.</Text> : null}
          </View>
          {!askAi ? (
            <Pressable onPress={() => setAskAi(true)} accessibilityRole="button" style={styles.aiBtn}>
              <Text style={styles.aiBtnText}>✦ Rewrite this with AI</Text>
            </Pressable>
          ) : (
            <View style={styles.gap6}>
              <Label>What should change?</Label>
              <TextInput
                style={[vstyles.input, vstyles.area]}
                value={instruction}
                onChangeText={setInstruction}
                multiline
                maxLength={2000}
                autoFocus
                placeholder="e.g. Make it shorter and punchier, or explain it with a real-world example"
                placeholderTextColor={colors.text3}
              />
            </View>
          )}
          <View style={vstyles.card}>
            <View style={vstyles.between}>
              <View style={styles.grow}>
                <Text style={vstyles.strong}>Re-record the voiceover</Text>
                <Text style={[vstyles.muted, vstyles.small]}>Generate fresh audio for the new narration. Turn off to keep the current audio.</Text>
              </View>
              <Switch value={rerecord} onValueChange={setRerecord} trackColor={{ true: colors.blue, false: colors.surface2 }} accessibilityLabel="Re-record the voiceover" />
            </View>
            <View style={[styles.gap6, !rerecord && styles.dim]}>
              {(
                [
                  [true, "Use exact wording", "Speaks your narration word for word."],
                  [false, "Rephrase with AI", "AI lightly rephrases it to fit the rest of the video."],
                ] as const
              ).map(([v, label, hint]) => (
                <Pressable key={label} onPress={() => setVerbatim(v)} disabled={!rerecord} accessibilityRole="radio" accessibilityState={{ checked: verbatim === v }} style={styles.radio}>
                  <View style={[styles.dot, verbatim === v && styles.dotOn]}>{verbatim === v ? <View style={styles.dotIn} /> : null}</View>
                  <View style={styles.grow}>
                    <Text style={vstyles.strong}>{label}</Text>
                    <Text style={[vstyles.muted, vstyles.small]}>{hint}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
            <Text style={[vstyles.muted, vstyles.small]}>You can change the voice for the whole video in Settings.</Text>

            {variants.length > 1 ? (
              <View style={[styles.gap6, styles.rule]}>
                <Text style={vstyles.strong}>Scene style</Text>
                <Text style={[vstyles.muted, vstyles.small]}>Pick a different look for this scene. Your text and images stay as they are.</Text>
                <View style={vstyles.row} accessibilityRole="radiogroup">
                  {variants.map((v, i) => {
                    const on = (layout === KEEP || layout === AUTO ? current : layout) === v;
                    return (
                      <Pressable key={v} onPress={() => setLayout(v === current ? KEEP : v)} accessibilityRole="radio" accessibilityState={{ checked: on }} style={[styles.chip, on && styles.chipOn]}>
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>{layoutInfo?.layout_variant_labels?.[v] ?? `Style ${i + 1}`}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}

            <View style={[styles.gap6, styles.rule]}>
              <Text style={vstyles.strong}>Scene layout</Text>
              <Text style={[vstyles.muted, vstyles.small]}>Keep the current layout, pick one, or let AI decide. A new layout uses 1 AI edit.</Text>
              <Select<string>
                label="Scene layout"
                value={layout}
                onChange={setLayout}
                options={[
                  { value: KEEP, label: `${layoutName(current, layoutNames)} (current)` },
                  { value: AUTO, label: "Auto (let AI choose)" },
                  ...(layoutInfo?.layouts ?? []).filter((l) => l !== current).map((l) => ({ value: l, label: layoutName(l, layoutNames) })),
                ]}
              />
            </View>
          </View>
        </>
      ) : (
        <>
          <View style={vstyles.card}>
            <Collapse label="Scene Settings" open={open.settings} onPress={() => setOpen({ ...open, settings: !open.settings })} />
            {open.settings ? (
              <View style={vstyles.stack}>
                <View style={styles.gap6}>
                  <Label>Title</Label>
                  <TextInput style={vstyles.input} value={title} onChangeText={setTitle} maxLength={255} />
                </View>
                <View style={styles.gap6}>
                  <Label>Display text</Label>
                  <TextInput style={[vstyles.input, vstyles.area]} value={display} onChangeText={setDisplay} multiline maxLength={3000} />
                </View>
                <View style={styles.gap6}>
                  <View style={vstyles.between}>
                    <Label>Extra hold (seconds)</Label>
                    <Text style={styles.value}>{hold.toFixed(1)}s</Text>
                  </View>
                  <Slider value={hold} min={0} max={30} step={0.5} onChange={setHold} label="Extra hold in seconds" />
                  <Text style={[vstyles.muted, vstyles.small]}>Add seconds after the voiceover ends so animations can finish before the next scene.</Text>
                </View>
              </View>
            ) : null}
          </View>
          <View style={vstyles.card}>
            <Collapse label="Scene Props" open={open.props} onPress={() => setOpen({ ...open, props: !open.props })} />
            {open.props ? (
              <View style={vstyles.stack}>
                <Label>Layout content</Label>
                {fields.length === 0 ? (
                  <Text style={[vstyles.muted, vstyles.small]}>This layout has no content fields to edit.</Text>
                ) : (
                  <LayoutFields fields={fields} value={content} onChange={(k, v) => setContent((c) => ({ ...c, [k]: v }))} />
                )}
                {declared.hasTables ? <Text style={[vstyles.muted, vstyles.small]}>Chart and table data are edited by regenerating the scene in the AI tab.</Text> : null}
              </View>
            ) : null}
          </View>
        </>
      )}

      {error ? <Text style={vstyles.error}>{error}</Text> : null}
      <View style={vstyles.end}>
        <PillButton small title="Cancel" disabled={busy} onPress={onClose} />
        <PillButton small variant="primary" title={busy ? "Saving..." : "Save changes"} busy={busy} disabled={!(mode === "ai" ? aiChanged : manualChanged)} onPress={() => void save()} />
      </View>
    </Sheet>
  );
}

function Collapse({ label, open, onPress }: { label: string; open: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ expanded: open }} style={vstyles.between}>
      <Text style={vstyles.h3}>{label}</Text>
      <View style={open && styles.flip}>
        <ChevronIcon size={16} />
      </View>
    </Pressable>
  );
}

/** A scene's font sizes: the stored value, or the template's default for the scene's layout when none is stored. */
export function FontSliders({ title, desc, defaults, saving, onTitle, onDesc, onDone }: {
  title: number | null;
  desc: number | null;
  defaults: FontDefaults;
  /** Sizes being saved right now (autosave in the scene row): a spinner shows by their value until applied. */
  saving?: { title: boolean; desc: boolean };
  onTitle: (v: number) => void;
  onDesc: (v: number) => void;
  /** A slider was let go: the moment to save. */
  onDone?: (kind: "title" | "desc", v: number) => void;
}) {
  const rows = [
    ["Title font size", "title", title, FONT.title, defaults.title, onTitle, !!saving?.title],
    ["Display text font size", "desc", desc, FONT.desc, defaults.desc, onDesc, !!saving?.desc],
  ] as const;
  return (
    <View style={styles.gap6}>
      <Label>
        Typography <Text style={styles.optional}>(optional)</Text>
      </Label>
      {rows.map(([label, kind, value, range, fallback, set, busy]) => (
        <View key={label} style={styles.fontRow}>
          <View style={vstyles.between}>
            <Text style={[vstyles.body, vstyles.small]}>{label}</Text>
            <View style={vstyles.row}>
              {busy ? <Spinner /> : null}
              <Text style={styles.value}>{value ?? fallback}</Text>
            </View>
          </View>
          <Slider value={value ?? fallback} min={range.min} max={range.max} onChange={set} onDone={onDone && ((v) => onDone(kind, v))} label={label} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  gap6: { gap: 6 },
  grow: { flex: 1 },
  dim: { opacity: 0.45 },
  flip: { transform: [{ rotate: "180deg" }] },
  seg: { flexDirection: "row", padding: 4, gap: 4, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  segBtn: { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 999 },
  segOn: { backgroundColor: colors.blue },
  segText: { color: colors.text2, fontSize: 13.5, fontWeight: "600" },
  segTextOn: { color: colors.white },
  narration: { minHeight: 130, textAlignVertical: "top" },
  note: { color: "#f5c46b", fontSize: 13, lineHeight: 18 },
  aiBtn: { alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: "rgba(33, 124, 255, 0.5)", backgroundColor: colors.blue10 },
  aiBtnText: { color: colors.blue, fontSize: 14, fontWeight: "600" },
  radio: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 10, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line },
  dot: { width: 18, height: 18, borderRadius: 9, marginTop: 2, borderWidth: 1.5, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" },
  dotOn: { borderColor: colors.blue },
  dotIn: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.blue },
  rule: { paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  chipOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  chipText: { color: colors.text2, fontSize: 13.5 },
  chipTextOn: { color: colors.white, fontWeight: "600" },
  value: { color: colors.blue, fontFamily: fonts.mono, fontSize: 13 },
  fontRow: { gap: 2 },
  optional: { color: colors.text3, textTransform: "none", letterSpacing: 0 },
});

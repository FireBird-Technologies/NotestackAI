import { docsApi, notebooksApi, videosApi } from "@notestack/shared/endpoints";
import { VIDEO_DEFAULTS } from "@notestack/shared/notebook";
import type {
  Artifact,
  Notebook,
  VideoCreateBody,
  VideoFocusSource,
  VideoFocusTopic,
  VideoOptions,
  VideoSavedVoice,
  VideoStyleItem,
  VideoTemplate,
} from "@notestack/shared/types";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { type ComponentRef, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { Pressable } from "@/ui/pressable";

import { useVoicePlayer, voicePreviewUrl } from "@/lib/audio";
import { createStyles, CustomTopic, FocusCards, Foot, Hint, Label, Select } from "@/create/fields";
import { voicesQuery } from "@/create/media";
import { colors, fonts, radius } from "@/ui/theme";
import { ErrorText, formatDate, Loading } from "@/ui";
import { useUpgrade } from "@/account/upgrade";
import { pageStyles, PillButton } from "@/ui/widgets";

type Source = { kind: "notebook"; id: string } | { kind: "post"; id: string };
const ONE_POST = "__post";
const cap = (s?: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "");

/** A template's own colours, or the fallbacks (web: VideoCreate templateFields). */
const templateFields = (t: VideoTemplate) => ({
  template: t.id,
  accent_color: t.preview_colors?.accent ?? VIDEO_DEFAULTS.accent_color,
  bg_color: t.preview_colors?.bg ?? VIDEO_DEFAULTS.bg_color,
  text_color: t.preview_colors?.text ?? VIDEO_DEFAULTS.text_color,
});

function Steps({ step }: { step: number }) {
  const names = ["Project", "Template", "Voice"];
  return (
    <View style={styles.steps} accessibilityLabel={`Step ${step} of 3: ${names[step - 1]}`}>
      {names.map((name, i) => {
        const done = i + 1 < step;
        const on = i + 1 === step;
        return (
          <View key={name} style={styles.stepWrap}>
            {i > 0 ? <View style={[styles.stepLine, (done || on) && styles.stepLineOn]} /> : null}
            <View style={[styles.step, done && styles.stepDone, on && styles.stepOn]}>
              {done ? (
                <SymbolView name={{ ios: "checkmark", android: "check" }} size={12} weight="bold" tintColor={colors.white} />
              ) : (
                <Text style={[styles.stepText, on && styles.stepTextOn]}>{i + 1}</Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/**
 * The three-step video wizard (web: VideoCreateForm in a modal): 1 what it is made from, its topic and style; 2 the
 * template and colours; 3 the language and voice. Generate hands the request to `onCreate`, which starts it.
 */
export function VideoDialog({ notebook, onCreate }: {
  /** Opened from a notebook: it starts from that notebook. On its own (Videos → New video): the whole archive. */
  notebook?: Notebook;
  /** Generate was pressed: the create request, on its way. The video's screen opens at once and waits for it. */
  onCreate: (created: Promise<Artifact>) => void;
}) {
  const config = useQuery({ queryKey: ["videos", "config"], queryFn: videosApi.config });
  const upgrade = useUpgrade();
  const quota = useQuery({ queryKey: ["videos", "quota"], queryFn: videosApi.quota });
  const catalog = useQuery({ queryKey: ["videos", "catalog"], queryFn: videosApi.catalog, enabled: Boolean(config.data?.configured) });
  const voices = useQuery({ ...voicesQuery, enabled: Boolean(config.data?.configured) });
  const notebooks = useQuery({ queryKey: ["notebooks"], queryFn: notebooksApi.list });
  const { playing, play } = useVoicePlayer();

  const [step, setStep] = useState(1);
  const [chosen, setSource] = useState<Source | null>(notebook ? { kind: "notebook", id: notebook.id } : null);
  // Opened on its own, the whole archive to start with, as the web does.
  const archive = notebooks.data?.find((n) => n.is_archive);
  const source: Source | null = chosen ?? (archive ? { kind: "notebook", id: archive.id } : null);
  const [choosingPost, setChoosingPost] = useState(false);
  const [topics, setTopics] = useState<{ key: string; list: VideoFocusTopic[] } | null>(null);
  const [focus, setFocus] = useState<VideoFocusTopic | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [limitHit, setLimitHit] = useState(false);
  const [form, setForm] = useState<VideoOptions>(VIDEO_DEFAULTS);
  const [templatePicked, setTemplatePicked] = useState(false);
  const [voicePicked, setVoicePicked] = useState(false);
  const set = (patch: Partial<VideoOptions>) => setForm((f) => ({ ...f, ...patch }));
  // The template and voice lists scroll in boxes of their own (as the web's), sized from a measured row: about 2.8
  // rows of templates and 4.5 voices show, the next one cut off so it reads as scrollable.
  const [templateRow, setTemplateRow] = useState(0);
  const [voiceRow, setVoiceRow] = useState(0);
  const templateBox = useRef<ComponentRef<typeof ScrollView>>(null);
  const scrolledTo = useRef(false);

  // The catalog's first pick: a random built-in template and the first house style, unless the user chose already.
  const [randomAt] = useState(() => Math.random());
  const templates = catalog.data?.templates ?? [];
  const defaultTemplate = templates[Math.floor(randomAt * templates.length)];
  const listed = catalog.data?.video_styles ?? [];
  const houseStyles = listed.some((s) => s.kind === "house");
  const styleList: VideoStyleItem[] = houseStyles ? listed : [{ id: "auto", name: "Auto", kind: "builtin" }, ...listed];
  const saved = voices.data?.saved ?? (voices.error ? [] : null);
  const builtIn = (saved ?? []).filter((v) => v.source !== "notestack");
  // What is sent: the user's picks, else the catalog's and the voices' first ones.
  const options: VideoOptions = {
    ...form,
    ...(!templatePicked && defaultTemplate ? templateFields(defaultTemplate) : {}),
    ...(houseStyles && !styleList.some((s) => s.id === form.video_style) ? { video_style: styleList[0].id } : {}),
    ...(!voicePicked && builtIn[0] && form.voice_gender !== "none"
      ? { custom_voice_id: builtIn[0].voice_id, voice_gender: builtIn[0].gender === "male" ? "male" : "female", voice_accent: builtIn[0].accent === "british" ? "british" : "american" }
      : {}),
  };

  const notebookCount = source?.kind === "notebook" ? (notebooks.data?.find((n) => n.id === source.id)?.document_count ?? null) : null;
  const wholeNotebook = source?.kind === "notebook";
  // Choosing a single post: nothing to focus on until one is picked (the notebook behind it no longer counts).
  const sourceReady = source?.kind === "post" || (wholeNotebook && !choosingPost && notebookCount !== 0);
  const sourceKey = !source ? "" : `${source.kind}:${source.id}`;
  const sourceFields = (): VideoFocusSource | null => (!source ? null : source.kind === "post" ? { document_id: source.id } : { notebook_id: source.id });

  // The focus suggestions belong to one source choice, asked for once it is complete.
  useEffect(() => {
    if (!sourceReady) return;
    const fields = sourceFields();
    if (!fields) return;
    const key = sourceKey;
    let live = true;
    const t = setTimeout(() => {
      videosApi
        .focusTopics(fields)
        .then((r) => live && setTopics({ key, list: r.topics }))
        .catch(() => live && setTopics({ key, list: [] }));
    }, 600);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, sourceReady]);
  const shownTopics = topics?.key === sourceKey ? topics.list : null;
  const topicChosen = !!focus || !!custom.trim();
  const left = quota.data ? Math.max(quota.data.limit - quota.data.used, 0) : null;

  const pickVoice = (v: VideoSavedVoice) => {
    setVoicePicked(true);
    set({ voice_gender: v.gender === "male" ? "male" : "female", voice_accent: v.accent === "british" ? "british" : "american", custom_voice_id: v.voice_id });
  };
  const playVoice = (v: VideoSavedVoice) => {
    if (v.source !== "notestack") return play(v.voice_id, v.preview_url);
    if (playing === v.voice_id) return play(v.voice_id, null);
    voicePreviewUrl(v.voice_id)
      .then((url) => play(v.voice_id, url))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not play the sample."));
  };

  const submit = async () => {
    setError("");
    if (left === 0) return setLimitHit(true);
    const from = sourceFields();
    if (!from) return;
    const o: VideoOptions = { ...options };
    if (o.voice_gender === "none") delete o.custom_voice_id;
    const focusFields: Pick<VideoCreateBody, "focus" | "focus_detail" | "focus_prompt"> = focus
      ? { focus: focus.title, focus_detail: focus.description }
      : custom.trim()
        ? { focus_prompt: custom.trim() }
        : {};
    const body: VideoCreateBody = { ...o, ...from, ...focusFields, notebook_id: source?.kind === "notebook" ? source.id : notebook?.id };
    // The video's screen opens now and waits for the server there (the limit, the service and other refusals show
    // on it); busy only guards against a second tap while this sheet goes away.
    setBusy(true);
    onCreate(videosApi.create(body));
  };

  if (config.error) return <ErrorText>{config.error.message}</ErrorText>;
  if (!config.data) return <Loading />;
  if (!config.data.configured) return <Text style={styles.notice}>Video is not set up on this server yet.</Text>;
  if (limitHit) {
    return (
      <View style={createStyles.stack}>
        <Text style={styles.limitTitle}>Video limit reached</Text>
        <Text style={pageStyles.body}>
          You have used all of the videos included in your current plan. Upgrade to a bigger plan to keep turning your posts and chats into videos.
        </Text>
        <PillButton title="Upgrade" variant="primary" onPress={() => upgrade()} />
      </View>
    );
  }

  const sourceOptions = [
    ...(notebooks.data ?? []).map((n) => ({ value: n.id, label: n.is_archive ? "My whole archive" : n.title, hint: `${n.document_count} posts` })),
    { value: ONE_POST, label: "Create a video on a single post" },
  ];
  const sourceValue = choosingPost || source?.kind === "post" ? ONE_POST : (source?.id ?? ONE_POST);
  const currentVoiceId = options.custom_voice_id;

  return (
    <View style={createStyles.stack}>
      {left !== null && quota.data ? (
        <Text style={styles.quota}>
          {left} of {quota.data.limit} video{quota.data.limit === 1 ? "" : "s"} left
        </Text>
      ) : null}
      <Steps step={step} />

      {step === 1 ? (
        <>
          <View style={createStyles.field}>
            <Label>Made from</Label>
            <Select
              label="Made from"
              value={sourceValue}
              options={sourceOptions}
              onChange={(v) => {
                if (v === ONE_POST) {
                  setChoosingPost(true);
                  setSource(null);
                } else {
                  setChoosingPost(false);
                  setSource({ kind: "notebook", id: v });
                }
                setFocus(null);
              }}
            />
            <Hint>Choose a notebook, your whole archive or a single post.</Hint>
          </View>
          {choosingPost || source?.kind === "post" ? (
            <PostPicker selected={source?.kind === "post" ? source.id : null} onPick={(id) => setSource({ kind: "post", id })} />
          ) : null}
          {wholeNotebook && notebookCount === 0 ? <Hint>This notebook has no posts yet. Add some, or pick another notebook.</Hint> : null}

          {sourceReady ? (
            <View style={createStyles.field}>
              <Label>{wholeNotebook ? "What should the video be about?" : "What should the video focus on?"}</Label>
              {/* Your own topic first, the suggestions under it: the same for a notebook and a single post */}
              <CustomTopic
                title={wholeNotebook ? "Your topic" : undefined}
                rows={2}
                value={custom}
                onChange={(t) => {
                  setCustom(t);
                  setFocus(null);
                }}
                onFocus={() => setFocus(null)}
                note={
                  wholeNotebook
                    ? "We find what your posts say about it. If none cover it, you get an overview of the whole notebook."
                    : "Keep it to what the selected posts cover; anything they don't cover is left out of the video."
                }
              />
              {shownTopics?.length !== 0 ? <Hint>Or pick a suggested topic</Hint> : null}
              <FocusCards
                topics={shownTopics}
                picked={focus}
                onPick={(t) => {
                  setFocus(t);
                  setCustom("");
                }}
              />
            </View>
          ) : null}

          <View style={createStyles.field}>
            <Label>Video style</Label>
            {!catalog.data ? (
              <Loading />
            ) : (
              <View style={styles.chips}>
                {styleList.map((s) => {
                  const on = options.video_style === s.id;
                  return (
                    <Pressable key={s.id} onPress={() => set({ video_style: s.id })} accessibilityRole="button" accessibilityState={{ selected: on }} style={[styles.chip, on && styles.chipOn]}>
                      <Text style={[styles.chipText, on && styles.chipTextOn]}>
                        {s.name}
                        {s.kind === "custom" ? " (yours)" : ""}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {houseStyles && styleList.find((s) => s.id === options.video_style)?.description ? (
              <Hint>{styleList.find((s) => s.id === options.video_style)?.description}</Hint>
            ) : null}
          </View>
          <Foot error={error}>
            <PillButton
              title="Go to step 2"
              variant="primary"
              disabled={!sourceReady || shownTopics === null || (wholeNotebook && !topicChosen)}
              onPress={() => setStep(2)}
            />
          </Foot>
        </>
      ) : null}

      {step === 2 ? (
        <>
          {!catalog.data ? (
            <Loading />
          ) : templates.length === 0 ? (
            <Hint>No templates available.</Hint>
          ) : (
            <ScrollView
              ref={templateBox}
              style={[styles.box, { height: templateRow ? BOX_PAD * 2 + templateRow * 2.8 + TEMPLATE_GAP * 2 : 360 }]}
              contentContainerStyle={styles.boxBody}
              nestedScrollEnabled
              showsVerticalScrollIndicator>
              <View style={styles.templates}>
                {templates.map((t, i) => {
                  const on = options.template === t.id;
                  return (
                    <Pressable
                      key={t.id}
                      onLayout={(e) => {
                        const { y, height } = e.nativeEvent.layout;
                        if (i === 0 && height !== templateRow) setTemplateRow(height);
                        // The chosen template is scrolled into view when the step opens (as the web).
                        if (on && !scrolledTo.current) {
                          scrolledTo.current = true;
                          templateBox.current?.scrollTo({ y: Math.max(0, y - BOX_PAD), animated: false });
                        }
                      }}
                      onPress={() => {
                        setTemplatePicked(true);
                        set(templateFields(t));
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      style={[styles.template, on && styles.templateOn]}>
                      <TemplateThumb template={t} />
                      {t.custom ? (
                        <Text style={styles.badge}>Yours</Text>
                      ) : t.badge || t.popular_template ? (
                        <Text style={styles.badge}>{t.badge ?? "Popular"}</Text>
                      ) : null}
                      <Text style={styles.templateName} numberOfLines={1}>
                        {t.name}
                      </Text>
                      {on ? (
                        <View style={styles.templateCheck}>
                          <SymbolView name={{ ios: "checkmark", android: "check" }} size={11} weight="bold" tintColor={colors.white} />
                        </View>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          )}
          <View style={createStyles.field}>
            <Label>Video colors</Label>
            <View style={styles.colors}>
              {(
                [
                  ["accent_color", "Accent"],
                  ["bg_color", "BG"],
                  ["text_color", "Text"],
                ] as const
              ).map(([k, label]) => (
                <ColorField
                  key={k}
                  label={label}
                  value={options[k] ?? "#000000"}
                  onChange={(c) => {
                    // Picking a colour keeps the template on screen as chosen.
                    if (!templatePicked && defaultTemplate) {
                      setTemplatePicked(true);
                      setForm((f) => ({ ...f, ...templateFields(defaultTemplate), [k]: c }));
                    } else set({ [k]: c });
                  }}
                />
              ))}
            </View>
          </View>
          <Foot>
            <PillButton title="Back" onPress={() => setStep(1)} />
            <PillButton title="Go to step 3" variant="primary" onPress={() => setStep(3)} />
          </Foot>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <View style={createStyles.field}>
            <Label>Language</Label>
            <Select
              label="Language"
              value={form.content_language ?? ""}
              options={[{ value: "", label: "Auto", hint: "Detect from the content" }, ...(catalog.data?.languages ?? []).map((l) => ({ value: l.code, label: l.name }))]}
              onChange={(v) => set({ content_language: v || null })}
            />
            <Hint>Language of the video content</Hint>
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.switchText}>No voiceover</Text>
            <Switch
              value={form.voice_gender === "none"}
              onValueChange={(on) => {
                if (on) return set({ voice_gender: "none" });
                const v = (saved ?? []).find((x) => x.voice_id === currentVoiceId) ?? saved?.[0];
                if (v) pickVoice(v);
                else set({ voice_gender: "female" });
              }}
              trackColor={{ true: colors.blue }}
            />
          </View>
          <Label>Voice: play to preview</Label>
          {saved === null ? (
            <Loading />
          ) : saved.length === 0 ? (
            <Hint>No voices yet. Add some in Manage voices.</Hint>
          ) : (
            <ScrollView
              style={[styles.box, form.voice_gender === "none" && styles.dim, { height: voiceRow ? BOX_PAD * 2 + voiceRow * 4.5 + VOICE_GAP * 4 : 300 }]}
              contentContainerStyle={[styles.boxBody, styles.voices]}
              nestedScrollEnabled
              showsVerticalScrollIndicator>
              {saved.map((v, i) => {
                const on = currentVoiceId === v.voice_id && form.voice_gender !== "none";
                const canPlay = v.source === "notestack" || Boolean(v.preview_url);
                return (
                  <View
                    key={v.voice_id}
                    onLayout={i === 0 ? (e) => e.nativeEvent.layout.height !== voiceRow && setVoiceRow(e.nativeEvent.layout.height) : undefined}
                    style={[styles.voice, on && styles.voiceOn]}>
                    <Pressable
                      onPress={() => playVoice(v)}
                      disabled={!canPlay}
                      accessibilityRole="button"
                      accessibilityLabel={`${playing === v.voice_id ? "Stop" : "Play"} ${v.name}`}
                      style={[styles.play, !canPlay && styles.dim]}>
                      <SymbolView name={playing === v.voice_id ? { ios: "stop.fill", android: "stop" } : { ios: "play.fill", android: "play_arrow" }} size={14} tintColor={colors.white} />
                    </Pressable>
                    <Pressable
                      onPress={() => pickVoice(v)}
                      disabled={form.voice_gender === "none"}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      style={styles.voicePick}>
                      <Text style={styles.voiceName}>{v.name}</Text>
                      <Text style={styles.voiceMeta}>{[cap(v.gender), cap(v.accent)].filter(Boolean).join(" • ")}</Text>
                    </Pressable>
                    {on ? <SymbolView name={{ ios: "checkmark.circle.fill", android: "check_circle" }} size={18} tintColor={colors.blue} /> : null}
                  </View>
                );
              })}
            </ScrollView>
          )}
          <Foot error={error}>
            <PillButton title="Back" onPress={() => setStep(2)} disabled={busy} />
            <PillButton title={busy ? "Initiating..." : "Generate Video"} variant="primary" busy={busy} onPress={() => void submit()} />
          </Foot>
        </>
      ) : null}
    </View>
  );
}

/** A template's poster, or a card in its colours when it has none (web: video/parts.tsx TemplateThumb). */
/** A template's poster (portrait or landscape, to match the video), or its colours when it has none (web: TemplateThumb). */
export function TemplateThumb({ template, portrait = false }: { template: VideoTemplate; portrait?: boolean }) {
  const [failed, setFailed] = useState(false);
  const c = template.preview_colors ?? {};
  const src = (portrait && template.preview_portrait_url) || template.preview_url || null;
  if (!src || failed) {
    return (
      <View style={[styles.thumb, styles.thumbFallback, { backgroundColor: c.bg ?? "#111", borderColor: c.accent ?? "transparent" }]}>
        <View style={[styles.thumbBar, { backgroundColor: c.accent ?? "#7c3aed" }]} />
        <Text style={[styles.thumbName, { color: c.text ?? "#fff" }]} numberOfLines={2}>
          {template.name}
        </Text>
      </View>
    );
  }
  return <Image source={{ uri: src }} style={[styles.thumb, portrait && styles.thumbPortrait]} contentFit="cover" onError={() => setFailed(true)} />;
}

const SWATCHES = [
  "#7c3aed", "#217cff", "#0ea5e9", "#14b8a6", "#22c55e", "#eab308", "#f97316", "#ef4444",
  "#ec4899", "#a855f7", "#ffffff", "#e5e7eb", "#9ca3af", "#4b5563", "#1f2937", "#000000",
];

/** A colour as a swatch and its hex; tapping opens a palette with a hex field (phones have no colour input). */
export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(value);
  const valid = /^#[0-9a-f]{6}$/i.test(hex.trim());
  return (
    <>
      <Pressable
        onPress={() => {
          setHex(value);
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${label} colour ${value}`}
        style={styles.colorField}>
        <View style={[styles.swatch, { backgroundColor: value }]} />
        <Text style={styles.colorLabel}>{label}</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable silent style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable silent style={styles.palette} onPress={() => {}}>
            <Text style={styles.paletteTitle}>{label} colour</Text>
            <View style={styles.swatches}>
              {SWATCHES.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => {
                    onChange(c);
                    setOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={c}
                  style={[styles.swatchBig, { backgroundColor: c }, c.toLowerCase() === value.toLowerCase() && styles.swatchOn]}
                />
              ))}
            </View>
            <View style={styles.hexRow}>
              <View style={[styles.swatch, { backgroundColor: valid ? hex.trim() : value }]} />
              <TextInput
                style={[pageStyles.input, styles.hexInput]}
                value={hex}
                onChangeText={setHex}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={7}
                placeholder="#217cff"
                placeholderTextColor={colors.text3}
              />
              <PillButton
                small
                title="Use"
                variant="primary"
                disabled={!valid}
                onPress={() => {
                  onChange(hex.trim().toLowerCase());
                  setOpen(false);
                }}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/** One post to make the video from: a search over the indexed posts, newest added first. */
function PostPicker({ selected, onPick }: { selected: string | null; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  // The list scrolls in its own box, sized from the first row: about 3.5 rows show, the next one cut off.
  const [row, setRow] = useState(0);
  const posts = useQuery({ queryKey: ["docs", "picker", "indexed"], queryFn: () => docsApi.list({ sort: "added", limit: 5000, indexed_only: true }) });
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (posts.data?.items ?? []).filter((d) => !d.locked && (!needle || d.title.toLowerCase().includes(needle))).slice(0, 50);
  }, [posts.data, q]);
  return (
    <View style={createStyles.field}>
      <TextInput
        style={pageStyles.input}
        value={q}
        onChangeText={setQ}
        placeholder="Search posts"
        placeholderTextColor={colors.text3}
        clearButtonMode="while-editing"
        autoCapitalize="none"
      />
      {posts.isPending ? <ActivityIndicator color={colors.blue} /> : null}
      <ScrollView style={[styles.postList, { maxHeight: row ? row * 3.5 : 260 }]} nestedScrollEnabled showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
        {shown.map((d, i) => {
          const on = d.id === selected;
          return (
            <Pressable
              key={d.id}
              onPress={() => onPick(d.id)}
              onLayout={i === 0 ? (e) => e.nativeEvent.layout.height !== row && setRow(e.nativeEvent.layout.height) : undefined}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              style={[styles.postRow, i > 0 && styles.postLine, on && styles.postOn]}>
              <View style={[styles.radio, on && styles.radioOn]} />
              <View style={styles.flex}>
                <Text style={styles.postTitle} numberOfLines={2}>
                  {d.title}
                </Text>
                <Text style={pageStyles.mono}>{formatDate(d.published_at)}</Text>
              </View>
            </Pressable>
          );
        })}
        {posts.data && shown.length === 0 ? <Hint>No posts match.</Hint> : null}
      </ScrollView>
    </View>
  );
}

/** The scrolling boxes' inner padding and the gaps between their rows (the box heights are worked out from them). */
const BOX_PAD = 8;
const TEMPLATE_GAP = 12;
const VOICE_GAP = 8;

const styles = StyleSheet.create({
  thumbPortrait: { aspectRatio: 9 / 16 },
  flex: { flex: 1 },
  notice: { color: colors.text2, fontSize: 16, lineHeight: 23 },
  limitTitle: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 22 },
  quota: { color: colors.text3, fontFamily: fonts.mono, fontSize: 12.5 },
  steps: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  stepWrap: { flexDirection: "row", alignItems: "center" },
  stepLine: { width: 44, height: 2, backgroundColor: colors.line },
  stepLineOn: { backgroundColor: colors.blue },
  step: { width: 30, height: 30, borderRadius: 15, borderWidth: 1.5, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" },
  stepOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  stepDone: { borderColor: colors.blue, backgroundColor: colors.blue },
  stepText: { color: colors.text3, fontFamily: fonts.mono, fontSize: 13 },
  stepTextOn: { color: colors.white },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  chipOn: { backgroundColor: colors.blue, borderColor: colors.blue },
  chipText: { color: colors.text2, fontSize: 15 },
  chipTextOn: { color: colors.white, fontWeight: "600" },
  box: { flexGrow: 0, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(255, 255, 255, 0.02)" },
  boxBody: { padding: BOX_PAD },
  templates: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: TEMPLATE_GAP },
  template: { width: "48.5%", gap: 6, padding: 6, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.line },
  templateOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  templateName: { color: colors.text, fontSize: 14.5, fontWeight: "600", paddingHorizontal: 2 },
  templateCheck: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.blue,
  },
  badge: {
    position: "absolute",
    top: 10,
    left: 10,
    color: colors.white,
    fontFamily: fonts.mono,
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: "hidden",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
  },
  thumb: { width: "100%", aspectRatio: 16 / 9, borderRadius: radius.sm },
  thumbFallback: { justifyContent: "flex-end", gap: 6, padding: 8, borderWidth: 1 },
  thumbBar: { width: 28, height: 4, borderRadius: 2 },
  thumbName: { fontSize: 12, fontWeight: "700" },
  colors: { flexDirection: "row", gap: 10 },
  colorField: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 10,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  swatch: { width: 24, height: 24, borderRadius: 6, borderWidth: 1, borderColor: colors.lineStrong },
  colorLabel: { color: colors.text2, fontSize: 13.5, flexShrink: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.6)", alignItems: "center", justifyContent: "center", padding: 24 },
  palette: { alignSelf: "stretch", gap: 14, padding: 18, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: "#111214" },
  paletteTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  swatchBig: { width: 40, height: 40, borderRadius: 10, borderWidth: 1, borderColor: colors.lineStrong },
  swatchOn: { borderWidth: 3, borderColor: colors.blue },
  hexRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  hexInput: { flex: 1, fontFamily: fonts.mono, fontSize: 15 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchText: { color: colors.text, fontSize: 16 },
  voices: { gap: VOICE_GAP },
  dim: { opacity: 0.4 },
  voice: { flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  voiceOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  // The web's voice play button: a quiet dark circle, the triangle white.
  play: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255, 255, 255, 0.08)" },
  voicePick: { flex: 1, gap: 2 },
  voiceName: { color: colors.text, fontSize: 16, fontWeight: "600" },
  voiceMeta: { color: colors.text3, fontSize: 13.5 },
  postList: { flexGrow: 0, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  postRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12 },
  postLine: { borderTopWidth: 1, borderTopColor: colors.line },
  postOn: { backgroundColor: colors.blue10 },
  postTitle: { color: colors.text, fontSize: 15.5 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: colors.lineStrong },
  radioOn: { borderWidth: 5, borderColor: colors.blue },
});

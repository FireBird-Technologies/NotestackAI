import { ApiError, type UploadSource } from "@notestack/shared/client";
import { jobsApi, videoVoicesApi, voiceApi } from "@notestack/shared/endpoints";
import type {
  Job,
  VideoLibraryVoice,
  VideoSavedVoice,
  VoiceDesignInput,
  VoiceDesignPreview,
  VoiceState,
} from "@notestack/shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createAudioPlayer,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { File } from "expo-file-system";
import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { useVoicePlayer, voicePreviewUrl as previewUrl } from "@/lib/audio";
import { Select } from "@/create/fields";
import { Segments } from "@/sources/sources-nav";
import { colors, fonts, radius } from "@/ui/theme";
import { ErrorText, Loading } from "@/ui";
import { confirm, JobProgress, Page, PageHead, pageStyles, PillButton, Section, Sheet } from "@/ui/widgets";

const cap = (s?: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const fmtSeconds = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;


/** Manage voices (web: pages/Voices.tsx, VoiceProfile.tsx, voice/YourVoices.tsx): who reads audio and video aloud. */
export default function Voices() {
  const queryClient = useQueryClient();
  const voice = useQuery({ queryKey: ["voice"], queryFn: voiceApi.get });
  const voices = useQuery({ queryKey: ["voices", "list"], queryFn: videoVoicesApi.list });
  const [cloneJob, setCloneJob] = useState<Job | null>(null);
  const [adding, setAdding] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const { playing, play } = useVoicePlayer();

  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ["voice"] });
    void queryClient.invalidateQueries({ queryKey: ["voices", "list"] });
  };

  // Follow a clone until it is made; a finished clone joins Your voices as "My voice".
  const cloneRunning = Boolean(cloneJob && (cloneJob.status === "queued" || cloneJob.status === "running"));
  useEffect(() => {
    if (!cloneJob || !cloneRunning) return;
    const t = setInterval(async () => {
      const next = await jobsApi.get(cloneJob.id).catch(() => null);
      if (!next) return;
      setCloneJob(next);
      if (next.status === "done" || next.status === "failed") reload();
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneJob, cloneRunning]);

  const act = async (voiceId: string, run: () => Promise<unknown>) => {
    setBusy(voiceId);
    setError("");
    try {
      await run();
      await queryClient.invalidateQueries({ queryKey: ["voices", "list"] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const playSaved = async (v: VideoSavedVoice) => {
    if (v.source !== "notestack") return play(v.voice_id, v.preview_url);
    if (playing === v.voice_id) return play(v.voice_id, null);
    try {
      play(v.voice_id, await previewUrl(v.voice_id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not play that voice.");
    }
  };

  const state = voice.data;
  if (voice.isPending) return <Loading />;
  if (!state) {
    return (
      <Page>
        <PageHead eyebrow="Voices" title="Manage voices" />
        <ErrorText>Could not load your voices.</ErrorText>
        <PillButton title="Try again" onPress={reload} />
      </Page>
    );
  }

  const library = voices.data?.library.filter((v) => !v.saved) ?? [];
  const showClone = state.clone.status !== "none" || Boolean(cloneJob);

  return (
    <Page>
      <PageHead eyebrow="Voices" title="Manage voices" />
      <Section title="Who reads your work aloud">
        {!state.tts_configured ? <Text style={pageStyles.body}>Voice previews are unavailable right now.</Text> : null}
        <Text style={pageStyles.body}>
          Your voices read your audio overviews, and narrate your videos. Add your own, or pick from the library.
        </Text>
        <PillButton title="Add voices" variant="primary" onPress={() => setAdding(true)} />
        <ErrorText>{error}</ErrorText>
        {voices.isPending ? <Loading /> : null}

        {voices.data ? (
          <>
            <View style={styles.listCard}>
              <View style={styles.listHead}>
                <Text style={styles.listTitle}>Your voices</Text>
                <Text style={styles.count}>{voices.data.saved.length}</Text>
              </View>
              {voices.data.saved.length === 0 ? (
                <Text style={pageStyles.body}>No voices yet. Add one, or pick from the library below.</Text>
              ) : (
                voices.data.saved.map((v) => (
                  <VoiceRow
                    key={v.voice_id}
                    name={v.name}
                    detail={v.source === "notestack" ? "Your voice" : [cap(v.gender), cap(v.accent)].filter(Boolean).join(" • ")}
                    playing={playing === v.voice_id}
                    canPlay={v.source === "notestack" || Boolean(v.preview_url)}
                    onPlay={() => void playSaved(v)}
                    action={
                      <PillButton
                        title={busy === v.voice_id ? "Removing..." : "Remove"}
                        small
                        disabled={busy === v.voice_id}
                        onPress={() => act(v.voice_id, () => videoVoicesApi.unsave(v.voice_id))}
                      />
                    }
                  />
                ))
              )}
            </View>

            <View style={styles.listCard}>
              <View style={styles.listHead}>
                <Text style={styles.listTitle}>Voice library</Text>
              </View>
              {library.length === 0 ? (
                <Text style={pageStyles.body}>Every library voice is in your voices.</Text>
              ) : (
                library.map((v: VideoLibraryVoice) => (
                  <VoiceRow
                    key={v.voice_id}
                    name={v.name}
                    detail={`${[cap(v.gender), cap(v.accent), cap(v.age)].filter(Boolean).join(" • ")}${v.description ? ` - ${v.description}` : ""}`}
                    playing={playing === v.voice_id}
                    canPlay={Boolean(v.preview_url)}
                    onPlay={() => play(v.voice_id, v.preview_url)}
                    action={
                      <PillButton
                        title={busy === v.voice_id ? "Adding..." : "Add"}
                        variant="primary"
                        small
                        disabled={busy === v.voice_id}
                        onPress={() => act(v.voice_id, () => videoVoicesApi.save(v.voice_id))}
                      />
                    }
                  />
                ))
              )}
            </View>
          </>
        ) : null}

        {showClone ? (
          <View style={styles.clone}>
            <Text style={styles.listTitle}>Your cloned voice</Text>
            {cloneJob && (cloneRunning || cloneJob.status === "failed") ? <JobProgress job={cloneJob} /> : null}
            {state.clone.status === "processing" && !cloneJob ? (
              <Text style={pageStyles.body}>Your voice is being created. It joins your voices when ready.</Text>
            ) : null}
            {state.clone.status === "failed" && state.clone.error && !cloneRunning ? <ErrorText>{state.clone.error}</ErrorText> : null}
            <View style={pageStyles.row}>
              {state.clone.status === "ready" && state.clone.preview_url ? (
                <PillButton small title={playing === "clone" ? "Stop" : "Hear my voice"} onPress={() => play("clone", state.clone.preview_url)} />
              ) : null}
              {!cloneRunning && state.clone.allowed ? (
                <PillButton small title={state.clone.status === "failed" ? "Try again" : "Record again"} onPress={() => setCloning(true)} />
              ) : null}
              {state.clone.status !== "none" ? (
                <PillButton
                  small
                  variant="danger"
                  title="Revoke consent"
                  onPress={() =>
                    confirm("Revoke and delete my voice?", "Revoke", async () => {
                      await voiceApi.revoke();
                      reload();
                    })
                  }
                />
              ) : null}
            </View>
          </View>
        ) : null}
      </Section>

      <Sheet visible={adding} title="Add voices" onClose={() => setAdding(false)}>
        <AddVoices
          state={state}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
          onClone={() => {
            setAdding(false);
            setCloning(true);
          }}
        />
      </Sheet>
      <Sheet visible={cloning} title="Clone your voice" onClose={() => setCloning(false)}>
        <CloneVoice
          state={state}
          onClose={() => setCloning(false)}
          onDone={(job) => {
            setCloneJob(job);
            setCloning(false);
            reload();
          }}
        />
      </Sheet>
    </Page>
  );
}

function VoiceRow({
  name,
  detail,
  playing,
  canPlay,
  onPlay,
  action,
}: {
  name: string;
  detail: string;
  playing: boolean;
  canPlay: boolean;
  onPlay: () => void;
  action: React.ReactNode;
}) {
  return (
    <View style={styles.voiceRow}>
      <PlayButton on={playing} disabled={!canPlay} label={name} onPress={onPlay} />
      <View style={styles.voiceText}>
        <Text style={styles.voiceName}>{name}</Text>
        {detail ? (
          <Text style={styles.voiceMeta} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  );
}

function PlayButton({ on, disabled, label, onPress }: { on: boolean; disabled?: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${on ? "Stop" : "Play"} ${label}`}
      style={[styles.play, on && styles.playOn, disabled && styles.off]}>
      <SymbolView
        name={{ ios: on ? "stop.fill" : "play.fill", android: on ? "stop" : "play_arrow" }}
        size={15}
        tintColor={colors.white}
      />
    </Pressable>
  );
}

type GenMode = "prompt" | "clone" | "options";

const GEN_OPTIONS: { key: keyof Omit<VoiceDesignInput, "prompt">; label: string; values: string[] }[] = [
  { key: "gender", label: "Gender", values: ["female", "male", "neutral"] },
  { key: "age", label: "Age", values: ["young", "middle-aged", "older"] },
  { key: "persona", label: "Personality", values: ["warm", "professional", "calm", "friendly", "confident", "energetic"] },
  { key: "pace", label: "Pace", values: ["slow", "measured", "brisk"] },
  { key: "accent", label: "Accent", values: ["American", "British", "Australian", "Irish", "Scottish", "Indian", "Canadian", "South African"] },
];

const PROMPT_IDEAS = [
  "A calm, low British voice for late night essays",
  "An upbeat young American podcaster who smiles while talking",
  "A thoughtful older narrator with a soft Irish lilt",
];

/** Make a new voice: describe it, build it from options, or clone your own (web: GenerateVoicePanel). */
function AddVoices({ state, onSaved, onClone }: { state: VoiceState; onSaved: () => void; onClone: () => void }) {
  const [mode, setMode] = useState<GenMode>("prompt");
  const [opts, setOpts] = useState<VoiceDesignInput>({ gender: "female", age: "middle-aged", persona: "warm", pace: "measured", accent: "American" });
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<{ description: string; previews: VoiceDesignPreview[] } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"generate" | "save" | null>(null);
  const [error, setError] = useState("");
  const { playing, play } = useVoicePlayer();

  const generate = async () => {
    setBusy("generate");
    setError("");
    setResult(null);
    setPicked(null);
    try {
      const res = await voiceApi.design(mode === "prompt" ? { prompt } : opts);
      setResult(res);
      setPicked(res.previews[0]?.generated_voice_id ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not make previews. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!result || !picked) return;
    setBusy("save");
    setError("");
    try {
      await voiceApi.saveDesign({ generated_voice_id: picked, name: name.trim(), description: result.description });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the voice. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.stack}>
      <Segments
        options={[
          { id: "prompt", label: "Describe it" },
          { id: "clone", label: "Clone my voice" },
          { id: "options", label: "Build" },
        ]}
        value={mode}
        onChange={(m) => {
          setMode(m);
          setResult(null);
          setError("");
        }}
      />

      {/* As the web's: each option a dropdown, two to a row, in one box */}
      {mode === "options" ? (
        <View style={styles.optionBox}>
          {GEN_OPTIONS.map((g) => (
            <View key={g.key} style={styles.optionField}>
              <Text style={styles.optionLabel}>{g.label}</Text>
              <Select<string>
                label={g.label}
                value={opts[g.key] ?? g.values[0]}
                onChange={(v) => setOpts({ ...opts, [g.key]: v })}
                options={g.values.map((v) => ({ value: v, label: g.key === "accent" ? v : cap(v.replace(/-/g, " ")) }))}
              />
            </View>
          ))}
        </View>
      ) : null}

      {mode === "prompt" ? (
        <>
          <Text style={pageStyles.label}>Describe the voice you want</Text>
          <TextInput
            style={[pageStyles.input, styles.textarea]}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="A calm, low British voice for late night essays"
            placeholderTextColor={colors.text3}
            multiline
            maxLength={1000}
            textAlignVertical="top"
          />
          <View style={styles.chips}>
            {PROMPT_IDEAS.map((p) => (
              <Pressable key={p} onPress={() => setPrompt(p)} style={styles.chip}>
                <Text style={styles.chipText}>{p}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={pageStyles.mono}>{prompt.trim().length} / 1000</Text>
        </>
      ) : null}

      {mode === "clone" ? (
        state.clone.allowed ? (
          <>
            <Text style={pageStyles.body}>
              Read a passage from your own writing for one to three minutes. Your voice joins your voices, ready for audio
              overviews and videos.
            </Text>
            <PillButton
              title={state.clone.status === "ready" ? "Record my voice again" : "Start recording"}
              variant="primary"
              disabled={!state.tts_configured}
              onPress={onClone}
            />
          </>
        ) : (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>Voice cloning is on the Writer and Studio plans</Text>
            <Text style={pageStyles.body}>Record a couple of minutes and every audio overview is narrated by you.</Text>
          </View>
        )
      ) : null}

      {mode !== "clone" ? (
        <PillButton
          title={busy === "generate" ? "Generating previews..." : result ? "Generate again" : "Generate previews"}
          variant="primary"
          busy={busy === "generate"}
          disabled={busy !== null || !state.tts_configured || (mode === "prompt" && prompt.trim().length < 20)}
          onPress={() => void generate()}
        />
      ) : null}

      {result && mode !== "clone" ? (
        <View style={styles.stack}>
          <Text style={pageStyles.eyebrow}>Pick the one you like</Text>
          {result.previews.map((p, i) => {
            const on = picked === p.generated_voice_id;
            return (
              <Pressable key={p.generated_voice_id} onPress={() => setPicked(p.generated_voice_id)} style={[styles.preview, on && styles.previewOn]}>
                <View style={[styles.radio, on && styles.radioOn]} />
                <Text style={styles.voiceName}>Option {i + 1}</Text>
                <View style={styles.spacer} />
                <PillButton small title={playing === p.generated_voice_id ? "Stop" : "Play"} onPress={() => play(p.generated_voice_id, p.url)} />
              </Pressable>
            );
          })}
          <TextInput
            style={pageStyles.input}
            value={name}
            onChangeText={setName}
            placeholder="Name it, e.g. Late night narrator"
            placeholderTextColor={colors.text3}
            maxLength={60}
            accessibilityLabel="Voice name"
          />
          <PillButton
            title={busy === "save" ? "Saving..." : "Save voice"}
            variant="primary"
            busy={busy === "save"}
            disabled={busy !== null || !picked || !name.trim()}
            onPress={() => void save()}
          />
        </View>
      ) : null}
      {!state.tts_configured ? <Text style={pageStyles.mono}>Voice generation is unavailable right now.</Text> : null}
      <ErrorText>{error}</ErrorText>
    </View>
  );
}

type Take = { uri: string; name: string; seconds: number };

/** How long a recording runs: loaded once, read, then let go (an upload has no duration until it is loaded). */
function probeSeconds(uri: string): Promise<number> {
  return new Promise((resolve) => {
    const player = createAudioPlayer({ uri });
    const done = (s: number) => {
      clearTimeout(timer);
      sub.remove();
      player.remove();
      resolve(s);
    };
    const timer = setTimeout(() => done(60), 5000);
    const sub = player.addListener("playbackStatusUpdate", (st) => {
      if (st.isLoaded && st.duration > 0) done(st.duration);
    });
  });
}

/** Record or upload takes, agree to the consent statement, and send them to make the clone (web: CloneModal). */
function CloneVoice({ state, onClose, onDone }: { state: VoiceState; onClose: () => void; onDone: (job: Job) => void }) {
  const script = useQuery({ queryKey: ["voice", "script"], queryFn: voiceApi.readingScript });
  const [takes, setTakes] = useState<Take[]>([]);
  const [agreed, setAgreed] = useState(false);
  const [denoise, setDenoise] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { playing, play } = useVoicePlayer();
  const total = takes.reduce((n, t) => n + t.seconds, 0);
  const quality =
    total < 30
      ? "Too short: record at least 30 seconds"
      : total < 60
        ? "Usable, but 1 to 3 minutes sounds much better"
        : total <= 300
          ? "Great length"
          : "Plenty: more than 5 minutes adds little";

  const upload = async () => {
    const picked = await File.pickFileAsync({ multipleFiles: true, mimeTypes: ["audio/*"] }).catch(() => null);
    if (!picked || picked.canceled) return;
    for (const f of picked.result) {
      const seconds = await probeSeconds(f.uri);
      setTakes((t) => [...t, { uri: f.uri, name: f.name, seconds }]);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      // expo-file-system's File is a Blob with a name, which is what the shared upload sends.
      const files = takes.map((t) => new File(t.uri) as unknown as UploadSource);
      const res = await voiceApi.consent(files, state.clone.consent_text, denoise);
      onDone(res.job);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not upload your takes. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.stack}>
      <View style={styles.tips}>
        <Text style={pageStyles.body}>1. Quiet room, no music, phone on silent. Keep the same distance from the mic.</Text>
        <Text style={pageStyles.body}>2. Read naturally, the way you would on a podcast. Pauses are fine.</Text>
        <Text style={pageStyles.body}>3. Record in one or more takes: 1 to 3 minutes in total works best.</Text>
      </View>
      {script.data ? (
        <View style={styles.script}>
          <Text style={pageStyles.eyebrow}>Read this, from &quot;{script.data.title}&quot;</Text>
          {script.data.text.split(/\n\n+/).map((p, i) => (
            <Text key={i} style={styles.scriptText}>
              {p}
            </Text>
          ))}
        </View>
      ) : null}

      <Recorder onTake={(t) => setTakes((list) => [...list, t])} />
      <PillButton title="Or upload recordings" small onPress={() => void upload()} />

      {takes.map((t, i) => (
        <View key={t.uri} style={styles.take}>
          <PlayButton on={playing === t.uri} label={`take ${i + 1}`} onPress={() => play(t.uri, t.uri)} />
          <Text style={[pageStyles.mono, styles.voiceText]}>
            Take {i + 1} · {fmtSeconds(t.seconds)}
          </Text>
          <Pressable onPress={() => setTakes(takes.filter((x) => x !== t))} hitSlop={10} accessibilityLabel={`Remove take ${i + 1}`}>
            <SymbolView name={{ ios: "xmark", android: "close" }} size={14} tintColor={colors.text2} />
          </Pressable>
        </View>
      ))}

      <View style={pageStyles.meter}>
        <View style={pageStyles.meterHead}>
          <Text style={pageStyles.meterLabel}>Total {fmtSeconds(total)}</Text>
          <Text style={pageStyles.meterValue}>{takes.length ? quality : "No takes yet"}</Text>
        </View>
        <View style={pageStyles.track}>
          <View style={[pageStyles.bar, { width: `${Math.min(100, (total / 180) * 100)}%` }]} />
        </View>
      </View>

      <Check value={denoise} onChange={setDenoise} label="Remove background noise (turn off for studio quality recordings)" />
      <Text style={styles.consent}>{state.clone.consent_text}</Text>
      <Check value={agreed} onChange={setAgreed} label="I agree to the statement above, and this is my own voice." />
      <ErrorText>{error}</ErrorText>
      <View style={pageStyles.row}>
        <PillButton title="Cancel" onPress={onClose} />
        <PillButton
          title={busy ? "Uploading..." : "Create my voice"}
          variant="primary"
          busy={busy}
          disabled={!takes.length || total < 10 || !agreed || busy}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

/** One take at a time from the microphone, with a level meter (web: Recorder). */
function Recorder({ onTake }: { onTake: (t: Take) => void }) {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const live = useAudioRecorderState(recorder, 120);
  const [error, setError] = useState("");
  // Metering is in decibels (0 is loudest); shown as 0 to 1.
  const level = live.isRecording && live.metering !== undefined ? Math.min(1, Math.pow(10, live.metering / 20)) : 0;
  const seconds = live.durationMillis / 1000;

  const start = async () => {
    setError("");
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setError("Microphone access was blocked. Allow it in Settings, or upload recordings instead.");
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
  };

  const stop = async () => {
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    if (recorder.uri) onTake({ uri: recorder.uri, name: `take-${Date.now()}.m4a`, seconds });
  };

  return (
    <View style={styles.stack}>
      <View style={pageStyles.row}>
        {live.isRecording ? (
          <PillButton title={`Stop take (${fmtSeconds(seconds)})`} variant="danger" onPress={() => void stop()} />
        ) : (
          <PillButton title="Record a take" variant="primary" onPress={() => void start()} />
        )}
        {live.isRecording ? (
          <View style={styles.level} accessibilityLabel="Input level">
            <View style={[styles.levelFill, { width: `${Math.min(100, level * 160)}%` }]} />
          </View>
        ) : null}
      </View>
      {live.isRecording && level < 0.04 && seconds > 2 ? (
        <Text style={pageStyles.mono}>We can barely hear you. Move closer to the microphone.</Text>
      ) : null}
      {level > 0.95 ? <Text style={pageStyles.mono}>Too loud: back off a little so it does not clip.</Text> : null}
      <ErrorText>{error}</ErrorText>
    </View>
  );
}

function Check({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <View style={styles.check}>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: colors.surface2, true: colors.blue }} thumbColor={colors.white} />
      <Text style={[pageStyles.body, styles.voiceText]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  // As the web's: each list a card of its own, each voice a row card inside it
  // A little wider than the section's own padding allows, so the rows have room on a phone
  listCard: { gap: 10, marginTop: 8, marginHorizontal: -10, padding: 12, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: "rgba(255, 255, 255, 0.02)" },
  listHead: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 2 },
  listTitle: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 21 },
  count: { minWidth: 28, paddingHorizontal: 9, paddingVertical: 2, borderRadius: 999, overflow: "hidden", textAlign: "center", backgroundColor: colors.surface2, color: colors.text2, fontFamily: fonts.mono, fontSize: 13 },
  voiceRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  voiceText: { flex: 1, gap: 3 },
  voiceName: { color: colors.text, fontSize: 16.5, fontWeight: "600" },
  voiceMeta: { color: colors.text2, fontSize: 14 },
  // The web's play button: a quiet dark circle, the triangle white; blue while it plays
  play: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255, 255, 255, 0.08)" },
  playOn: { backgroundColor: colors.blue },
  off: { opacity: 0.35 },
  clone: { gap: 10, marginTop: 8, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  optionBox: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 16,
    padding: 16,
    borderRadius: radius.md + 4,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  optionField: { width: "48%", gap: 8 },
  optionLabel: { color: colors.text2, fontSize: 15 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.lineStrong },
  chipText: { color: colors.text2, fontSize: 14.5 },
  textarea: { minHeight: 96 },
  notice: { gap: 6, padding: 14, borderRadius: radius.md, backgroundColor: colors.blue10, borderWidth: 1, borderColor: "rgba(33,124,255,0.35)" },
  noticeTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  preview: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  previewOn: { borderColor: colors.blue, backgroundColor: colors.blue10 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.lineStrong },
  radioOn: { borderColor: colors.blue, backgroundColor: colors.blue },
  spacer: { flex: 1 },
  tips: { gap: 4 },
  script: { gap: 8, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  scriptText: { color: colors.text, fontSize: 17, lineHeight: 27 },
  take: { flexDirection: "row", alignItems: "center", gap: 12 },
  level: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.surface2, overflow: "hidden" },
  levelFill: { height: 8, borderRadius: 4, backgroundColor: colors.blue },
  consent: {
    color: colors.text2,
    fontSize: 15,
    lineHeight: 22,
    fontStyle: "italic",
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: colors.blue,
  },
  check: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
});

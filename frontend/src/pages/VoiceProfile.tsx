import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { videoVoicesApi, voiceApi } from "../api/endpoints";
import type { Delivery, Job, LibraryVoice, Voice, VoiceDesignInput, VoiceDesignPreview, VoiceProfileData, VoiceState } from "../api/types";
import { DocPicker } from "../components/DocPicker";
import { PlayButton } from "../components/video/parts";
import { VideoVoicesSection } from "../components/video/VideoVoicesSection";
import { ConfirmButton, errorMessage, formatDate, JobProgress, Loading, Modal, PageHeader, Tabs } from "../components/ui";
import { useJob } from "../hooks/useJob";
import { useUpgrade } from "../hooks/useUpgrade";

type Host = "host_a" | "host_b";

const LIST_FIELDS: { key: keyof VoiceProfileData; label: string; hint: string }[] = [
  { key: "tone", label: "Tone", hint: "warm, wry, direct" },
  { key: "vocabulary", label: "Signature words and phrases", hint: "readers, the long game" },
  { key: "structure_habits", label: "Structure habits", hint: "short paragraphs, one idea each" },
  { key: "openings", label: "How pieces open", hint: "a number, a small scene" },
  { key: "avoid", label: "Never does", hint: "jargon, hashtags" },
];

const SLIDERS: { key: keyof Delivery; label: string; min: number; max: number; step: number; hint: string }[] = [
  { key: "stability", label: "Stability", min: 0, max: 1, step: 0.05, hint: "Lower is more expressive, higher is steadier" },
  { key: "similarity_boost", label: "Clarity and similarity", min: 0, max: 1, step: 0.05, hint: "How closely it sticks to the original voice" },
  { key: "style", label: "Style", min: 0, max: 1, step: 0.05, hint: "Exaggerates the speaker's style; keep low for news" },
  { key: "speed", label: "Speed", min: 0.7, max: 1.2, step: 0.05, hint: "1.0 is natural pace" },
];

/** Plays one URL at a time across the page. */
function usePlayer() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const play = useCallback((url: string, id: string) => {
    audio.current?.pause();
    if (playing === id) {
      setPlaying(null);
      return;
    }
    const a = new Audio(url);
    audio.current = a;
    a.onended = () => setPlaying(null);
    void a.play();
    setPlaying(id);
  }, [playing]);
  useEffect(() => () => audio.current?.pause(), []);
  return { play, playing };
}

function fmtSeconds(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

// Speaking voices

type Icon = "sun" | "book" | "mic" | "spark" | "wave" | "person";

/** The four ElevenLabs premade voices offered up front. Each has a glyph so they read at a glance. */
const PREBUILT: { voice_id: string; name: string; tag: string; icon: Icon }[] = [
  { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", tag: "Warm and reassuring", icon: "sun" },
  { voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "George", tag: "British storyteller", icon: "book" },
  { voice_id: "nPczCjzI2devNBz1zQrb", name: "Brian", tag: "Deep narrator", icon: "mic" },
  { voice_id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", tag: "Bright and lively", icon: "spark" },
];

type Tile = { voice_id: string; name: string; tag: string; icon: Icon; preview_url?: string | null };

/** The voices a host can use: the premade four, then the writer's own (clone, generated), then whatever else a host is
 * set to (e.g. a library voice). Shared by the tiles and the Manage voices modal. */
function hostTiles(state: VoiceState, voices: Voice[]): Tile[] {
  const byId = new Map(voices.map((v) => [v.voice_id, v]));
  const tiles: Tile[] = PREBUILT.map((p) => ({ ...p, preview_url: byId.get(p.voice_id)?.preview_url }));
  if (state.clone.status === "ready" && state.clone.voice_id) {
    tiles.push({ voice_id: state.clone.voice_id, name: "My voice", tag: "Your clone", icon: "person", preview_url: state.clone.preview_url });
  }
  for (const c of state.custom_voices) tiles.push({ voice_id: c.voice_id, name: c.name, tag: "Generated", icon: "wave" });
  for (const id of [state.host_voices.host_a, state.host_voices.host_b]) {
    if (!tiles.some((t) => t.voice_id === id)) {
      const v = byId.get(id);
      tiles.push({ voice_id: id, name: v?.name ?? "Current voice", tag: v?.labels?.accent ?? "Library voice", icon: "wave", preview_url: v?.preview_url });
    }
  }
  return tiles;
}

/** Listen to a voice: its sample link when it has one, otherwise a line spoken with the host's delivery. */
function useListen(host: Host, onError: (msg: string | null) => void) {
  const [loading, setLoading] = useState<string | null>(null);
  const { play, playing } = usePlayer();
  const listen = async (t: Tile) => {
    if (playing === t.voice_id || t.preview_url) return play(t.preview_url ?? "", t.voice_id);
    setLoading(t.voice_id);
    onError(null);
    try {
      const { url } = await voiceApi.preview(t.voice_id, { host });
      play(url, t.voice_id);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setLoading(null);
    }
  };
  return { listen, loading, playing };
}

function VoicePicker({
  state,
  voices,
  onSaved,
  onManage,
}: {
  state: VoiceState;
  voices: Voice[];
  onSaved: (s: VoiceState) => void;
  onManage: (host: Host) => void;
}) {
  const [host, setHost] = useState<Host>("host_a");
  const [delivery, setDelivery] = useState<Delivery>(state.delivery[host]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { listen, loading, playing } = useListen(host, setError);
  const current = state.host_voices[host];
  const other: Host = host === "host_a" ? "host_b" : "host_a";

  useEffect(() => {
    setDelivery(state.delivery[host]);
    setDirty(false);
  }, [state.delivery, host]);

  const tiles = hostTiles(state, voices);

  const choose = async (voice_id: string) => {
    if (voice_id === current) return;
    setError(null);
    try {
      onSaved(await voiceApi.update({ host_voices: { [host]: voice_id } }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="stack">
      <div className="row between wrap manage-top">
        <p className="muted">Audio overviews are a conversation between two hosts. Tap a voice to use it, or add your own.</p>
        <button className="btn btn-primary" onClick={() => onManage(host)}>
          Manage voices
        </button>
      </div>
      <Tabs<Host>
        tabs={[
          { id: "host_a", label: "Host A · leads" },
          { id: "host_b", label: "Host B · co-host" },
        ]}
        value={host}
        onChange={setHost}
      />
      {/* One row per voice, as in Video voiceovers: tap a row to give it to this host */}
      <div className="vw-voice-list" role="radiogroup" aria-label={`Voices for ${host === "host_a" ? "Host A" : "Host B"}`}>
        {tiles.map((t) => {
          const selected = t.voice_id === current;
          const usedByOther = t.voice_id === state.host_voices[other];
          return (
            <div key={t.voice_id} className={`vw-vrow${selected ? " on" : ""}`}>
              <PlayButton on={playing === t.voice_id} label={t.name} onClick={() => listen(t)}
                          disabled={loading !== null || (!t.preview_url && !state.tts_configured)} />
              <button type="button" role="radio" aria-checked={selected} className="vw-vpick" onClick={() => choose(t.voice_id)}>
                <strong>{t.name}</strong>
                <span className="muted">{t.tag}</span>
              </button>
              {selected && <span className="voice-badge-inline mono">{host === "host_a" ? "Host A" : "Host B"}</span>}
              {!selected && usedByOther && <span className="voice-badge-inline dim mono">{other === "host_a" ? "Host A" : "Host B"}</span>}
            </div>
          );
        })}
      </div>
      {error && <p className="error-text">{error}</p>}
      <details className="delivery-card">
        <summary>
          Delivery settings for {host === "host_a" ? "Host A" : "Host B"}
          <svg className="delivery-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </summary>
        <div className="delivery-grid">
          {SLIDERS.map((s) => {
            const value = Number(delivery[s.key]);
            const pct = ((value - s.min) / (s.max - s.min)) * 100;
            return (
              <label key={s.key} className="delivery-slider">
                <span className="row between">
                  <span>{s.label}</span>
                  <span className="delivery-value mono">{value.toFixed(2)}</span>
                </span>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={value}
                  style={{ "--pct": `${pct}%` } as CSSProperties}
                  onChange={(e) => {
                    setDelivery({ ...delivery, [s.key]: Number(e.target.value) });
                    setDirty(true);
                  }}
                />
                <span className="muted small">{s.hint}</span>
              </label>
            );
          })}
        </div>
        {dirty && (
          <div className="row end delivery-actions">
            <button className="btn btn-small" onClick={() => (setDelivery(state.delivery[host]), setDirty(false))}>
              Reset
            </button>
            <button
              className="btn btn-small btn-primary"
              onClick={async () => {
                onSaved(await voiceApi.update({ delivery: { [host]: delivery } }));
                setDirty(false);
              }}
            >
              Save delivery
            </button>
          </div>
        )}
      </details>
    </div>
  );
}

// Generating a new voice: build from options, describe it, or clone your own

type GenMode = "options" | "prompt" | "clone";

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

/** Make a new voice: build it from options, describe it, or clone your own. Inside the Manage voices modals. */
function GenerateVoicePanel({
  host,
  state,
  onDone,
  onSaved,
  onClone,
}: {
  /** The host the new voice is for; null when made for video voiceovers (no host changes). */
  host: Host | null;
  state: VoiceState;
  /** Saved: the caller closes or switches away. */
  onDone: () => void;
  onSaved: (s: VoiceState, voiceId: string) => void;
  onClone: () => void;
}) {
  const [mode, setMode] = useState<GenMode>("options");
  const [opts, setOpts] = useState<VoiceDesignInput>({ gender: "female", age: "middle-aged", persona: "warm", pace: "measured", accent: "American" });
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<{ description: string; previews: VoiceDesignPreview[] } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"generate" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { play, playing } = usePlayer();
  const { openUpgrade } = useUpgrade();
  const hostLabel = host === "host_a" ? "Host A" : host === "host_b" ? "Host B" : null;

  const generate = async () => {
    setBusy("generate");
    setError(null);
    setResult(null);
    setPicked(null);
    try {
      const res = await voiceApi.design(mode === "prompt" ? { prompt } : opts);
      setResult(res);
      setPicked(res.previews[0]?.generated_voice_id ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!result || !picked) return;
    setBusy("save");
    setError(null);
    try {
      const saved = await voiceApi.saveDesign({ generated_voice_id: picked, name: name.trim(), description: result.description,
                                                ...(host ? { use_as: host } : {}) });
      onSaved(saved, saved.voice_id);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="stack">
        <Tabs<GenMode>
          tabs={[
            { id: "options", label: "Build from options" },
            { id: "prompt", label: "Describe it" },
            { id: "clone", label: "Clone my voice" },
          ]}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setResult(null);
            setError(null);
          }}
        />

        {mode === "options" && (
          <div className="gen-options">
            {GEN_OPTIONS.map((g) => (
              <div key={g.key} className="gen-row">
                <span className="mono muted small">{g.label}</span>
                <div className="gen-chips">
                  {g.values.map((v) => (
                    <button key={v} type="button" className={`chip${opts[g.key] === v ? " on" : ""}`} aria-pressed={opts[g.key] === v} onClick={() => setOpts({ ...opts, [g.key]: v })}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {mode === "prompt" && (
          <>
            <label className="field">
              <span>Describe the voice you want</span>
              <textarea className="textarea" rows={3} maxLength={1000} placeholder="A calm, low British voice for late night essays" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <div className="row between">
              <div className="gen-chips">
                {PROMPT_IDEAS.map((p) => (
                  <button key={p} type="button" className="chip" onClick={() => setPrompt(p)}>
                    {p}
                  </button>
                ))}
              </div>
              <span className="mono muted small">{prompt.trim().length} / 1000</span>
            </div>
          </>
        )}

        {mode === "clone" &&
          (state.clone.allowed ? (
            <>
              <p className="muted">Read a passage from your own writing for one to three minutes. Your voice becomes Host A, so every audio overview sounds like you.</p>
              <div className="row">
                <button
                  className="btn btn-primary"
                  disabled={!state.tts_configured}
                  onClick={onClone}
                >
                  {state.clone.status === "ready" ? "Record my voice again" : "Start recording"}
                </button>
              </div>
            </>
          ) : (
            <div className="vp-upgrade">
              <div>
                <strong>Voice cloning is on the Writer and Studio plans</strong>
                <p className="muted small">Record a couple of minutes and every audio overview is narrated by you.</p>
              </div>
              <button className="btn btn-primary" onClick={() => openUpgrade("writer")}>
                Upgrade to clone my voice
              </button>
            </div>
          ))}

        {mode !== "clone" && (
          <div className="row end">
            <button className="btn btn-primary" onClick={generate} disabled={busy !== null || !state.tts_configured || (mode === "prompt" && prompt.trim().length < 20)}>
              {busy === "generate" ? "Generating previews..." : result ? "Generate again" : "Generate previews"}
            </button>
          </div>
        )}

        {result && mode !== "clone" && (
          <div className="stack">
            <p className="eyebrow">Pick the one you like</p>
            <ul className="gen-previews">
              {result.previews.map((p, i) => (
                <li key={p.generated_voice_id} className={picked === p.generated_voice_id ? "on" : ""}>
                  <label className="check">
                    <input type="radio" name="gen-preview" checked={picked === p.generated_voice_id} onChange={() => setPicked(p.generated_voice_id)} />
                    Option {i + 1}
                  </label>
                  <button type="button" className="btn btn-small" onClick={() => play(p.url, p.generated_voice_id)}>
                    {playing === p.generated_voice_id ? "Stop" : "Play"}
                  </button>
                </li>
              ))}
            </ul>
            <div className="row">
              <input className="input input-sm" placeholder="Name it, e.g. Late night narrator" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} aria-label="Voice name" />
              <button className="btn btn-primary" onClick={save} disabled={busy !== null || !picked || !name.trim()}>
                {busy === "save" ? "Saving..." : hostLabel ? `Save and use as ${hostLabel}` : "Save voice"}
              </button>
            </div>
          </div>
        )}
        {!state.tts_configured && <p className="muted small">Voice generation is unavailable right now.</p>}
        {error && <p className="error-text">{error}</p>}
      </div>
    </>
  );
}

// Voice library (commercially licensed voices from ElevenLabs)

function LibraryBrowser({ host, onAdded }: { host: Host; onAdded: (s: VoiceState) => void }) {
  const [filters, setFilters] = useState({ search: "", gender: "", age: "", accent: "", use_case: "" });
  const [voices, setVoices] = useState<LibraryVoice[] | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { play, playing } = usePlayer();

  const load = useCallback(
    async (p = 0) => {
      setError(null);
      try {
        const res = await voiceApi.library({ ...filters, page: p });
        setVoices((cur) => (p ? [...(cur ?? []), ...res.voices] : res.voices));
        setHasMore(res.has_more);
        setPage(p);
      } catch (e) {
        setError(errorMessage(e));
        setVoices([]);
      }
    },
    [filters],
  );

  useEffect(() => {
    const t = setTimeout(() => load(0), 250);
    return () => clearTimeout(t);
  }, [load]);

  const select = (key: keyof typeof filters, options: [string, string][]) => (
    <select className="input input-sm" value={filters[key]} onChange={(e) => setFilters({ ...filters, [key]: e.target.value })} aria-label={key}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <div className="stack">
        <p className="muted small">
          Voices from the ElevenLabs Voice Library, licensed for commercial use on paid ElevenLabs plans. Adding one puts it in your ElevenLabs account.
        </p>
        <div className="library-filters">
          <input className="input input-sm" placeholder="Search: calm narrator, british, podcast" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} aria-label="Search voices" />
          {select("gender", [["", "Any gender"], ["female", "Female"], ["male", "Male"], ["neutral", "Neutral"]])}
          {select("age", [["", "Any age"], ["young", "Young"], ["middle_aged", "Middle aged"], ["old", "Older"]])}
          {select("accent", [["", "Any accent"], ["american", "American"], ["british", "British"], ["australian", "Australian"], ["irish", "Irish"], ["indian", "Indian"], ["african", "African"]])}
          {select("use_case", [["", "Any use"], ["conversational", "Conversational"], ["narrative_story", "Narration"], ["informative_educational", "Educational"], ["social_media", "Social media"], ["entertainment_tv", "Entertainment"]])}
        </div>
        {error && <p className="error-text">{error}</p>}
        {!voices && <Loading label="Searching voices" />}
        <ul className="library-grid">
          {voices?.map((v) => (
            <li key={`${v.public_owner_id}-${v.voice_id}`} className="library-voice">
              <div className="row between">
                <strong>{v.name}</strong>
                {v.preview_url && (
                  <button className="btn btn-small" onClick={() => play(v.preview_url!, v.voice_id)} aria-label={`Play ${v.name}`}>
                    {playing === v.voice_id ? "Stop" : "Play"}
                  </button>
                )}
              </div>
              <p className="mono muted small">{[v.gender, v.age?.replace("_", " "), v.accent, v.use_case?.replace(/_/g, " ")].filter(Boolean).join(" · ")}</p>
              {v.description && <p className="muted small clamp-3">{v.description}</p>}
              {v.notice_period ? <p className="mono muted small">Owner notice period: {v.notice_period} days</p> : null}
              <button
                className="btn btn-small btn-primary"
                disabled={adding !== null}
                onClick={async () => {
                  setAdding(v.voice_id);
                  setError(null);
                  try {
                    onAdded(await voiceApi.addFromLibrary(v, host));
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setAdding(null);
                  }
                }}
              >
                {adding === v.voice_id ? "Adding..." : `Use as ${host === "host_a" ? "Host A" : "Host B"}`}
              </button>
            </li>
          ))}
          {voices?.length === 0 && !error && <li className="muted">No voices match those filters.</li>}
        </ul>
        {hasMore && (
          <button className="btn" onClick={() => load(page + 1)}>
            More voices
          </button>
        )}
      </div>
    </>
  );
}

// Managing a host's voices: add one from the library, or make your own

type ManageTab = "library" | "add";

function ManageHostVoicesModal({
  host,
  state,
  onClose,
  onSaved,
  onClone,
}: {
  host: Host;
  state: VoiceState;
  onClose: () => void;
  onSaved: (s: VoiceState) => void;
  onClone: () => void;
}) {
  const [tab, setTab] = useState<ManageTab>("library");
  const { openUpgrade } = useUpgrade();

  return (
    <Modal title={`Voices for ${host === "host_a" ? "Host A" : "Host B"}`} onClose={onClose} wide>
      <div className="stack">
        <Tabs<ManageTab>
          tabs={[
            { id: "library", label: "Voice library" },
            { id: "add", label: "Add your voice" },
          ]}
          value={tab}
          onChange={setTab}
        />
        {/* Either way the voice is set for this host and shows in the rows, so the modal closes */}
        {tab === "library" && <LibraryBrowser host={host} onAdded={(s) => { onSaved(s); onClose(); }} />}
        {tab === "add" && (
          <GenerateVoicePanel host={host} state={state} onSaved={(s) => onSaved(s)} onDone={onClose}
                              onClone={() => (state.clone.allowed ? onClone() : openUpgrade("writer"))} />
        )}
      </div>
    </Modal>
  );
}

// Cloning

type Take = { file: File; url: string; seconds: number };

function Recorder({ onTake }: { onTake: (t: Take) => void }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<number>();
  const raf = useRef<number>();

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      const ac = new AudioContext();
      const analyser = ac.createAnalyser();
      ac.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const meter = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const b of buf) peak = Math.max(peak, Math.abs(b - 128));
        setLevel(peak / 128);
        raf.current = requestAnimationFrame(meter);
      };
      meter();
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream);
      const started = Date.now();
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        cancelAnimationFrame(raf.current!);
        void ac.close();
        const type = mr.mimeType.split(";")[0] || "audio/webm";
        const file = new File(chunks, `take-${Date.now()}.${type.includes("mp4") ? "m4a" : "webm"}`, { type });
        onTake({ file, url: URL.createObjectURL(file), seconds: (Date.now() - started) / 1000 });
        setLevel(0);
      };
      mr.start();
      rec.current = mr;
      setRecording(true);
      setSeconds(0);
      timer.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      setError("Microphone access was blocked. You can upload recordings instead.");
    }
  };
  const stop = () => {
    rec.current?.stop();
    window.clearInterval(timer.current);
    setRecording(false);
  };

  return (
    <div className="stack">
      <div className="row">
        {recording ? (
          <button type="button" className="btn btn-danger armed" onClick={stop}>
            Stop take ({fmtSeconds(seconds)})
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={start}>
            Record a take
          </button>
        )}
        {recording && (
          <div className="level" aria-label="Input level">
            <div className="level-fill" style={{ width: `${Math.min(100, level * 160)}%` }} />
          </div>
        )}
      </div>
      {recording && level < 0.04 && seconds > 2 && <p className="muted small">We can barely hear you. Move closer to the microphone.</p>}
      {level > 0.95 && <p className="muted small">Too loud: back off a little so it does not clip.</p>}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function CloneModal({ state, onClose, onDone }: { state: VoiceState; onClose: () => void; onDone: (job: Job) => void }) {
  const [script, setScript] = useState<{ title: string; text: string } | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [agreed, setAgreed] = useState(false);
  const [denoise, setDenoise] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = takes.reduce((n, t) => n + t.seconds, 0);

  useEffect(() => {
    voiceApi.readingScript().then(setScript, () => setScript(null));
  }, []);

  const addFiles = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const url = URL.createObjectURL(file);
      const probe = new Audio(url);
      probe.onloadedmetadata = () =>
        setTakes((t) => [...t, { file, url, seconds: Number.isFinite(probe.duration) ? probe.duration : 60 }]);
    }
  };

  const quality = total < 30 ? "Too short: record at least 30 seconds" : total < 60 ? "Usable, but 1 to 3 minutes sounds much better" : total <= 300 ? "Great length" : "Plenty: more than 5 minutes adds little";

  return (
    <Modal title="Clone your voice" onClose={onClose} wide>
      <div className="stack">
        <ol className="clone-tips muted small">
          <li>Quiet room, no music, phone on silent. Keep the same distance from the mic.</li>
          <li>Read naturally, the way you would on a podcast. Pauses are fine.</li>
          <li>Record in one or more takes: 1 to 3 minutes in total works best.</li>
        </ol>
        {script && (
          <div className="reading-script">
            <p className="eyebrow">Read this, from "{script.title}"</p>
            {script.text.split(/\n\n+/).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        )}
        <Recorder onTake={(t) => setTakes((list) => [...list, t])} />
        <label className="field">
          <span>Or upload recordings (mp3, m4a, wav, webm)</span>
          <input className="input file-input" type="file" accept="audio/*" multiple onChange={(e) => addFiles(e.target.files)} />
        </label>
        {takes.length > 0 && (
          <ul className="takes">
            {takes.map((t, i) => (
              <li key={t.url} className="row">
                <span className="mono muted">Take {i + 1} · {fmtSeconds(t.seconds)}</span>
                <audio controls src={t.url} className="player take-player" />
                <button className="icon-btn" aria-label={`Remove take ${i + 1}`} onClick={() => setTakes(takes.filter((x) => x !== t))}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="meter">
          <div className="row between">
            <span>Total {fmtSeconds(total)}</span>
            <span className="mono muted small">{takes.length ? quality : "No takes yet"}</span>
          </div>
          <div className="ascent-track">
            <div className="ascent-fill" style={{ width: `${Math.min(100, (total / 180) * 100)}%` }} />
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={denoise} onChange={(e) => setDenoise(e.target.checked)} />
          Remove background noise (turn off for studio quality recordings)
        </label>
        <blockquote className="consent">{state.clone.consent_text}</blockquote>
        <label className="check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />I agree to the statement above, and this is my own voice.
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!takes.length || total < 10 || !agreed || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const res = await voiceApi.consent(takes.map((t) => t.file), state.clone.consent_text, denoise);
                onDone(res.job);
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Uploading..." : "Create my voice"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// The page: two steps. The writing voice builds itself, then the writer picks the two hosts.
// Cloning lives in the "+ Add a voice" menu; a clone's status shows under the voice cards.

type Step = "writing" | "hosts";

const STEPS: { id: Step; label: string }[] = [
  { id: "writing", label: "Writing voice" },
  { id: "hosts", label: "Speaking voices" },
];

export default function VoiceProfile() {
  const [state, setState] = useState<VoiceState | null>(null);
  const [draft, setDraft] = useState<VoiceProfileData | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [params] = useSearchParams();
  // ?step=hosts opens Speaking voices (the old Videos > Voices link lands there, on the video voices).
  const [step, setStep] = useState<Step | null>(params.get("step") === "hosts" ? "hosts" : null);
  const [picking, setPicking] = useState(false);
  const [samples, setSamples] = useState<string[]>([]);
  const [buildJob, setBuildJob] = useState<Job | null>(null);
  const [cloneJob, setCloneJob] = useState<Job | null>(null);
  const [cloning, setCloning] = useState(false);
  const [managing, setManaging] = useState<Host | null>(null);
  // The Speaking voices card's two tabs. #video-voices (the old Videos > Voices link) opens the video one.
  const [speakTab, setSpeakTab] = useState<"hosts" | "video">(
    typeof window !== "undefined" && window.location.hash === "#video-voices" ? "video" : "hosts",
  );
  const [videoKey, setVideoKey] = useState(0);
  const { openUpgrade } = useUpgrade();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoBuilt = useRef(false);
  const { play, playing } = usePlayer();

  const load = () =>
    voiceApi.get().then((s) => {
      setState(s);
      setDraft(s.profile);
      setSamples(s.sample_doc_ids);
      setStep((cur) => cur ?? (s.profile ? "hosts" : "writing"));
      return s;
    });
  const loadVoices = () => voiceApi.voices().then(setVoices, () => setVoices([]));

  const startBuild = async (ids: string[]) => {
    setPicking(false);
    setError(null);
    try {
      setBuildJob(await voiceApi.build(ids));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    // No writing voice yet: build one from the longest posts straight away instead of asking.
    load().then((s) => {
      if (!s.profile && !autoBuilt.current) {
        autoBuilt.current = true;
        void startBuild([]);
      }
    });
    loadVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const build = useJob(buildJob, () => load());
  const clone = useJob(cloneJob, () => {
    load();
    loadVoices();
    setVideoKey((k) => k + 1); // a new clone shows up under video voiceovers' Your voices
  });

  if (!state || !step) return <Loading />;
  const building = build && (build.status === "queued" || build.status === "running");
  const cloneRunning = clone && (clone.status === "queued" || clone.status === "running");
  const done: Record<Step, boolean> = { writing: Boolean(state.profile), hosts: Boolean(state.profile) && step === "hosts" };
  const showClone = state.clone.status !== "none" || Boolean(clone);

  const saveProfile = async () => {
    setError(null);
    try {
      setState(await voiceApi.update({ profile: draft! }));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="page-wrap vp">
      <PageHeader eyebrow="Voice profile" title="How you sound, on the page and out loud" />

      <ol className="vp-steps mono" aria-label="Voice profile steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={s.id === step ? "current" : done[s.id] ? "done" : ""}>
            <button type="button" onClick={() => setStep(s.id)} aria-current={s.id === step ? "step" : undefined}>
              <span className="vp-dot" />
              <span>
                {i + 1}. {s.label}
                {done[s.id] && s.id !== step ? " ✓" : ""}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {error && <p className="error-text">{error}</p>}

      {step === "writing" && (
        <section className="card stack vp-card">
          <h2>How you write</h2>
          <p className="muted">Launch Kits, carousels, hooks and scripts are all written in this voice, so they read like you wrote them.</p>
          {build && (building || build.status === "failed") && <JobProgress job={build} />}
          {!draft && !building && (
            <div className="row">
              <button className="btn btn-primary" onClick={() => startBuild([])}>
                Build my writing voice
              </button>
              <button className="link-btn small" onClick={() => setPicking(true)}>
                or pick the posts yourself
              </button>
            </div>
          )}

          {draft && (
            <>
              <label className="field">
                <span>In a sentence, you sound like this</span>
                <textarea className="textarea" rows={7} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
              </label>
              <details className="delivery">
                <summary className="mono muted small">Fine-tune tone, phrases and habits</summary>
                <label className="field">
                  <span>Sentence length</span>
                  <select className="input input-sm" value={draft.sentence_length} onChange={(e) => setDraft({ ...draft, sentence_length: e.target.value as VoiceProfileData["sentence_length"] })}>
                    {["short", "medium", "long", "varied"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                {LIST_FIELDS.map((f) => (
                  <label key={f.key} className="field">
                    <span>{f.label}</span>
                    <input
                      className="input input-sm"
                      placeholder={f.hint}
                      value={(draft[f.key] as string[]).join(", ")}
                      onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                    />
                  </label>
                ))}
              </details>
              <p className="mono muted small">
                Built {formatDate(state.updated_at, true)} from {state.sample_doc_ids.length} posts ·{" "}
                <button className="link-btn small" disabled={Boolean(building)} onClick={() => setPicking(true)}>
                  Rebuild from other posts
                </button>
              </p>
              <div className="row end">
                <button className="btn btn-small" onClick={saveProfile}>
                  {saved ? "Saved" : "Save changes"}
                </button>
                <button className="btn btn-primary" onClick={() => setStep("hosts")}>
                  Next: pick your hosts
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {step === "hosts" && (
        <section className="card stack vp-card">
          <h2>Who reads your work aloud</h2>
          <Tabs<"hosts" | "video">
            tabs={[
              { id: "hosts", label: "Hosts Audios" },
              { id: "video", label: "Video voiceovers" },
            ]}
            value={speakTab}
            onChange={setSpeakTab}
          />
          {speakTab === "video" && (
            <VideoVoicesSection reloadKey={videoKey}
                                renderAddVoice={(onDone, close) => (
                                  <GenerateVoicePanel
                                    host={null}
                                    state={state}
                                    onDone={onDone}
                                    onSaved={(s, voiceId) => {
                                      setState(s);
                                      loadVoices();
                                      // Made for video voiceovers: added there straight away (room and plan permitting).
                                      videoVoicesApi.save(voiceId)
                                        .catch((e) => setError(`Saved to your voices, not added to video voiceovers: ${errorMessage(e)}`))
                                        .finally(() => setVideoKey((k) => k + 1));
                                    }}
                                    onClone={() => {
                                      close(); // the recorder opens in its own modal
                                      if (state.clone.allowed) setCloning(true);
                                      else openUpgrade("writer");
                                    }}
                                  />
                                )} />
          )}
          {speakTab === "hosts" && (
          <>
          {!state.tts_configured && <p className="muted">Voice previews are unavailable right now.</p>}
          <VoicePicker state={state} voices={voices} onSaved={setState} onManage={setManaging} />

          {showClone && (
            <div className="vp-clone">
              <strong>Your cloned voice</strong>
              {clone && (cloneRunning || clone.status === "failed") && <JobProgress job={clone} compact />}
              {state.clone.status === "processing" && !clone && <p className="muted small">Your voice is being created. It becomes Host A when ready.</p>}
              {state.clone.status === "failed" && state.clone.error && !cloneRunning && <p className="error-text">{state.clone.error}</p>}
              <div className="row">
                {state.clone.status === "ready" && state.clone.preview_url && (
                  <button className="btn btn-small" onClick={() => play(state.clone.preview_url!, "clone")}>
                    {playing === "clone" ? "Stop" : "Hear my voice"}
                  </button>
                )}
                {!cloneRunning && state.clone.allowed && (
                  <button className="btn btn-small" onClick={() => setCloning(true)}>
                    {state.clone.status === "failed" ? "Try again" : "Record again"}
                  </button>
                )}
                {state.clone.status !== "none" && (
                  <ConfirmButton
                    confirmLabel="Revoke and delete my voice?"
                    onConfirm={async () => {
                      setState(await voiceApi.revoke());
                      loadVoices();
                    }}
                  >
                    Revoke consent
                  </ConfirmButton>
                )}
              </div>
            </div>
          )}

          </>
          )}

          <div className="row">
            <button className="back-link" onClick={() => setStep("writing")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19 12H5m6-6-6 6 6 6" />
              </svg>
              Back to writing voice
            </button>
          </div>
        </section>
      )}

      {picking && (
        <Modal title="Pick 5 to 10 posts that sound most like you" onClose={() => setPicking(false)} wide>
          <DocPicker selected={samples} onChange={setSamples} max={10} />
          <p className="muted small">Leave empty to let Notestack pick your longest posts.</p>
          <div className="row end">
            <button className="btn btn-primary" onClick={() => startBuild(samples)}>
              Build profile
            </button>
          </div>
        </Modal>
      )}
      {cloning && <CloneModal state={state} onClose={() => setCloning(false)} onDone={setCloneJob} />}
      {managing && (
        <ManageHostVoicesModal
          host={managing}
          state={state}
          onClose={() => setManaging(null)}
          onSaved={(s) => {
            setState(s);
            loadVoices();
          }}
          onClone={() => {
            setCloning(true);
            setManaging(null);
          }}
        />
      )}
    </div>
  );
}

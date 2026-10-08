import { useCallback, useEffect, useRef, useState } from "react";
import { voiceApi } from "../api/endpoints";
import type { Job, VoiceDesignInput, VoiceDesignPreview, VoiceState } from "../api/types";
import { YourVoices } from "../components/voice/YourVoices";
import { ConfirmButton, errorMessage, JobProgress, Loading, Modal, Tabs } from "../components/ui";
import { useJob } from "../hooks/useJob";
import { useUpgrade } from "../hooks/useUpgrade";

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
  state,
  onDone,
  onSaved,
  onClone,
}: {
  state: VoiceState;
  /** Saved: the caller closes or switches away. */
  onDone: () => void;
  onSaved: (s: VoiceState, voiceId: string) => void;
  onClone: () => void;
}) {
  const [mode, setMode] = useState<GenMode>("prompt"); // Describe it first
  const [opts, setOpts] = useState<VoiceDesignInput>({ gender: "female", age: "middle-aged", persona: "warm", pace: "measured", accent: "American" });
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<{ description: string; previews: VoiceDesignPreview[] } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"generate" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { play, playing } = usePlayer();
  const { openUpgrade } = useUpgrade();

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
      const saved = await voiceApi.saveDesign({ generated_voice_id: picked, name: name.trim(), description: result.description });
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
            { id: "prompt", label: "Describe it" },
            { id: "clone", label: "Clone my voice" },
            { id: "options", label: "Build from options" },
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
                <span className="gen-label">{g.label}</span>
                <div className="gen-chips" role="group" aria-label={g.label}>
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
              <p className="muted">Read a passage from your own writing for one to three minutes. Your voice joins your voices, ready for audio overviews and videos.</p>
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
                {busy === "save" ? "Saving..." : "Save voice"}
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

// The page: the speaking voices (who reads audio and video aloud). Cloning lives in the "+ Add a voice" menu; a
// clone's status shows under the voice cards. The writing voice is built by the server on import and not shown here.

export default function VoiceProfile() {
  const [state, setState] = useState<VoiceState | null>(null);
  const [cloneJob, setCloneJob] = useState<Job | null>(null);
  const [cloning, setCloning] = useState(false);
  const [adding, setAdding] = useState(false); // the Add voices modal
  const [voicesKey, setVoicesKey] = useState(0); // bumped when a voice was made, so Your voices reloads
  const { openUpgrade } = useUpgrade();
  const [error, setError] = useState<string | null>(null);
  const { play, playing } = usePlayer();

  const load = () => voiceApi.get().then(setState, (e) => setError(errorMessage(e)));
  const loadVoices = () => setVoicesKey((k) => k + 1);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clone = useJob(cloneJob, () => {
    load();
    loadVoices(); // a finished clone is saved to Your voices as "My voice"
  });

  if (!state) return <div className="loading-center"><Loading label="Loading your voice" /></div>;
  const cloneRunning = clone && (clone.status === "queued" || clone.status === "running");
  const showClone = state.clone.status !== "none" || Boolean(clone);

  return (
    // Manage voices (/app/voices): the speaking voices.
    <div className="stack vp">
      {error && <p className="error-text">{error}</p>}

      <section className="card stack vp-card">
        <h2>Who reads your work aloud</h2>
        {!state.tts_configured && <p className="muted">Voice previews are unavailable right now.</p>}
        <YourVoices reloadKey={voicesKey} onAdd={() => setAdding(true)} />

        {showClone && (
          <div className="vp-clone">
            <strong>Your cloned voice</strong>
            {clone && (cloneRunning || clone.status === "failed") && <JobProgress job={clone} compact />}
            {state.clone.status === "processing" && !clone && <p className="muted small">Your voice is being created. It joins your voices when ready.</p>}
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
      </section>

      {cloning && <CloneModal state={state} onClose={() => setCloning(false)} onDone={setCloneJob} />}
      {adding && (
        <Modal title="Add voices" onClose={() => setAdding(false)} wide>
          <GenerateVoicePanel
            state={state}
            onDone={() => setAdding(false)}
            onSaved={(s) => {
              setState(s);
              loadVoices(); // the server saved it to Your voices
            }}
            onClone={() => {
              setAdding(false); // the recorder opens in its own modal
              if (state.clone.allowed) setCloning(true);
              else openUpgrade("writer");
            }}
          />
        </Modal>
      )}
    </div>
  );
}

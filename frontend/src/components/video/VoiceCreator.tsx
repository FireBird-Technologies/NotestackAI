import { useState } from "react";
import { videoVoicesApi } from "../../api/endpoints";
import type { VideoCustomVoice, VideoDesignedVoice } from "../../api/types";
import { errorMessage, Modal, Tabs } from "../ui";
import { PlayButton, useAudio } from "./parts";

type Mode = "prompt" | "preset" | "clone";

const AGES = ["Young", "Middle aged", "Old"];
const SPEEDS = ["Slow", "Normal", "Fast"];
const GENDERS = ["Female", "Male", "Neutral"];

/** ★ Design a voice from a description or options, or clone one from a recording. Made voices are added to
 *  "My voices" and can be used on any video in this workspace (and only this workspace). */
export function VoiceCreator({ onClose, onCreated }: { onClose: () => void; onCreated: (v: VideoCustomVoice) => void }) {
  const [mode, setMode] = useState<Mode>("prompt");
  const [prompt, setPrompt] = useState("");
  const [preset, setPreset] = useState({ gender: "Female", age: "Middle aged", persona: "", speed: "Normal", accent: "" });
  const [previews, setPreviews] = useState<VideoDesignedVoice[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [denoise, setDenoise] = useState(true);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { playing, play } = useAudio();

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function design() {
    setPreviews(null);
    setPicked(null);
    const res = await run(() => (mode === "prompt" ? videoVoicesApi.designFromPrompt(prompt.trim())
      : videoVoicesApi.designFromPreset({ ...preset, gender: preset.gender.toLowerCase(), age: preset.age.toLowerCase(),
                                          speed: preset.speed.toLowerCase() })));
    if (res) {
      setPreviews(res.previews);
      setPicked(res.previews[0]?.generated_voice_id ?? null);
    }
  }

  async function keep() {
    if (!picked) return;
    const made = await run(() => videoVoicesApi.keep({ generated_voice_id: picked, source: mode === "preset" ? "preset" : "prompt",
                                                      name: name.trim(), prompt_text: mode === "prompt" ? prompt.trim() : undefined }));
    if (made) onCreated(made);
  }

  async function clone() {
    if (!file) return;
    const made = await run(() => videoVoicesApi.clone(name.trim(), file, denoise));
    if (made) onCreated(made);
  }

  return (
    <Modal title="Create a voice" onClose={onClose} wide>
      <div className="stack">
        <Tabs<Mode> tabs={[{ id: "prompt", label: "Describe it" }, { id: "preset", label: "Pick options" }, { id: "clone", label: "Clone a voice" }]}
                    value={mode} onChange={(m) => { setMode(m); setPreviews(null); setError(null); }} />

        {mode === "prompt" && (
          <label className="field">
            <span className="vw-label">Describe the voice</span>
            <textarea className="input" rows={3} maxLength={1000} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                      placeholder="A warm, confident female narrator in her 30s with a light British accent, calm and clear." />
            <small className="muted">{prompt.trim().length < 20 ? `At least 20 characters (${prompt.trim().length})` : `${prompt.length}/1000`}</small>
          </label>
        )}

        {mode === "preset" && (
          <div className="vw-grid2">
            {([["gender", "Gender", GENDERS], ["age", "Age", AGES], ["speed", "Speaking speed", SPEEDS]] as const).map(([key, label, options]) => (
              <label key={key} className="field">
                <span className="vw-label">{label}</span>
                <select className="input" value={preset[key]} onChange={(e) => setPreset({ ...preset, [key]: e.target.value })}>
                  {options.map((o) => <option key={o}>{o}</option>)}
                </select>
              </label>
            ))}
            <label className="field">
              <span className="vw-label">Accent (country)</span>
              <input className="input" value={preset.accent} placeholder="e.g. Ireland" maxLength={60}
                     onChange={(e) => setPreset({ ...preset, accent: e.target.value })} />
            </label>
            <label className="field vw-span2">
              <span className="vw-label">Persona</span>
              <input className="input" value={preset.persona} placeholder="e.g. a friendly teacher" maxLength={100}
                     onChange={(e) => setPreset({ ...preset, persona: e.target.value })} />
            </label>
          </div>
        )}

        {mode !== "clone" && (
          <>
            <div className="row">
              <button className="btn" onClick={design} disabled={busy || (mode === "prompt" && prompt.trim().length < 20)}>
                {busy && !previews ? "Designing..." : previews ? "Design again" : "Design voice"}
              </button>
              <small className="muted">Each design uses one of today's voice designs.</small>
            </div>
            {previews && (
              <div className="vw-voice-list" role="radiogroup" aria-label="Designed voices">
                {previews.length === 0 && <p className="muted">No previews came back. Try a different description.</p>}
                {previews.map((p, i) => (
                  <div key={p.generated_voice_id} className={`vw-vrow${picked === p.generated_voice_id ? " on" : ""}`}>
                    <PlayButton on={playing === p.generated_voice_id} label={`option ${i + 1}`}
                                onClick={() => play(p.generated_voice_id, p.audio_base_64)} />
                    <button type="button" role="radio" aria-checked={picked === p.generated_voice_id} className="vw-vpick"
                            onClick={() => setPicked(p.generated_voice_id)}>
                      <strong>Option {i + 1}</strong>
                      <span className="muted">{Math.round(p.duration_secs)} sec sample</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {mode === "clone" && (
          <>
            <label className="field">
              <span className="vw-label">Recording</span>
              <input className="input" type="file" accept="audio/*,video/mp4,video/webm,video/quicktime"
                     onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <small className="muted">One audio or video file, up to 50 MB. A minute or more of clear speech works best.</small>
            </label>
            <label className="vw-option">
              <input type="checkbox" checked={denoise} onChange={(e) => setDenoise(e.target.checked)} />
              Remove background noise
            </label>
            <label className="vw-option">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              This is my voice, or I have the speaker's permission to clone it.
            </label>
          </>
        )}

        {(previews?.length || mode === "clone") && (
          <label className="field">
            <span className="vw-label">Name</span>
            <input className="input" value={name} maxLength={100} placeholder="e.g. My narrator" onChange={(e) => setName(e.target.value)} />
          </label>
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="vw-nav">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          {mode === "clone" ? (
            <button className="btn btn-primary" onClick={clone} disabled={busy || !file || !consent || !name.trim()}>
              {busy ? "Cloning..." : "Clone voice"}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={keep} disabled={busy || !picked || !name.trim()}>
              {busy && previews ? "Saving..." : "Keep this voice"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

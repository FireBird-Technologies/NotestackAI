import { useEffect, useRef, useState } from "react";
import { voiceApi } from "../api/endpoints";
import type { Job, Voice, VoiceProfileData, VoiceState } from "../api/types";
import { DocPicker } from "../components/DocPicker";
import { ConfirmButton, errorMessage, formatDate, JobProgress, Loading, Modal, PageHeader } from "../components/ui";
import { useJob } from "../hooks/useJob";

const LIST_FIELDS: { key: keyof VoiceProfileData; label: string; hint: string }[] = [
  { key: "tone", label: "Tone", hint: "warm, wry, direct" },
  { key: "vocabulary", label: "Signature words and phrases", hint: "readers, the long game" },
  { key: "structure_habits", label: "Structure habits", hint: "short paragraphs, one idea each" },
  { key: "openings", label: "How pieces open", hint: "a number, a small scene" },
  { key: "avoid", label: "Never does", hint: "jargon, hashtags" },
];

function Recorder({ onFile }: { onFile: (f: File) => void }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<number>();

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = mr.mimeType.split(";")[0] || "audio/webm";
        onFile(new File(chunks, `voice-sample.${type.includes("mp4") ? "m4a" : "webm"}`, { type }));
      };
      mr.start();
      rec.current = mr;
      setRecording(true);
      setSeconds(0);
      timer.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      setError("Microphone access was blocked. You can upload a recording instead.");
    }
  };
  const stop = () => {
    rec.current?.stop();
    window.clearInterval(timer.current);
    setRecording(false);
  };

  return (
    <div className="row">
      {recording ? (
        <button type="button" className="btn btn-danger" onClick={stop}>
          Stop recording ({seconds}s)
        </button>
      ) : (
        <button type="button" className="btn" onClick={start}>
          Record a sample
        </button>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

function CloneModal({ state, onClose, onDone }: { state: VoiceState; onClose: () => void; onDone: (job: Job) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = file ? URL.createObjectURL(file) : null;
  return (
    <Modal title="Clone your voice" onClose={onClose}>
      <div className="stack">
        <p className="muted">
          Read one of your posts aloud for one to three minutes in a quiet room. The clone is used only for audio and video in this workspace.
        </p>
        <Recorder onFile={setFile} />
        <label className="field">
          <span>Or upload a recording</span>
          <input className="input file-input" type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {preview && <audio controls src={preview} className="player" />}
        <blockquote className="consent">{state.clone.consent_text}</blockquote>
        <label className="check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />I agree to the statement above.
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!file || !agreed || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const res = await voiceApi.consent(file!, state.clone.consent_text);
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

export default function VoiceProfile() {
  const [state, setState] = useState<VoiceState | null>(null);
  const [draft, setDraft] = useState<VoiceProfileData | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [picking, setPicking] = useState(false);
  const [samples, setSamples] = useState<string[]>([]);
  const [buildJob, setBuildJob] = useState<Job | null>(null);
  const [cloneJob, setCloneJob] = useState<Job | null>(null);
  const [cloning, setCloning] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    voiceApi.get().then((s) => {
      setState(s);
      setDraft(s.profile);
      setSamples(s.sample_doc_ids);
    });

  useEffect(() => {
    load();
    voiceApi.voices().then(setVoices, () => setVoices([]));
  }, []);

  const build = useJob(buildJob, () => load());
  const clone = useJob(cloneJob, () => {
    load();
    voiceApi.voices().then(setVoices);
  });

  if (!state) return <Loading />;
  const building = build && (build.status === "queued" || build.status === "running");

  const save = async (patch: Parameters<typeof voiceApi.update>[0]) => {
    setError(null);
    try {
      const s = await voiceApi.update(patch);
      setState(s);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Voice profile" title="How you sound on the page">
        <button className="btn btn-primary" disabled={Boolean(building)} onClick={() => setPicking(true)}>
          {state.profile ? "Rebuild from posts" : "Build my voice profile"}
        </button>
      </PageHeader>
      <p className="muted lede">
        Launch Kits, carousels, hooks and scripts are written in this voice. Edit anything that does not sound like you.
      </p>
      {build && (building || build.status === "failed") && <JobProgress job={build} />}
      {error && <p className="error-text">{error}</p>}

      <div className="two-col">
        <section className="card stack">
          <h2>Writing voice</h2>
          {!draft && <p className="muted">No profile yet. Build one from 5 to 10 posts that feel most like you.</p>}
          {draft && (
            <>
              <label className="field">
                <span>Summary</span>
                <textarea className="textarea" rows={3} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
              </label>
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
              <div className="row between">
                <span className="mono muted">Built {formatDate(state.updated_at, true)} from {state.sample_doc_ids.length} posts</span>
                <button className="btn btn-primary btn-small" onClick={() => save({ profile: draft })}>
                  {saved ? "Saved" : "Save changes"}
                </button>
              </div>
            </>
          )}
        </section>

        <section className="card stack">
          <h2>Speaking voices</h2>
          {!state.tts_configured && <p className="muted">Set ELEVENLABS_API_KEY in .env to generate audio.</p>}
          {(["host_a", "host_b"] as const).map((host) => (
            <label key={host} className="field">
              <span>{host === "host_a" ? "Host A (leads, narrates videos)" : "Host B"}</span>
              <div className="row">
                <select
                  className="input input-sm"
                  value={state.host_voices[host]}
                  onChange={(e) => save({ host_voices: { ...state.host_voices, [host]: e.target.value } })}
                >
                  {voices.map((v) => (
                    <option key={v.voice_id} value={v.voice_id}>
                      {v.name}
                      {v.category ? ` (${v.category})` : ""}
                    </option>
                  ))}
                  {!voices.some((v) => v.voice_id === state.host_voices[host]) && <option value={state.host_voices[host]}>Current voice</option>}
                </select>
                {voices.find((v) => v.voice_id === state.host_voices[host])?.preview_url && (
                  <button type="button" className="btn btn-small" onClick={() => new Audio(voices.find((v) => v.voice_id === state.host_voices[host])!.preview_url!).play()}>
                    Preview
                  </button>
                )}
              </div>
            </label>
          ))}

          <h3>Your own voice</h3>
          {!state.clone.allowed && <p className="muted">Voice cloning is on the Writer and Studio plans.</p>}
          {state.clone.allowed && state.clone.status === "none" && (
            <>
              <p className="muted">Clone your voice with a short recording and your consent. You can revoke it anytime.</p>
              <button className="btn" onClick={() => setCloning(true)} disabled={!state.tts_configured}>
                Clone my voice
              </button>
            </>
          )}
          {clone && (clone.status === "queued" || clone.status === "running" || clone.status === "failed") && <JobProgress job={clone} compact />}
          {state.clone.status === "processing" && !clone && <p className="muted">Your voice is being created.</p>}
          {state.clone.status === "ready" && (
            <>
              <p className="muted">Your cloned voice is ready. Pick "My voice" above to use it as a host.</p>
              <ConfirmButton
                confirmLabel="Revoke and delete my voice?"
                onConfirm={async () => {
                  setState(await voiceApi.revoke());
                  voiceApi.voices().then(setVoices);
                }}
              >
                Revoke consent
              </ConfirmButton>
            </>
          )}
        </section>
      </div>

      {picking && (
        <Modal title="Pick 5 to 10 posts that sound most like you" onClose={() => setPicking(false)} wide>
          <DocPicker selected={samples} onChange={setSamples} max={10} />
          <p className="muted small">Leave empty to let Notestack pick your longest posts.</p>
          <div className="row end">
            <button
              className="btn btn-primary"
              onClick={async () => {
                setPicking(false);
                try {
                  setBuildJob(await voiceApi.build(samples));
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            >
              Build profile
            </button>
          </div>
        </Modal>
      )}
      {cloning && <CloneModal state={state} onClose={() => setCloning(false)} onDone={setCloneJob} />}
    </div>
  );
}

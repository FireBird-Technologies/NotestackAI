import { useCallback, useEffect, useRef, useState } from "react";
import { voiceApi } from "../api/endpoints";
import type { Delivery, Job, LibraryVoice, Quota, Voice, VoiceProfileData, VoiceState } from "../api/types";
import { DocPicker } from "../components/DocPicker";
import { ConfirmButton, errorMessage, formatDate, JobProgress, Loading, Modal, PageHeader } from "../components/ui";
import { useJob } from "../hooks/useJob";

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

const HOST_LABEL: Record<Host, string> = { host_a: "Host A, leads and narrates videos", host_b: "Host B, the co-host" };

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

function HostCard({
  host,
  state,
  voices,
  onSaved,
  onBrowse,
}: {
  host: Host;
  state: VoiceState;
  voices: Voice[];
  onSaved: (s: VoiceState) => void;
  onBrowse: (host: Host) => void;
}) {
  const [delivery, setDelivery] = useState<Delivery>(state.delivery[host]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const { play, playing } = usePlayer();
  const current = state.host_voices[host];
  const groups = voices.reduce<Record<string, Voice[]>>((acc, v) => {
    const k = v.category ?? "other";
    (acc[k] ??= []).push(v);
    return acc;
  }, {});

  useEffect(() => {
    setDelivery(state.delivery[host]);
    setDirty(false);
  }, [state.delivery, host]);

  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await voiceApi.preview(current, { delivery });
      play(url, "preview");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="host-card">
      <div className="row between">
        <strong>{HOST_LABEL[host]}</strong>
        <button className="link-btn small" onClick={() => onBrowse(host)}>
          Browse voice library
        </button>
      </div>
      <div className="row">
        <select
          className="input input-sm"
          value={current}
          onChange={async (e) => onSaved(await voiceApi.update({ host_voices: { [host]: e.target.value } }))}
          aria-label={`${HOST_LABEL[host]} voice`}
        >
          {Object.entries(groups).map(([cat, list]) => (
            <optgroup key={cat} label={cat}>
              {list.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name}
                  {v.labels?.accent ? `, ${v.labels.accent}` : ""}
                  {v.labels?.gender ? `, ${v.labels.gender}` : ""}
                </option>
              ))}
            </optgroup>
          ))}
          {!voices.some((v) => v.voice_id === current) && <option value={current}>Current voice</option>}
        </select>
        <button className="btn btn-small" onClick={preview} disabled={busy || !state.tts_configured}>
          {busy ? "Rendering..." : playing ? "Stop" : "Preview"}
        </button>
      </div>
      <details className="delivery">
        <summary className="mono muted small">Delivery settings</summary>
        {SLIDERS.map((s) => (
          <label key={s.key} className="slider" title={s.hint}>
            <span className="row between">
              <span>{s.label}</span>
              <span className="mono muted">{Number(delivery[s.key]).toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={Number(delivery[s.key])}
              onChange={(e) => {
                setDelivery({ ...delivery, [s.key]: Number(e.target.value) });
                setDirty(true);
              }}
            />
          </label>
        ))}
        {dirty && (
          <div className="row end">
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
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

// Voice library (commercially licensed voices from ElevenLabs)

function LibraryModal({ host, onClose, onAdded }: { host: Host; onClose: () => void; onAdded: (s: VoiceState) => void }) {
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
    <Modal title={`Voice library for ${host === "host_a" ? "Host A" : "Host B"}`} onClose={onClose} wide>
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
                    onClose();
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

export default function VoiceProfile() {
  const [state, setState] = useState<VoiceState | null>(null);
  const [draft, setDraft] = useState<VoiceProfileData | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [quota, setQuota] = useState<Quota>({});
  const [picking, setPicking] = useState(false);
  const [samples, setSamples] = useState<string[]>([]);
  const [buildJob, setBuildJob] = useState<Job | null>(null);
  const [cloneJob, setCloneJob] = useState<Job | null>(null);
  const [cloning, setCloning] = useState(false);
  const [browsing, setBrowsing] = useState<Host | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { play, playing } = usePlayer();

  const load = () =>
    voiceApi.get().then((s) => {
      setState(s);
      setDraft(s.profile);
      setSamples(s.sample_doc_ids);
    });
  const loadVoices = () => voiceApi.voices().then(setVoices, () => setVoices([]));

  useEffect(() => {
    load();
    loadVoices();
    voiceApi.quota().then(setQuota, () => setQuota({}));
  }, []);

  const build = useJob(buildJob, () => load());
  const clone = useJob(cloneJob, () => {
    load();
    loadVoices();
  });

  if (!state) return <Loading />;
  const building = build && (build.status === "queued" || build.status === "running");
  const cloneRunning = clone && (clone.status === "queued" || clone.status === "running");

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

  const used = quota.character_count ?? 0;
  const limit = quota.character_limit ?? 0;

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Voice profile" title="How you sound, on the page and out loud">
        <button className="btn btn-primary" disabled={Boolean(building)} onClick={() => setPicking(true)}>
          {state.profile ? "Rebuild writing voice" : "Build my writing voice"}
        </button>
      </PageHeader>
      {build && (building || build.status === "failed") && <JobProgress job={build} />}
      {error && <p className="error-text">{error}</p>}

      <div className="two-col">
        <section className="card stack">
          <h2>Writing voice</h2>
          <p className="muted small">Launch Kits, carousels, hooks and scripts are written in this voice. Edit anything that does not sound like you.</p>
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
                <span className="mono muted small">
                  Built {formatDate(state.updated_at, true)} from {state.sample_doc_ids.length} posts
                </span>
                <button className="btn btn-primary btn-small" onClick={saveProfile}>
                  {saved ? "Saved" : "Save changes"}
                </button>
              </div>
            </>
          )}
        </section>

        <div className="stack">
          <section className="card stack">
            <div className="row between">
              <h2>Speaking voices</h2>
              {limit > 0 && (
                <span className="mono muted small" title="ElevenLabs characters this billing period">
                  {used.toLocaleString()} / {limit.toLocaleString()} chars
                </span>
              )}
            </div>
            {!state.tts_configured && <p className="muted">Set ELEVENLABS_API_KEY in .env to generate audio.</p>}
            <p className="muted small">
              Audio overviews use both hosts; videos are narrated by Host A. Model: {state.models[state.model] ?? state.model}.
            </p>
            {(["host_a", "host_b"] as Host[]).map((h) => (
              <HostCard key={h} host={h} state={state} voices={voices} onSaved={setState} onBrowse={setBrowsing} />
            ))}
          </section>

          <section className="card stack">
            <h2>Your own voice</h2>
            {!state.clone.allowed && <p className="muted">Voice cloning is on the Writer and Studio plans.</p>}
            {quota.can_use_instant_voice_cloning === false && (
              <p className="muted small">Your ElevenLabs plan does not include instant voice cloning. Upgrade it at elevenlabs.io.</p>
            )}
            {state.clone.allowed && (state.clone.status === "none" || state.clone.status === "failed") && !cloneRunning && (
              <>
                <p className="muted">
                  Record one to three minutes of your own writing, read aloud. Your voice becomes Host A, so audio overviews and videos sound like you.
                </p>
                {state.clone.status === "failed" && state.clone.error && <p className="error-text">{state.clone.error}</p>}
                <button className="btn btn-primary" onClick={() => setCloning(true)} disabled={!state.tts_configured}>
                  Clone my voice
                </button>
              </>
            )}
            {clone && (cloneRunning || clone.status === "failed") && <JobProgress job={clone} />}
            {state.clone.status === "processing" && !clone && <p className="muted">Your voice is being created.</p>}
            {state.clone.status === "ready" && (
              <>
                <p className="muted">Your voice is live and set as Host A. Adjust its delivery above.</p>
                <div className="row">
                  {state.clone.preview_url && (
                    <button className="btn btn-small" onClick={() => play(state.clone.preview_url!, "clone")}>
                      {playing === "clone" ? "Stop" : "Hear my voice"}
                    </button>
                  )}
                  <button className="btn btn-small" onClick={() => setCloning(true)}>
                    Record again
                  </button>
                  <ConfirmButton
                    confirmLabel="Revoke and delete my voice?"
                    onConfirm={async () => {
                      setState(await voiceApi.revoke());
                      loadVoices();
                    }}
                  >
                    Revoke consent
                  </ConfirmButton>
                </div>
              </>
            )}
          </section>
        </div>
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
      {browsing && (
        <LibraryModal
          host={browsing}
          onClose={() => setBrowsing(null)}
          onAdded={(s) => {
            setState(s);
            loadVoices();
          }}
        />
      )}
    </div>
  );
}

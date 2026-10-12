import { useEffect, useRef, useState, type RefObject } from "react";
import { artifactsApi, videoVoicesApi, type GenerateBody } from "../api/endpoints";
import type { Artifact, ChatSummary, Segment, VideoSavedVoice } from "../api/types";
import { useJob } from "../hooks/useJob";
import { Transcript } from "./ArtifactCard";
import { Dropdown } from "./Dropdown";
import { CheckIcon, ChevronIcon, HeadphonesIcon } from "./icons/Icons";
import { LANGUAGES, Pills, SourceFocusFields, type SourceSelection } from "./SourceFocusFields";
import { ConfirmDeleteModal, errorMessage, JobProgress, Modal, StatusPill } from "./ui";

/** The audio styles. The server describes each to the script writer (backend/app/pipeline/media.py STYLES). */
const STYLES = [
  { id: "deep_dive", name: "Deep Dive", blurb: "A lively conversation that unpacks the ideas in your sources and connects them." },
  { id: "brief", name: "Brief", blurb: "A bite sized overview to help you grasp the core ideas from your sources quickly." },
  { id: "critique", name: "Critique", blurb: "An expert review of your sources, with constructive feedback to help you improve your material." },
  { id: "debate", name: "Debate", blurb: "A thoughtful debate between two hosts, bringing out different perspectives on your sources." },
] as const;
type Style = (typeof STYLES)[number]["id"];

const LENGTHS = [
  { value: "3", label: "Short", hint: "about 3 min" },
  { value: "6", label: "Default", hint: "about 6 min" },
  { value: "12", label: "Long", hint: "about 12 min" },
];

export type AudioOverviewRequest = Omit<GenerateBody, "type">;

/** The workspace's voices, asked for once (the list takes a few seconds): the notebook asks ahead of time, so the
 * pickers are ready when the settings open. A failure is forgotten, so the next open asks again. */
let voicesAsked: Promise<VideoSavedVoice[]> | null = null;
export function prefetchVoices(): Promise<VideoSavedVoice[]> {
  voicesAsked ??= videoVoicesApi.list().then((r) => r.saved).catch((e) => {
    voicesAsked = null;
    throw e;
  });
  return voicesAsked;
}

/** The audio overview settings: a style, one or two hosts and their voices, length, language, the sources, and what
 * the hosts should focus on. */
export function AudioOverviewDialog({ notebookId, notebookTitle, chats, currentChatId, onClose, onCreate }: {
  notebookId: string;
  notebookTitle?: string;
  chats: ChatSummary[];
  currentChatId?: string | null;
  onClose: () => void;
  onCreate: (body: AudioOverviewRequest) => void;
}) {
  const [sel, setSel] = useState<SourceSelection | null>(null);
  const [style, setStyle] = useState<Style>("deep_dive");
  const [hosts, setHosts] = useState<"1" | "2">("2");
  const [minutes, setMinutes] = useState("6");
  const [language, setLanguage] = useState("English");
  const [focus, setFocus] = useState("");
  // The hosts' voices, from the workspace's voices (none to pick when they cannot load: the default voices are used).
  const [voices, setVoices] = useState<VideoSavedVoice[] | null>(null);
  const [voice, setVoice] = useState<[string, string]>(["", ""]);

  useEffect(() => {
    let live = true;
    prefetchVoices().then((saved) => {
      if (!live) return;
      setVoices(saved);
      setVoice([saved[0]?.voice_id ?? "", (saved[1] ?? saved[0])?.voice_id ?? ""]);
    }).catch(() => live && setVoices([]));
    return () => {
      live = false;
    };
  }, []);

  const two = hosts === "2";
  // A debate needs two hosts: with one, the style moves to Deep Dive.
  useEffect(() => {
    if (!two && style === "debate") setStyle("deep_dive");
  }, [two, style]);

  /** Pick a host's voice; the other host moves off it, so the two never share one (when there are two to pick). */
  const pickVoice = (i: 0 | 1, voiceId: string) =>
    setVoice((cur) => {
      const next: [string, string] = [...cur];
      next[i] = voiceId;
      const other = i === 0 ? 1 : 0;
      if (two && next[other] === voiceId) next[other] = voices?.find((v) => v.voice_id !== voiceId)?.voice_id ?? voiceId;
      return next;
    });


  const voiceOptions = (voices ?? []).map((v) => ({ value: v.voice_id, label: v.name }));
  const create = () => {
    if (!sel) return;
    onCreate({
      ...sel.request, format: style, hosts: two ? 2 : 1, minutes: Number(minutes), language, instructions: focus.trim(),
      ...(voice[0] ? { host_a: voice[0], ...(two ? { host_b: voice[1] || voice[0] } : {}) } : {}),
    });
  };

  return (
    <Modal title="Customize audio overview" onClose={onClose} wide>
      <div className="stack vw-in-modal ao-dialog">
        <section className="field">
          <span className="vw-label">Style</span>
          <div className="ao-styles" role="radiogroup" aria-label="Style">
            {STYLES.map((s) => {
              const off = s.id === "debate" && !two;
              return (
                <button key={s.id} type="button" role="radio" aria-checked={style === s.id} disabled={off}
                        className={`ao-style${style === s.id ? " on" : ""}`} onClick={() => setStyle(s.id)}>
                  <span className="ao-style-head">
                    <strong>{s.name}</strong>
                    <span className="ao-radio" aria-hidden="true">{style === s.id && <CheckIcon size={12} />}</span>
                  </span>
                  <span className="ao-style-blurb">{off ? "Needs two hosts." : s.blurb}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="sd-opts ao-opts">
          <div className="field">
            <span className="vw-label">Hosts</span>
            <Pills<"1" | "2"> label="Hosts" value={hosts} onChange={setHosts}
              options={[{ id: "1", label: "One host" }, { id: "2", label: "Two hosts" }]} />
          </div>
          <div className="field">
            <span className="vw-label">Length</span>
            <Dropdown<string> label="Length" value={minutes} onChange={setMinutes} options={LENGTHS} />
          </div>
          <div className="field">
            <span className="vw-label">Language</span>
            <Dropdown<string> label="Language" value={language} onChange={setLanguage}
              options={LANGUAGES.map((l) => ({ value: l, label: l }))} />
          </div>
        </section>

        <section className="ao-voices">
          {voices === null && <p className="muted small">Loading your voices...</p>}
          {voices !== null && voices.length === 0 && (
            <p className="muted small">Your voices could not load, so the default {two ? "voices are" : "voice is"} used.</p>
          )}
          {voices !== null && voices.length > 0 && ([0, 1] as const).filter((i) => i === 0 || two).map((i) => (
            <div key={i} className="field">
              <span className="vw-label">{two ? `Host ${i + 1} voice` : "Host voice"}</span>
              <Dropdown<string> label={two ? `Host ${i + 1} voice` : "Host voice"} value={voice[i]} onChange={(v) => pickVoice(i, v)}
                options={voiceOptions} />
            </div>
          ))}
        </section>

        <SourceFocusFields notebookId={notebookId} notebookTitle={notebookTitle} chats={chats} currentChatId={currentChatId}
                           what="audio overview" noFocus onChange={setSel} />

        <label className="field">
          <span className="vw-label">What should the AI {two ? "hosts" : "host"} focus on in this episode? <span className="muted">(optional)</span></span>
          <textarea className="input sd-prompt" rows={4} maxLength={4000} value={focus} onChange={(e) => setFocus(e.target.value)}
                    placeholder={"- List the core ideas worth remembering\n- Explain how the pieces connect"} />
        </label>
        {!sel?.ready && <p className="muted small">Select at least one post or chat to make an audio overview.</p>}
        <div className="vw-nav">
          <button type="button" className="btn btn-primary vw-next" disabled={!sel?.ready} onClick={create}>
            Generate audio overview
          </button>
        </div>
      </div>
    </Modal>
  );
}

const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75];

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The audio's own player: play or pause, where it is, a bar to move through it, and the playback speed. */
function AudioPlayer({ src, duration: known, audioRef }: { src: string; duration?: number; audioRef: RefObject<HTMLAudioElement> }) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(known ?? 0);
  const [speed, setSpeed] = useState(1);
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const sync = () => {
      setTime(a.currentTime);
      if (Number.isFinite(a.duration) && a.duration > 0) setDuration(a.duration);
      setPlaying(!a.paused && !a.ended);
    };
    const events = ["timeupdate", "loadedmetadata", "durationchange", "play", "pause", "ended"];
    events.forEach((e) => a.addEventListener(e, sync));
    return () => events.forEach((e) => a.removeEventListener(e, sync));
  }, [audioRef]);
  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };
  const nextSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };
  const pct = duration ? Math.min(100, (time / duration) * 100) : 0;
  return (
    <div className="ao-player">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button type="button" className="ao-play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
        {playing ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>
        )}
      </button>
      <span className="ao-time mono">{clock(time)} / {clock(duration)}</span>
      <input className="ao-seek" type="range" min={0} max={duration || 0} step={0.1} value={Math.min(time, duration || 0)}
             aria-label="Position" style={{ ["--ao-fill" as string]: `${pct}%` }}
             onChange={(e) => {
               const a = audioRef.current;
               if (a) a.currentTime = Number(e.target.value);
               setTime(Number(e.target.value));
             }} />
      <button type="button" className="ao-speed mono" onClick={nextSpeed} aria-label={`Playback speed ${speed}x`} title="Playback speed">
        {speed}x
      </button>
    </div>
  );
}

const STYLE_NAMES: Record<string, string> = Object.fromEntries(STYLES.map((s) => [s.id, s.name]));

/** An audio overview in the notebook's list: a row with its title and length that opens (chevron) to its player,
 * transcript, Download and Delete. Shows its progress while it is being made. */
export function AudioOverviewCard({ artifact: initial, onRemoved }: { artifact: Artifact; onRemoved: (id: string) => void }) {
  const [artifact, setArtifact] = useState(initial);
  const [open, setOpen] = useState(false);
  const [transcript, setTranscript] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const job = useJob(artifact.job, () => {
    artifactsApi.get(artifact.id).then(setArtifact);
  });
  const running = job && (job.status === "queued" || job.status === "running");
  const ready = artifact.status === "ready";
  const failed = artifact.status === "failed" ? (artifact.content.error as string | undefined) ?? job?.error ?? "Could not make this audio." : null;
  const c = artifact.content;
  const segments = (c.segments as Segment[] | undefined) ?? [];
  const meta = [
    c.duration_s ? clock(c.duration_s as number) : "",
    c.hosts === 1 ? "1 host" : c.hosts === 2 ? "2 hosts" : "",
    STYLE_NAMES[c.format as string] ?? "",
  ].filter(Boolean).join(" · ") || (running ? "Making the audio..." : "");

  const remove = async () => {
    await artifactsApi.remove(artifact.id);
    onRemoved(artifact.id);
  };

  return (
    <article className={`ao-card${open ? " open" : ""}`}>
      <div className="ao-card-head" role={ready ? "button" : undefined} tabIndex={ready ? 0 : undefined} aria-expanded={ready ? open : undefined}
           onClick={() => ready && setOpen((o) => !o)}
           onKeyDown={(e) => ready && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen((o) => !o))}>
        <span className="ao-card-icon" aria-hidden="true">{running ? <span className="nbv-send-spinner" /> : <HeadphonesIcon size={20} />}</span>
        <span className="ao-card-text">
          <strong title={artifact.title}>{artifact.title}</strong>
          <span className="ao-card-meta">{meta}</span>
        </span>
        {!ready && !failed && <StatusPill status={running ? (job!.status === "queued" ? "queued" : "working") : artifact.status} />}
        {ready && (
          <span className="ao-chevron" aria-hidden="true"><ChevronIcon size={18} className={`chevron${open ? " open" : ""}`} /></span>
        )}
      </div>
      {running && job && <div className="ao-card-progress"><JobProgress job={job} compact /></div>}
      {failed && (
        <div className="ao-card-progress sd-item-failed">
          <p className="error-text small">{failed}</p>
          <button type="button" className="link-btn" onClick={async () => {
            setError(null);
            try {
              setArtifact(await artifactsApi.retry(artifact.id));
            } catch (e) {
              setError(errorMessage(e));
            }
          }}>Retry</button>
          <button type="button" className="link-btn" onClick={() => setConfirming(true)}>Remove</button>
        </div>
      )}
      {ready && open && (
        <div className="ao-card-body">
          {artifact.url && <AudioPlayer src={artifact.url} duration={c.duration_s as number | undefined} audioRef={audio} />}
          {segments.length > 0 && (
            <button type="button" className="link-btn ao-transcript-toggle" aria-expanded={transcript} onClick={() => setTranscript((t) => !t)}>
              {transcript ? "Hide transcript" : `Show transcript (${segments.length} lines)`}
            </button>
          )}
          {transcript && (
            <Transcript segments={segments} onSeek={(t) => {
              const a = audio.current;
              if (!a) return;
              a.currentTime = t;
              void a.play();
            }} />
          )}
          <div className="row ao-card-actions">
            {artifact.download_url && <a className="btn btn-small" href={artifact.download_url}>Download</a>}
            <button type="button" className="btn btn-small ao-delete" onClick={() => setConfirming(true)}>Delete</button>
          </div>
        </div>
      )}
      {error && <p className="error-text small ao-card-progress">{error}</p>}
      {confirming && <ConfirmDeleteModal heading="Delete audio overview?" name={artifact.title} onCancel={() => setConfirming(false)}
                                         onConfirm={remove} />}
    </article>
  );
}

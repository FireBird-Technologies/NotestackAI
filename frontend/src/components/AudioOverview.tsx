import { useEffect, useRef, useState, type RefObject } from "react";
import { artifactsApi, videoVoicesApi, type GenerateBody } from "../api/endpoints";
import type { Artifact, ChatSummary, Segment, VideoSavedVoice } from "../api/types";
import { useJob } from "../hooks/useJob";
import { Transcript } from "./ArtifactCard";
import { Dropdown } from "./Dropdown";
import { CheckIcon, ChevronIcon, DownloadIcon } from "./icons/Icons";
import { LANGUAGES, Pills, SourceFocusFields, type SourceSelection } from "./SourceFocusFields";
import { ConfirmButton, errorMessage, formatDate, JobProgress, Modal, StatusPill } from "./ui";
import { ShareButton } from "./ShareDialog";
import { PostButton } from "./launchpad/PostButton";
import { CardFeedback } from "./CardFeedback";

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

/** The workspace's voices (the list takes a few seconds): the notebook asks ahead of time, so the pickers are ready
 * when the settings open. `fresh` asks again (voices may have been added since); a failure is forgotten, so the next
 * open asks again. */
let voicesAsked: Promise<VideoSavedVoice[]> | null = null;
export function prefetchVoices(fresh = false): Promise<VideoSavedVoice[]> {
  if (fresh) voicesAsked = null;
  voicesAsked ??= videoVoicesApi.list().then((r) => r.saved).catch((e) => {
    voicesAsked = null;
    throw e;
  });
  return voicesAsked;
}

/** The audio overview settings: a style, one or two hosts and their voices, length, language, the sources, and what
 * the hosts should focus on. */
export function AudioOverviewDialog({ notebookId, chats, currentChatId, onClose, onCreate }: {
  notebookId: string;
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

  // The list asked for ahead of time shows at once; a fresh one then replaces it, so voices saved since are listed.
  // The hosts' picks are kept while their voices are still there.
  useEffect(() => {
    let live = true;
    const show = (saved: VideoSavedVoice[]) => {
      if (!live) return;
      setVoices(saved);
      setVoice((cur) => {
        const has = (id: string) => saved.some((v) => v.voice_id === id);
        const first = has(cur[0]) ? cur[0] : saved[0]?.voice_id ?? "";
        const second = has(cur[1]) ? cur[1] : (saved.find((v) => v.voice_id !== first) ?? saved[0])?.voice_id ?? "";
        return [first, second];
      });
    };
    prefetchVoices().then(show).catch(() => live && setVoices((v) => v ?? []))
      .finally(() => prefetchVoices(true).then(show).catch(() => undefined));
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
              options={[{ id: "2", label: "Two hosts" }, { id: "1", label: "One host" }]} />
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

        {/* The hosts' voices and what the episode is made from, side by side */}
        <section className="ao-opts ao-voices-row">
          {voices !== null && voices.length > 0 && ([0, 1] as const).filter((i) => i === 0 || two).map((i) => (
            <div key={i} className="field">
              <span className="vw-label">{two ? `Host ${i + 1} voice` : "Host voice"}</span>
              <Dropdown<string> label={two ? `Host ${i + 1} voice` : "Host voice"} value={voice[i]} onChange={(v) => pickVoice(i, v)}
                options={voiceOptions} />
            </div>
          ))}
          <SourceFocusFields notebookId={notebookId} chats={chats} currentChatId={currentChatId}
                             what="audio overview" noFocus onChange={setSel} />
        </section>
        {voices === null && <p className="muted small ao-voices-note">Loading your voices...</p>}
        {voices !== null && voices.length === 0 && (
          <p className="muted small ao-voices-note">Your voices could not load, so the default {two ? "voices are" : "voice is"} used.</p>
        )}

        <label className="field">
          <span className="vw-label">What should the AI {two ? "hosts" : "host"} focus on in this episode? <span className="muted">(optional)</span></span>
          <textarea className="input sd-prompt ao-prompt" rows={5} maxLength={4000} value={focus} onChange={(e) => setFocus(e.target.value)}
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
export function AudioPlayer({ src, duration: known, audioRef }: { src: string; duration?: number; audioRef: RefObject<HTMLAudioElement> }) {
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
  const [transcript, setTranscript] = useState(false);
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

  // The same card as the notebook's other outputs (a report, a quiz): what it is, its title and date, its state, then
  // a thin player, the transcript on request, and the actions.
  return (
    <article className="artifact card artifact-audio_overview">
      <header className="artifact-head">
        <div>
          <p className="eyebrow">Audio overview</p>
          <h3>{artifact.title}</h3>
          <p className="mono muted">{formatDate(artifact.created_at, true)}</p>
        </div>
        <StatusPill status={running ? (job!.status === "queued" ? "queued" : "working") : artifact.status} />
      </header>
      {running && job && <JobProgress job={job} compact />}
      {failed && <p className="error-text">{failed}</p>}
      {meta && <p className="muted">{meta}</p>}
      {ready && artifact.url && <AudioPlayer src={artifact.url} duration={c.duration_s as number | undefined} audioRef={audio} />}
      {ready && segments.length > 0 && (
        <button type="button" className="link-btn ao-transcript-toggle" aria-expanded={transcript} onClick={() => setTranscript((t) => !t)}>
          {transcript ? "Hide transcript" : `Show transcript (${segments.length} lines)`}
          <ChevronIcon size={16} className={`chevron${transcript ? " open" : ""}`} />
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
      {error && <p className="error-text">{error}</p>}
      <footer className="artifact-actions">
        {ready && <PostButton artifactId={artifact.id} artifact={artifact} />}
        <ShareButton artifact={artifact} />
        {ready && artifact.download_url && <a className="btn btn-small btn-icon-only" href={artifact.download_url} aria-label="Download" title="Download"><DownloadIcon size={16} /></a>}
        {failed && (
          <button type="button" className="btn btn-small" onClick={async () => {
            setError(null);
            try {
              setArtifact(await artifactsApi.retry(artifact.id));
            } catch (e) {
              setError(errorMessage(e));
            }
          }}>Retry</button>
        )}
        <ConfirmButton onConfirm={remove}>Delete</ConfirmButton>
        {/* Bottom right: a positive or negative review */}
        <CardFeedback artifact={artifact} />
      </footer>
    </article>
  );
}

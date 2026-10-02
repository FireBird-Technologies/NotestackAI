import { useEffect, useRef, useState, type ReactNode } from "react";
import type { VideoTemplate } from "../../api/types";
import { EMOTIONS, CHARACTER, EXPRESSIVENESS, SPEED, TUNING_STEP, type VoiceTuning } from "./voiceTuning";

/** The ★ badge on premium options. */
export function Premium({ small = false }: { small?: boolean }) {
  return <span className={`vw-premium-badge${small ? " small" : ""}`}>Premium</span>;
}

/** Portrait (9:16) video format. */
export function PhoneIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" />
    </svg>
  );
}

/** Landscape (16:9) video format. */
export function ScreenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="2.5" y="4" width="19" height="12.5" rx="1.5" /><path d="M8.5 20.5h7M12 16.5v4" />
    </svg>
  );
}

/** One audio element for the whole page: play a URL (or a Blob), stop the previous one. */
export function useAudio() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const stop = () => {
    audio.current?.pause();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setPlaying(null);
  };

  useEffect(() => stop, []);

  function play(key: string, src: string | Blob | null | undefined) {
    if (!src) return;
    const again = playing === key;
    stop();
    if (again) return;
    let url = typeof src === "string" ? src : URL.createObjectURL(src);
    if (typeof src !== "string") objectUrl.current = url;
    if (typeof src === "string" && !/^(https?:|data:|blob:|\/)/.test(src)) url = `data:audio/mpeg;base64,${src}`;
    audio.current = new Audio(url);
    audio.current.onended = () => setPlaying(null);
    audio.current.play().catch(() => setPlaying(null));
    setPlaying(key);
  }

  return { playing, play, stop };
}

export function PlayButton({ on, disabled, label, onClick }: { on: boolean; disabled?: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className="vw-vplay" disabled={disabled} aria-label={on ? `Stop ${label}` : `Play ${label}`}
            onClick={onClick}>
      {on ? <span className="vw-stop" /> : <span className="vw-tri" />}
    </button>
  );
}

function Slider({ label, value, range, left, right, onChange, format }: {
  label: string; value: number; range: { min: number; max: number }; left: string; right: string;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <label className="field vw-slider">
      <span className="row between">
        <span>{label}</span>
        <span className="mono muted">{format ? format(value) : value.toFixed(2)}</span>
      </span>
      <input type="range" min={range.min} max={range.max} step={TUNING_STEP} value={value}
             onChange={(e) => onChange(Number(e.target.value))} />
      <span className="row between small muted"><span>{left}</span><span>{right}</span></span>
    </label>
  );
}

/** Emotion, expressiveness, character and speed, as on blog2video's Advanced Options. */
export function AdvancedVoice({ value, onChange, sample }: { value: VoiceTuning; onChange: (v: VoiceTuning) => void;
                                                             sample?: ReactNode }) {
  const set = (patch: Partial<VoiceTuning>) => onChange({ ...value, ...patch });
  return (
    <div className="stack">
      <label className="vw-option">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Use advanced voice options
      </label>
      <fieldset className="stack vw-fieldset" disabled={!value.enabled}>
        <div className="field">
          <span className="vw-label">Emotion</span>
          <div className="vw-chips">
            {EMOTIONS.map((em) => (
              <button key={em.value} type="button" className={`vw-chip${value.emotion === em.value ? " on" : ""}`}
                      aria-pressed={value.emotion === em.value}
                      onClick={() => set({ emotion: value.emotion === em.value ? "" : em.value })}>
                {em.label}
              </button>
            ))}
          </div>
          <small className="muted">Pick one to steer delivery, or leave unselected.</small>
        </div>
        <Slider label="Expressiveness" value={value.expressiveness} range={EXPRESSIVENESS} left="Steady" right="Expressive"
                onChange={(v) => set({ expressiveness: v })} />
        <Slider label="Character" value={value.character} range={CHARACTER} left="Natural" right="Dramatic"
                onChange={(v) => set({ character: v })} />
        {value.character > 0.3 && value.expressiveness > 0.7 && (
          <small className="muted">High Character with high Expressiveness can sound distorted. Try lowering one.</small>
        )}
        <Slider label="Speed" value={value.speed} range={SPEED} left="0.7x" right="1.2x" format={(v) => `${v.toFixed(2)}x`}
                onChange={(v) => set({ speed: v })} />
      </fieldset>
      {sample}
    </div>
  );
}

/** A file picker that shows what was picked. */
export function FilePick({ accept, multiple, label, hint, onPick }: {
  accept: string; multiple?: boolean; label: string; hint?: string; onPick: (files: File[]) => void;
}) {
  return (
    <label className="field">
      <span className="vw-label">{label}</span>
      <input className="input" type="file" accept={accept} multiple={multiple}
             onChange={(e) => { onPick(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

/** A template's poster (portrait or landscape, to match the video), or its colors when it has none. */
export function TemplateThumb({ template, portrait = false, large = false }: {
  template: VideoTemplate; portrait?: boolean; large?: boolean;
}) {
  const src = (portrait && template.preview_portrait_url) || template.preview_url || null;
  const [failed, setFailed] = useState<string | null>(null);
  const c = template.preview_colors ?? {};
  if (!src || failed === src) {
    return (
      <div className={`vw-thumb-fallback${large ? " large" : ""}`}
           style={{ background: c.bg ?? "#111", color: c.text ?? "#fff", borderColor: c.accent ?? "transparent" }}>
        <span className="vw-thumb-bar" style={{ background: c.accent ?? "#7c3aed" }} />
        <strong>{template.name}</strong>
      </div>
    );
  }
  return <img className={`vw-thumb${portrait ? " portrait" : ""}${large ? " large" : ""}`} src={src} alt=""
              loading="lazy" onError={() => setFailed(src)} />;
}

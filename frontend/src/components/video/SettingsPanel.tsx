import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { videoEditApi, videoVoicesApi } from "../../api/endpoints";
import type { VideoCatalog, VideoSavedVoice, VideoTemplate } from "../../api/types";
import { Dropdown } from "../Dropdown";
import { CheckIcon } from "../icons/Icons";
import { Modal } from "../ui";
import type { PanelProps } from "./EditorPanels";
import { FONTS } from "./fonts";
import { PlayButton, TemplateThumb, useAudio } from "./parts";

const SPEEDS = [0.5, 1, 1.5, 2, 2.5];
const NO_VOICE = "__none";
const DEFAULT_FONT = "__default";
/** The thin slider's blue fill up to the handle (see .range-thin). */
const fill = (value: number, min: number, max: number) =>
  ({ "--fill": `${((value - min) / (max - min)) * 100}%` }) as CSSProperties;
const cap = (s?: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "");

type SaveKey = "colors" | "font" | "captions" | "speed" | "template" | "voice" | "language";

/** A card's save button: disabled until something changed, a spinner while it saves. */
function SaveButton({ dirty, saving, off, onClick, children, busyLabel = "Saving..." }: {
  dirty: boolean; saving: boolean; off: boolean; onClick: () => void; children: ReactNode;
  /** What the button says while it works ("Changing..." for the template, voice and language switches). */
  busyLabel?: string;
}) {
  return (
    <button className="btn btn-small btn-primary vw-save-btn" disabled={off || !dirty || saving} aria-busy={saving} onClick={onClick}>
      {saving ? <><span className="vw-spin small" aria-hidden="true" /> {busyLabel}</> : children}
    </button>
  );
}

/** The built-in templates as a grid; the picked one replaces the video's template (a background job). */
function TemplatePickerModal({ templates, current, portrait, onPick, onClose }: {
  templates: VideoTemplate[]; current: string; portrait: boolean;
  onPick: (id: string) => Promise<unknown>; onClose: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go() {
    if (!picked) return;
    setBusy(true);
    await onPick(picked);
    setBusy(false);
    onClose();
  }

  return (
    <Modal title="Change template" wide onClose={busy ? () => undefined : onClose}>
      <div className="stack">
        <p className="muted">Pick a new look. Scenes, narration and voiceovers stay; the layouts are redone for the new template.</p>
        <div className="vw-templates-scroll vw-template-pick">
          <div className="vw-templates" role="radiogroup" aria-label="Templates">
            {templates.map((t) => {
              const isCurrent = t.id === current;
              const on = picked === t.id;
              return (
                <button key={t.id} type="button" role="radio" aria-checked={on} disabled={isCurrent || busy}
                        className={`vw-template${on ? " on" : ""}${isCurrent ? " current" : ""}`} onClick={() => setPicked(t.id)}>
                  <TemplateThumb template={t} portrait={portrait} />
                  {isCurrent && <span className="vw-badge mono">Current</span>}
                  <strong>{t.name}</strong>
                  {on && <span className="vw-template-check" aria-hidden="true"><CheckIcon size={14} /></span>}
                </button>
              );
            })}
          </div>
        </div>
        <div className="vw-nav vw-nav-end">
          <span className="muted small">Uses 1 video</span>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!picked || busy} onClick={go}>
            {busy ? <><span className="vw-spin small" aria-hidden="true" /> Starting...</> : "Change template"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Warning before removing every scene's voiceover. Stays open (loading) until blog2video accepts the job; its
 * progress then shows on the editor's progress screen. */
function DeleteVoiceoverModal({ onConfirm, onClose }: { onConfirm: () => Promise<unknown>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    await onConfirm();
    setBusy(false);
    onClose();
  }

  return (
    <Modal title="Delete the voiceover?" onClose={busy ? () => undefined : onClose}>
      <div className="stack">
        <p>
          Every scene's narration is removed and the video becomes silent. This can't be undone; you'd need to pick a
          voice again to get narration back. Render again afterwards for a silent MP4.
        </p>
        <div className="vw-nav">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-danger vw-delete-confirm" onClick={go} disabled={busy}>
            {busy ? "Starting..." : "Delete voiceover"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Card({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className="vw-set-card">
      <h3>{title}</h3>
      <p className="muted small">{note}</p>
      <section className="card stack">{children}</section>
    </div>
  );
}

/** Settings, laid out like blog2video's: each card saves on its own. Colours, fonts, speed and captions are a
 * project update; template, voice and language are background jobs. */
export function LookPanel(p: PanelProps & { catalog: VideoCatalog | null }) {
  const pr = p.project;
  const off = p.disabled;

  // Drafts, reset whenever the project reloads after a save.
  const [colors, setColors] = useState({ accent_color: pr.accent_color, text_color: pr.text_color, bg_color: pr.bg_color });
  const [font, setFont] = useState(pr.font_family || DEFAULT_FONT);
  const [speed, setSpeed] = useState(pr.playback_speed ?? 1);
  const [captions, setCaptions] = useState({
    captions_enabled: !!pr.captions_enabled,
    caption_offset: Number(pr.caption_offset ?? 0),
    caption_font_size: Number(pr.caption_font_size) || 36,
    caption_font_family: pr.caption_font_family || "inter",
  });
  const [picking, setPicking] = useState(false); // the template picker is open
  const [deletingVoice, setDeletingVoice] = useState(false); // the delete-voiceover warning is open
  const [voiceId, setVoiceId] = useState(pr.voice_gender === "none" ? NO_VOICE : pr.custom_voice_id ?? "");
  const [language, setLanguage] = useState("");
  const [voices, setVoices] = useState<VideoSavedVoice[]>([]);
  const { playing, play } = useAudio();
  // The card being saved. Project updates clear it when act returns (the reload has reset the drafts, so the button
  // is disabled again); template, voice and language are jobs, cleared when the editor unlocks after the job.
  const [saving, setSaving] = useState<SaveKey | null>(null);
  const [jobSaving, setJobSaving] = useState(false);

  useEffect(() => {
    if (jobSaving && !off) {
      setJobSaving(false);
      setSaving(null);
    }
  }, [jobSaving, off]);

  async function save(key: SaveKey, fn: () => Promise<unknown>) {
    setSaving(key);
    await p.act(fn);
    setSaving(null);
  }

  /** A background job: the button keeps loading until the job ends (the editor is locked meanwhile). */
  async function job(key: SaveKey, run: () => Promise<unknown>) {
    setSaving(key);
    await run();
    setJobSaving(true);
  }

  useEffect(() => {
    setColors({ accent_color: pr.accent_color, text_color: pr.text_color, bg_color: pr.bg_color });
    setFont(pr.font_family || DEFAULT_FONT);
    setSpeed(pr.playback_speed ?? 1);
    setCaptions({
      captions_enabled: !!pr.captions_enabled,
      caption_offset: Number(pr.caption_offset ?? 0),
      caption_font_size: Number(pr.caption_font_size) || 36,
      caption_font_family: pr.caption_font_family || "inter",
    });
    setVoiceId(pr.voice_gender === "none" ? NO_VOICE : pr.custom_voice_id ?? "");
  }, [pr]);

  useEffect(() => {
    // A video speaks in the free built-in voices; a Notestack voice (made on the Voice page) is for audio overviews.
    videoVoicesApi.list().then((v) => setVoices(v.saved.filter((x) => x.source !== "notestack"))).catch(() => undefined);
  }, []);

  const templates = [...(p.catalog?.my_templates ?? []), ...(p.catalog?.templates ?? [])];
  const current = templates.find((t) => t.id === pr.template);
  // Only blog2video's built-in templates can be switched to (no custom ones).
  const builtIn = (p.catalog?.templates ?? []).filter((t) => !t.custom);
  const languages = p.catalog?.languages ?? [];
  const currentLanguage = languages.find((l) => l.code === pr.content_language)?.name ?? "Auto-detected";
  const currentVoice = voices.find((v) => v.voice_id === pr.custom_voice_id);
  const chosenVoice = voices.find((v) => v.voice_id === voiceId);
  const voiceChanged = voiceId !== (pr.voice_gender === "none" ? NO_VOICE : pr.custom_voice_id ?? "");
  // What is saved now, to tell whether each card has changes.
  const same = (a?: string | null, b?: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  const colorsChanged = !same(colors.accent_color, pr.accent_color) || !same(colors.text_color, pr.text_color)
    || !same(colors.bg_color, pr.bg_color);
  const fontChanged = font !== (pr.font_family || DEFAULT_FONT);
  const captionsChanged = captions.captions_enabled !== !!pr.captions_enabled
    || captions.caption_offset !== Number(pr.caption_offset ?? 0)
    || captions.caption_font_size !== (Number(pr.caption_font_size) || 36)
    || captions.caption_font_family !== (pr.caption_font_family || "inter");
  const speedChanged = Math.abs(speed - (pr.playback_speed ?? 1)) > 0.001;

  function changeVoice() {
    const body = voiceId === NO_VOICE ? { voice_gender: "none" } : {
      voice_gender: chosenVoice?.gender === "male" ? "male" : "female",
      voice_accent: chosenVoice?.accent === "british" ? "british" : "american",
      custom_voice_id: voiceId,
    };
    job("voice", () => p.startJob("Changing the voice", () => videoEditApi.changeVoice(p.id, body), () => videoEditApi.voiceStatus(p.id)));
  }

  function changeTemplate(template: string) {
    return job("template", () => p.startJob("Switching template", () => videoEditApi.changeTemplate(p.id, template),
                                            () => videoEditApi.templateStatus(p.id)));
  }

  const fontOptions = FONTS.map((f) => ({ value: f.id, label: f.name }));

  return (
    <div className="vw-settings">
      <Card title="Colors & Font" note="Theme colors and font applied across all scenes.">
        <div className="vw-set-row vw-colors-row">
          <div className="vw-colorpicks">
            {([["accent_color", "Accent", "Buttons & highlights"], ["text_color", "Text", "On-screen text"],
               ["bg_color", "Background", "Scene background"]] as const).map(([k, label, hint]) => (
              <label key={k} className="vw-colorpick">
                <input type="color" value={colors[k] || "#000000"} aria-label={label}
                       onChange={(e) => setColors({ ...colors, [k]: e.target.value })} />
                <span><strong>{label}</strong><small className="muted">{hint}</small></span>
              </label>
            ))}
          </div>
          <SaveButton dirty={colorsChanged} saving={saving === "colors"} off={off}
                      onClick={() => save("colors", () => videoEditApi.updateProject(p.id, colors))}>
            Save colors
          </SaveButton>
        </div>
        <hr className="vw-set-rule" />
        <div className="vw-set-row">
          <div className="field vw-set-grow">
            <span>Font family</span>
            <Dropdown label="Font family" value={font} onChange={setFont}
                      options={[{ value: DEFAULT_FONT, label: "Default (template)" }, ...fontOptions]} />
          </div>
          <SaveButton dirty={fontChanged} saving={saving === "font"} off={off}
                      onClick={() => save("font", () => videoEditApi.updateProject(p.id, { font_family: font === DEFAULT_FONT ? null : font }))}>
            Save font
          </SaveButton>
        </div>
      </Card>

      <Card title="Project Template" note="Change the look for your video.">
        <div className="vw-template-current">
          {current && (
            <div className="vw-template-thumb">
              <TemplateThumb template={current} portrait={pr.aspect_ratio === "portrait"} />
              <span className="vw-hero-check"><CheckIcon size={14} /></span>
            </div>
          )}
          <div className="vw-template-meta">
            <span className="vw-label">Current template</span>
            <strong>{current?.name ?? pr.template}</strong>
            {current?.description && <small className="muted vw-template-desc" title={current.description}>{current.description}</small>}
          </div>
        </div>
        <div className="vw-set-end">
          <SaveButton dirty={builtIn.length > 0} saving={saving === "template"} off={off} busyLabel="Changing..." onClick={() => setPicking(true)}>
            Change template
          </SaveButton>
        </div>
        {deletingVoice && (
          <DeleteVoiceoverModal onClose={() => setDeletingVoice(false)}
                                onConfirm={() => job("voice", () => p.startJob("Deleting the voiceover",
                                  () => videoEditApi.deleteVoiceover(p.id), () => videoEditApi.voiceStatus(p.id)))} />
        )}
        {picking && (
          <TemplatePickerModal templates={builtIn} current={pr.template} portrait={pr.aspect_ratio === "portrait"}
                               onPick={changeTemplate} onClose={() => setPicking(false)} />
        )}
      </Card>

      <Card title="Captions & Speed" note="How captions look and how fast the video plays, in the preview and the final render.">
        <div className="vw-split">
          <div className="stack">
            <div>
              <strong>Captions</strong>
              <p className="muted small">Shown on the preview and the final rendered video.</p>
            </div>
            <label className="vw-option">
              <input type="checkbox" checked={captions.captions_enabled}
                     onChange={(e) => setCaptions({ ...captions, captions_enabled: e.target.checked })} />
              Enable captions
            </label>
            <fieldset className={`vw-caption-opts${captions.captions_enabled ? "" : " vw-dim"}`} disabled={!captions.captions_enabled}>
              <label className="field vw-slider">
                <span className="row between">
                  <span className="vw-label">Offset</span>
                  <span className="mono small">{captions.caption_offset === 0 ? "Default" : captions.caption_offset}</span>
                </span>
                <input type="range" className="range-thin" min={-100} max={100} step={1} value={captions.caption_offset}
                       style={fill(captions.caption_offset, -100, 100)}
                       onChange={(e) => setCaptions({ ...captions, caption_offset: Number(e.target.value) })} />
                <span className="row between small muted"><span>Down</span><span>Up</span></span>
              </label>
              <label className="field vw-slider">
                <span className="row between">
                  <span className="vw-label">Size</span>
                  <span className="mono small">{captions.caption_font_size}px</span>
                </span>
                <input type="range" className="range-thin" min={12} max={64} step={1} value={captions.caption_font_size}
                       style={fill(captions.caption_font_size, 12, 64)}
                       onChange={(e) => setCaptions({ ...captions, caption_font_size: Number(e.target.value) })} />
                <span className="row between small muted"><span>12</span><span>64px</span></span>
              </label>
            </fieldset>
            <div className="vw-set-row">
              <fieldset className={`vw-set-grow vw-caption-font${captions.captions_enabled ? "" : " vw-dim"}`}
                        disabled={!captions.captions_enabled}>
                <div className="field">
                  <span className="vw-label">Font</span>
                  <Dropdown label="Caption font" value={captions.caption_font_family}
                            onChange={(v) => setCaptions({ ...captions, caption_font_family: v })} options={fontOptions} />
                </div>
              </fieldset>
              <SaveButton dirty={captionsChanged} saving={saving === "captions"} off={off}
                          onClick={() => save("captions", () => videoEditApi.updateProject(p.id, captions))}>
                Save captions
              </SaveButton>
            </div>
          </div>
          <div className="stack">
            <div>
              <strong>Playback speed</strong>
              <p className="muted small">Applies to the preview and the final video, voiceover included.</p>
            </div>
            <div className="vw-chips">
              {SPEEDS.map((v) => (
                <button key={v} type="button" className={`vw-chip${speed === v ? " on" : ""}`} aria-pressed={speed === v}
                        onClick={() => setSpeed(v)}>
                  {v}×
                </button>
              ))}
            </div>
            <label className="field vw-slider">
              <span className="row between"><span>Custom speed</span><span className="mono">{speed.toFixed(2)}x</span></span>
              <input type="range" className="range-thin" min={0.5} max={2.5} step={0.05} value={speed} style={fill(speed, 0.5, 2.5)}
                     onChange={(e) => setSpeed(Number(e.target.value))} />
            </label>
            <div className="vw-set-end">
              <SaveButton dirty={speedChanged} saving={saving === "speed"} off={off}
                          onClick={() => save("speed", () => videoEditApi.updateProject(p.id, { playback_speed: speed }))}>
                Save speed
              </SaveButton>
            </div>
          </div>
        </div>
      </Card>

      <Card title="Voice & Language" note="The narration voice and the language of this video.">
        <div className="vw-voice-lang">
          <div className="stack">
            <div>
              <strong>Voice</strong>
              <p className="muted small">The narration voice for this project.</p>
            </div>
            <div className="vw-voice-current">
              <PlayButton on={playing === currentVoice?.voice_id} disabled={!currentVoice?.preview_url}
                          label={currentVoice?.name ?? "voice"} onClick={() => currentVoice && play(currentVoice.voice_id, currentVoice.preview_url)} />
              <span>
                <strong>{pr.voice_gender === "none" ? "No voiceover" : currentVoice?.name ?? "Current voice"}</strong>
                {currentVoice && <small className="muted">{[cap(currentVoice.gender), cap(currentVoice.accent)].filter(Boolean).join(" • ")}</small>}
              </span>
            </div>
            <Dropdown label="Voice" value={voiceId || NO_VOICE} onChange={setVoiceId}
                      options={[{ value: NO_VOICE, label: "No voiceover" },
                        ...voices.map((v) => ({ value: v.voice_id, label: v.name,
                          hint: [cap(v.gender), cap(v.accent)].filter(Boolean).join(" • ") || undefined }))]} />
            <div className="row wrap">
              <button type="button" className="btn btn-small vw-danger-soft" disabled={off || pr.voice_gender === "none"}
                      onClick={() => setDeletingVoice(true)}>
                Delete voiceover
              </button>
              <SaveButton dirty={voiceChanged} saving={saving === "voice"} off={off} busyLabel="Changing..." onClick={changeVoice}>Change voice</SaveButton>
            </div>
            <small className="muted">Changing the voice uses one video credit.</small>
          </div>
          <div className="stack">
            <div>
              <strong>Language</strong>
              <p className="muted small">Translate the video: text, narration and voiceover.</p>
            </div>
            <div className="vw-lang-pair">
              <div className="field">
                <span className="small muted">Current language</span>
                <div className="vw-lang-current">{currentLanguage}</div>
              </div>
              <div className="field">
                <span className="small muted">Translate to</span>
                <Dropdown label="Translate to" value={language} onChange={setLanguage}
                          options={[{ value: "", label: "Select a language" },
                            ...languages.filter((l) => l.code !== pr.content_language).map((l) => ({ value: l.code, label: l.name }))]} />
              </div>
            </div>
            <div>
              <SaveButton dirty={!!language} saving={saving === "language"} off={off} busyLabel="Changing..."
                          onClick={() => job("language", () => p.startJob("Translating", () => videoEditApi.changeLanguage(p.id, language),
                                                                          () => videoEditApi.languageStatus(p.id)).then(() => setLanguage("")))}>
                Change language
              </SaveButton>
            </div>
            <small className="muted">Counts as a new video (1 credit).</small>
          </div>
        </div>
      </Card>

    </div>
  );
}

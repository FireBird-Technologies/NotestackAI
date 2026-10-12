import { useState, type CSSProperties } from "react";
import { videoEditApi, type LayoutInfo } from "../../api/endpoints";
import type { VideoScene } from "../../api/types";
import { Dropdown } from "../Dropdown";
import { errorMessage, Modal } from "../ui";
import { ChevronIcon } from "../icons/Icons";
import { isHiddenProp, keyLabel, LayoutFields, layoutFieldDefs, type FieldDef } from "./LayoutFields";
import { baseLayout, FONT, layoutName, MANAGED_PROPS, parseCode, propsOf, withLayout, withProps, wordsAndSeconds,
  type FontDefaults } from "./sceneCode";

const KEEP = "__keep__"; // blog2video's "keep the current layout"
const AUTO = "__auto__"; // ours for "let AI choose": the layout is left out of the request

type Mode = "ai" | "manual";

/** Edit one scene, as on blog2video: AI-assisted (narration, AI rewrite, re-record the voiceover) or manual
 *  (title, display text, extra hold, and the layout's own content fields). */
export function SceneEditModal({ id, scene, index, template, aiEditsLeft, layoutInfo, layoutNames, onClose, onSaved }: {
  id: string; scene: VideoScene; index: number; template: string; aiEditsLeft: number | null;
  layoutInfo: LayoutInfo | null; layoutNames: Record<string, string> | null;
  onClose: () => void; onSaved: (message: string) => void;
}) {
  const props = propsOf(parseCode(scene), template);
  const [mode, setMode] = useState<Mode>("ai");
  const [narration, setNarration] = useState(scene.narration_text);
  const [instruction, setInstruction] = useState("");
  const [askAi, setAskAi] = useState(false);
  const [rerecord, setRerecord] = useState(false);
  const [verbatim, setVerbatim] = useState(true);
  // Scene layout: KEEP, AUTO or a layout id (a sibling variant of the current one is a Scene style switch).
  const current = scene.layout ?? "";
  const [layout, setLayout] = useState<string>(KEEP);
  const [title, setTitle] = useState(scene.title);
  const [display, setDisplay] = useState(scene.display_text ?? "");
  const [hold, setHold] = useState(Number(scene.extra_hold_seconds ?? 0));
  // Layout content, as blog2video's editor builds it: the fields the template declares for this layout (meta.json),
  // minus what is edited elsewhere (fonts, image / stock footage). A layout that declares none falls back to its plain
  // text and number props.
  const declared = layoutFieldDefs(layoutInfo?.layout_prop_schema, scene.layout);
  const fields: FieldDef[] = declared.fields.length ? declared.fields
    : Object.entries(props)
      .filter(([k, v]) => !MANAGED_PROPS.has(k) && !isHiddenProp(k) && (typeof v === "string" || typeof v === "number"))
      .map(([k, v]) => ({ key: k, label: keyLabel(k), type: typeof v === "number" ? "number" : "string" }));
  const [content, setContent] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.key, props[f.key]])));
  const contentChanges = Object.fromEntries(fields.filter((f) => JSON.stringify(content[f.key] ?? null) !== JSON.stringify(props[f.key] ?? null))
    .map((f) => [f.key, content[f.key]]));
  const [open, setOpen] = useState({ settings: true, props: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const narrationChanged = narration !== scene.narration_text;
  const variants = layoutInfo?.layout_variants?.[baseLayout(current)] ?? [];
  const layoutChanged = layout !== KEEP && layout !== current;
  // Same family, other style: a plain descriptor update (no AI, text and images kept), unlike a new layout.
  const styleSwitch = layoutChanged && layout !== AUTO && baseLayout(layout) === baseLayout(current);
  const asked = askAi && instruction.trim().length > 0;
  const needsRegen = rerecord || asked || (layoutChanged && !styleSwitch);
  const aiChanged = narrationChanged || needsRegen || styleSwitch;

  /** Editing the narration turns re-recording on (as on blog2video): the old audio no longer matches the text. */
  function editNarration(text: string) {
    setNarration(text);
    if (text !== scene.narration_text) setRerecord(true);
  }
  const manualChanged = title !== scene.title || display !== (scene.display_text ?? "") ||
    hold !== Number(scene.extra_hold_seconds ?? 0) || Object.keys(contentChanges).length > 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "ai") {
        // As blog2video's own editor: the edited narration first, then (if needed) one regenerate.
        if (narrationChanged) await videoEditApi.updateScene(id, scene.id, { narration_text: narration });
        if (needsRegen) {
          await videoEditApi.regenerateScene(id, scene.id, {
            description: asked ? instruction.trim() : undefined,
            narration_text: narration, regenerate_voiceover: rerecord, voiceover_verbatim: verbatim,
            // KEEP must be sent: left out, blog2video lets AI pick a new layout for the scene.
            layout: layout === AUTO ? undefined : layoutChanged ? layout : KEEP,
          });
        } else if (styleSwitch) {
          await videoEditApi.updateScene(id, scene.id, { remotion_code: withLayout(scene, layout) });
        }
        onSaved("Scene saved.");
      } else {
        const remotion_code = withProps(scene, template, {
          ...contentChanges, // only the fields that changed: font sizes and media props stay as saved
        });
        await videoEditApi.updateScene(id, scene.id, { title, display_text: display, extra_hold_seconds: hold, remotion_code });
        onSaved("Scene saved.");
      }
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit Scene ${index + 1}`} onClose={onClose} wide>
      <div className="stack vw-edit">
        <div>
          <span className="vw-label">Editing mode</span>
          <p className="muted small">Pick a tab: use <strong>AI-Assisted</strong> to let AI change the scene for you, or <strong>Manual</strong> to edit it yourself.</p>
          <div className="vw-seg" role="tablist">
            {(["ai", "manual"] as const).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m} className={`vw-seg-btn${mode === m ? " on" : ""}`}
                      onClick={() => setMode(m)}>
                {m === "ai" ? "AI-Assisted editing" : "Manual editing"}
              </button>
            ))}
          </div>
        </div>

        {mode === "ai" && (
          <>
            {aiEditsLeft !== null && (
              <p className="small">
                AI edits remaining: <strong>{aiEditsLeft}</strong>{" "}
                <span className="muted">({needsRegen ? "this edit uses 1" : "a voiceover, rewrite or new layout uses 1"})</span>
              </p>
            )}
            <div className="field">
              <span className="row between">
                <strong>Scene narration</strong>
                <span className="muted small">{wordsAndSeconds(narration)}</span>
              </span>
              <small className="muted">This is what's spoken in the voiceover. Edit it directly, or use AI below.</small>
              <textarea className="textarea vw-narration" rows={5} maxLength={6000} value={narration}
                        onChange={(e) => editNarration(e.target.value)} />
              {narrationChanged && (
                <small className="vw-edit-note">⚠ You changed the narration, so the voiceover will be re-recorded on save.</small>
              )}
            </div>
            {!askAi ? (
              <button type="button" className="vw-ai-btn" onClick={() => setAskAi(true)}>✦ Rewrite this with AI</button>
            ) : (
              <label className="field">
                <span className="vw-label">What should change?</span>
                <textarea className="textarea" rows={2} maxLength={2000} value={instruction} autoFocus
                          placeholder="e.g. Make it shorter and punchier, or explain it with a real-world example"
                          onChange={(e) => setInstruction(e.target.value)} />
              </label>
            )}
            <section className="card vw-ai-options">
              <div className="vw-ai-block">
                <div className="row between">
                  <div>
                    <strong>Re-record the voiceover</strong>
                    <p className="muted small">Generate fresh audio for the new narration. Turn off to keep the current audio.</p>
                  </div>
                  <button type="button" role="switch" aria-checked={rerecord} className={`vw-switch${rerecord ? " on" : ""}`}
                          onClick={() => setRerecord(!rerecord)}><span /></button>
                </div>
                <div className={`vw-grid2${rerecord ? "" : " vw-dim"}`}>
                  {([[true, "Use exact wording", "Speaks your narration word for word."],
                     [false, "Rephrase with AI", "AI lightly rephrases it to fit the rest of the video."]] as const).map(([v, label, hint]) => (
                    <label key={label} className="vw-radio">
                      <input type="radio" name="verbatim" checked={verbatim === v} disabled={!rerecord} onChange={() => setVerbatim(v)} />
                      <span><strong>{label}</strong><small className="muted">{hint}</small></span>
                    </label>
                  ))}
                </div>
                <small className="muted">You can change the voice for the whole video in Settings.</small>
              </div>

              {variants.length > 1 && (
                <div className="vw-ai-block">
                  <div>
                    <strong>Scene style</strong>
                    <p className="muted small">Pick a different look for this scene. Your text and images stay as they are.</p>
                  </div>
                  <div className="vw-style-chips" role="radiogroup" aria-label="Scene style">
                    {variants.map((v, i) => {
                      const on = (layout === KEEP || layout === AUTO ? current : layout) === v;
                      return (
                        <button key={v} type="button" role="radio" aria-checked={on} className={on ? "on" : ""}
                                onClick={() => setLayout(v === current ? KEEP : v)}>
                          {layoutInfo?.layout_variant_labels?.[v] ?? `Style ${i + 1}`}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="vw-ai-block vw-layout-row">
                <div>
                  <strong>Scene layout</strong>
                  <p className="muted small">Keep the current layout, pick one, or let AI decide. A new layout uses 1 AI edit.</p>
                </div>
                <div className="vw-layout-pick">
                  <Dropdown<string> label="Scene layout" value={layout} onChange={setLayout}
                    options={[
                      { value: KEEP, label: `${layoutName(current, layoutNames)} (current)` },
                      { value: AUTO, label: "Auto (let AI choose)" },
                      ...(layoutInfo?.layouts ?? []).filter((l) => l !== current)
                        .map((l) => ({ value: l, label: layoutName(l, layoutNames) })),
                    ]} />
                </div>
              </div>
            </section>
          </>
        )}

        {mode === "manual" && (
          <>
            <section className="card stack">
              <button type="button" className="vw-collapse" aria-expanded={open.settings}
                      onClick={() => setOpen({ ...open, settings: !open.settings })}>
                <span>Scene Settings</span><ChevronIcon size={18} className={`chevron${open.settings ? " open" : ""}`} />
              </button>
              {open.settings && (
                <div className="stack">
                  <label className="field">
                    <span className="vw-label">Title</span>
                    <input className="input" value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} />
                  </label>
                  <label className="field">
                    <span className="vw-label">Display text</span>
                    <textarea className="textarea" rows={3} maxLength={3000} value={display} onChange={(e) => setDisplay(e.target.value)} />
                  </label>
                  <label className="field">
                    <span className="vw-label">Extra hold (seconds)</span>
                    <input className="input" type="number" min={0} max={30} step={0.5} value={hold}
                           onChange={(e) => setHold(Math.max(0, Number(e.target.value)))} />
                    <small className="muted">Add seconds after the voiceover ends so animations can finish before the next scene.</small>
                  </label>
                </div>
              )}
            </section>
            <section className="card stack">
              <button type="button" className="vw-collapse" aria-expanded={open.props}
                      onClick={() => setOpen({ ...open, props: !open.props })}>
                <span>Scene Props</span><ChevronIcon size={18} className={`chevron${open.props ? " open" : ""}`} />
              </button>
              {open.props && (
                <div className="stack">
                  <span className="vw-label">Layout content</span>
                  {fields.length === 0 ? <p className="muted small"><em>This layout has no content fields to edit.</em></p> : (
                    <LayoutFields fields={fields} value={content} onChange={(k, v) => setContent((c) => ({ ...c, [k]: v }))} />
                  )}
                  {declared.hasTables && (
                    <small className="muted">Chart and table data are edited by regenerating the scene in the AI tab.</small>
                  )}
                </div>
              )}
            </section>
          </>
        )}

        {error && <p className="error-text">{error}</p>}
        <div className="vw-nav">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !(mode === "ai" ? aiChanged : manualChanged)}>
            {busy ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Title and body font sizes; null = the template's default. */
/** A scene's font sizes: the stored value, or the template's default for the scene's layout when none is stored. */
export function FontSliders({ title, desc, defaults, saving, onTitle, onDesc }: {
  title: number | null; desc: number | null; defaults: FontDefaults;
  /** Sizes being saved right now (autosave in the scene row): a spinner shows by their value until applied. */
  saving?: { title: boolean; desc: boolean };
  onTitle: (v: number | null) => void; onDesc: (v: number | null) => void;
}) {
  const rows = [
    ["Title font size", title, FONT.title, defaults.title, onTitle, !!saving?.title],
    ["Display text font size", desc, FONT.desc, defaults.desc, onDesc, !!saving?.desc],
  ] as const;
  return (
    <div className="stack">
      <span className="vw-label">Typography <span className="muted">(optional)</span></span>
      {rows.map(([label, value, range, fallback, set, busy]) => (
        <label key={label} className="field vw-slider">
          <span className="row between small">
            <span>{label}</span>
            <span className="vw-font-value">
              {busy && <span className="vw-spin small" role="status" aria-label="Saving" />}
              <span className="mono vw-accent">{value ?? fallback}</span>
            </span>
          </span>
          {/* --fill paints the track blue up to the handle */}
          <input type="range" className="range-thin" min={range.min} max={range.max} value={value ?? fallback}
                 style={{ "--fill": `${(((value ?? fallback) - range.min) / (range.max - range.min)) * 100}%` } as CSSProperties}
                 onChange={(e) => set(Number(e.target.value))} />
        </label>
      ))}
    </div>
  );
}

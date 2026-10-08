import { useState } from "react";
import { videoStylesApi } from "../../api/endpoints";
import type { VideoStyleItem } from "../../api/types";
import { errorMessage, Modal } from "../ui";

/** A custom video style: guidance for how the script is written. Draft it with AI from a description, or write it.
 *  Pass `style` to edit an existing one. */
export function StyleCreator({ style, onClose, onSaved }: {
  style?: VideoStyleItem; onClose: () => void; onSaved: (s: VideoStyleItem) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState(style?.name ?? "");
  const [guidance, setGuidance] = useState(style?.guidance ?? "");
  const [method, setMethod] = useState<"manual" | "ai">("manual");
  const [busy, setBusy] = useState<"draft" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function draft() {
    setBusy("draft");
    setError(null);
    try {
      const d = await videoStylesApi.aiDraft(prompt.trim());
      setName(d.name);
      setGuidance(d.guidance);
      setMethod("ai");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setError(null);
    try {
      const saved = style?.custom_id
        ? await videoStylesApi.update(style.custom_id, { name: name.trim(), guidance: guidance.trim(), version: style.version ?? 0 })
        : await videoStylesApi.create({ name: name.trim(), guidance: guidance.trim(), creation_method: method,
                                        source_prompt: method === "ai" ? prompt.trim() : undefined });
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <Modal title={style ? "Edit video style" : "Create a video style"} onClose={onClose} wide>
      <div className="stack">
        {!style && (
          <div className="field">
            <span className="vw-label">Describe the style (optional)</span>
            <textarea className="input" rows={3} maxLength={1000} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Punchy and direct, short sentences, one idea per scene, end every video with a question." />
            <div className="row">
              <button className="btn btn-small" onClick={draft} disabled={!!busy || prompt.trim().length < 20}>
                {busy === "draft" ? "Drafting..." : "Draft with AI"}
              </button>
              <small className="muted">Or write the style yourself below.</small>
            </div>
          </div>
        )}
        <label className="field">
          <span className="vw-label">Name</span>
          <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="vw-label">Guidance</span>
          <textarea className="input" rows={7} maxLength={2000} value={guidance} onChange={(e) => setGuidance(e.target.value)}
                    placeholder="How scripts in this style should read: tone, pacing, structure, words to use or avoid." />
          <small className="muted">{guidance.length}/2000</small>
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="vw-nav">
          <button className="btn" onClick={onClose} disabled={!!busy}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={!!busy || !name.trim() || !guidance.trim()}>
            {busy === "save" ? "Saving..." : "Save style"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { videoEditApi, type StockClip } from "../../api/endpoints";
import type { VideoAsset, VideoScene } from "../../api/types";
import { CheckIcon } from "../icons/Icons";
import { errorMessage, Loading, Modal } from "../ui";
import type { PanelProps } from "./EditorPanels";
import { withoutMedia } from "./sceneCode";

/** The scene media modals, like blog2video's editor: pick an existing image or clip, upload, search stock footage,
 * and write / review an AI image. A scene has one visual slot, so whatever is picked replaces the current one. */

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const IMAGE_MAX = 5 * 1024 * 1024; // blog2video's limit for a scene image

const ListIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

const XIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

/** Two big choices: reuse something this video already has, or bring in a new one. */
export function ChoiceModal({ title, subtitle, existing, fresh, freshIcon, onPick, onClose }: {
  title: string; subtitle: string; existing: string; fresh: string; freshIcon: ReactNode;
  onPick: (choice: "existing" | "new") => void; onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <p className="muted">{subtitle}</p>
        <div className="vw-choice">
          <button type="button" onClick={() => onPick("existing")}><ListIcon /><span>{existing}</span></button>
          <button type="button" onClick={() => onPick("new")}>{freshIcon}<span>{fresh}</span></button>
        </div>
      </div>
    </Modal>
  );
}

/** The video's own images or clips; the picked one goes on this scene (the same one can sit on several scenes). */
export function AssetPickerModal(p: PanelProps & { scene: VideoScene; kind: "image" | "video"; onNew: () => void; onClose: () => void }) {
  const assets: VideoAsset[] = (p.project.assets ?? []).filter((a) => a.asset_type === p.kind && !a.excluded && a.r2_url);
  const onScene = new Set((p.scene.images ?? []).map((i) => i.filename));
  const [picked, setPicked] = useState<VideoAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const noun = p.kind === "image" ? "image" : "clip";

  async function use() {
    if (!picked) return;
    setBusy(true);
    setFailed(false);
    // A still is assigned by its asset id, a clip by its file name.
    const ok = await p.act(() => (p.kind === "image" ? videoEditApi.assignImage(p.id, p.scene.id, picked.id)
      : videoEditApi.linkStock(p.id, p.scene.id, picked.filename)));
    setBusy(false);
    if (ok) p.onClose();
    else setFailed(true);
  }

  return (
    <Modal title={p.kind === "image" ? "Use an existing image" : "Choose existing stock footage"} wide
           onClose={busy ? () => undefined : p.onClose}>
      <div className="stack">
        {assets.length === 0 ? (
          <div className="vw-asset-empty">
            <p className="muted">This video has no {p.kind === "image" ? "images" : "stock clips"} yet.</p>
            <button className="btn btn-small" onClick={p.onNew}>{p.kind === "image" ? "Upload an image" : "Find a new clip"}</button>
          </div>
        ) : (
          <>
            <p className="muted small">Replaces this scene's current image or clip.</p>
            <div className="vw-asset-grid" role="radiogroup" aria-label={`Pick a ${noun}`}>
              {assets.map((a) => {
                const on = picked?.id === a.id;
                return (
                  <button key={a.id} type="button" role="radio" aria-checked={on} className={`vw-asset${on ? " on" : ""}`}
                          disabled={busy} onClick={() => setPicked(a)}>
                    {p.kind === "video"
                      ? <video src={a.r2_url!} muted loop playsInline preload="metadata"
                               onMouseEnter={(e) => e.currentTarget.play().catch(() => undefined)} onMouseLeave={(e) => e.currentTarget.pause()} />
                      : <img src={a.r2_url!} alt="" loading="lazy" />}
                    {onScene.has(a.filename) && <span className="vw-asset-tag">On this scene</span>}
                    {a.duration_seconds ? <span className="vw-asset-time mono">{clock(a.duration_seconds)}</span> : null}
                    {on && <span className="vw-asset-check"><CheckIcon size={14} /></span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {failed && <p className="error-text">Couldn't add it. Try again.</p>}
        <div className="vw-nav">
          <button className="btn" onClick={p.onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary vw-next" disabled={!picked || busy} onClick={use}>
            {busy ? "Adding..." : `Use this ${noun}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Search the stock libraries; the picked clip is downloaded into the video and put on this scene. */
export function StockSearchModal(p: PanelProps & { scene: VideoScene; onClose: () => void }) {
  const [query, setQuery] = useState(p.scene.title ?? "");
  const [clips, setClips] = useState<StockClip[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [picked, setPicked] = useState<StockClip | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError(null);
    setPicked(null);
    try {
      setClips((await videoEditApi.searchStock(p.id, query.trim())).clips);
    } catch (e) {
      setSearchError(errorMessage(e));
    } finally {
      setSearching(false);
    }
  }

  // The first search runs by itself, on the scene's title.
  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function use() {
    if (!picked) return;
    setBusy(true);
    setFailed(false);
    const ok = await p.act(async () => {
      // Downloading makes the clip an asset; linking puts it on this scene.
      const added = await videoEditApi.useStock(p.id, p.scene.id, picked);
      await videoEditApi.linkStock(p.id, p.scene.id, added.filename);
    });
    setBusy(false);
    if (ok) p.onClose();
    else setFailed(true);
  }

  return (
    <Modal title="Add stock footage" wide onClose={busy ? () => undefined : p.onClose}>
      <div className="stack">
        <p className="muted">Clips are converted to 30 fps so they stay in sync with your video.</p>
        {/* The field takes the row; Search sits beside it on the right */}
        <div className="vw-search">
          <input className="input" value={query} placeholder="Search stock footage" autoFocus disabled={busy}
                 onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
          <button className="btn btn-primary" disabled={!query.trim() || searching || busy} onClick={search}>Search</button>
        </div>
        {searching && <Loading label="Searching" />}
        {searchError && <p className="error-text">{searchError}</p>}
        {!searching && clips?.length === 0 && <p className="muted">No clips found. Try other words.</p>}
        {!searching && clips && clips.length > 0 && (
          <div className="vw-clip-grid" role="radiogroup" aria-label="Pick a clip">
            {clips.map((c) => {
              const on = picked === c;
              return (
                <button key={`${c.provider}${c.id}`} type="button" role="radio" aria-checked={on}
                        className={`vw-clip-card${on ? " on" : ""}`} disabled={busy} onClick={() => setPicked(c)}>
                  <span className="vw-clip-thumb">
                    <video src={c.preview_url} poster={c.thumbnail_url} muted loop playsInline preload="none"
                           onMouseEnter={(e) => e.currentTarget.play().catch(() => undefined)} onMouseLeave={(e) => e.currentTarget.pause()} />
                    {c.duration ? <span className="vw-asset-time mono">{clock(c.duration)}</span> : null}
                    {on && <span className="vw-asset-check"><CheckIcon size={14} /></span>}
                  </span>
                  <span className="vw-clip-meta">
                    <span className="vw-clip-author">{c.author || "Unknown"}</span>
                    <span className="vw-clip-provider mono">{c.provider}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {failed && <p className="error-text">Couldn't add the clip. Try again.</p>}
        <div className="vw-nav vw-nav-end">
          <span className="muted small">Uses 1 AI edit</span>
          <button className="btn" onClick={p.onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" disabled={!picked || busy} onClick={use}>
            {busy ? "Adding the clip..." : "Use this clip"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Take one image or clip off a scene. Stays open (and loading) until the scene is saved and reloaded. */
export function RemoveMediaModal(p: PanelProps & { scene: VideoScene; filename: string; kind: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function remove() {
    setBusy(true);
    setFailed(false);
    const ok = await p.act(() => videoEditApi.updateScene(p.id, p.scene.id, {
      remotion_code: withoutMedia(p.scene, p.project.template, p.filename),
    }));
    setBusy(false);
    if (ok) p.onClose();
    else setFailed(true);
  }

  return (
    // While the removal runs, Escape, the backdrop and the close button do nothing.
    <Modal title={p.kind === "video" ? "Remove this stock clip?" : "Remove this image?"} onClose={busy ? () => undefined : p.onClose}>
      <div className="stack">
        <p>It comes off this scene only. It stays in the video's media, so you can add it back from Images/footage.</p>
        {failed && <p className="error-text">Couldn't remove it. Try again.</p>}
        <div className="vw-nav">
          <button className="btn" onClick={p.onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-danger vw-delete-confirm" onClick={remove} disabled={busy}>
            {busy ? "Removing..." : "Remove"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Delete an image or clip from the video for good (blog2video removes its files and takes it off any scene). */
export function DeleteAssetModal(p: PanelProps & { asset: { id: number; kind: string }; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const clip = p.asset.kind === "video";

  async function remove() {
    setBusy(true);
    setFailed(false);
    const ok = await p.act(() => videoEditApi.deleteAsset(p.id, p.asset.id));
    setBusy(false);
    if (ok) p.onClose();
    else setFailed(true);
  }

  return (
    <Modal title={clip ? "Delete this stock clip?" : "Delete this image?"} onClose={busy ? () => undefined : p.onClose}>
      <div className="stack">
        <p>
          This permanently deletes the {clip ? "stock clip" : "image"} from this video. It can't be recovered, and you'll
          need to add it again if you want it back.
        </p>
        {failed && <p className="error-text">Couldn't delete it. Try again.</p>}
        <div className="vw-nav">
          <button className="btn" onClick={p.onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-danger vw-delete-confirm" onClick={remove} disabled={busy}>
            {busy ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The prompt for an AI image. Generating runs in the background (see SceneList), so this closes straight away. */
export function AiImageModal({ scene, aiEditsLeft, onGenerate, onClose }: {
  scene: VideoScene; aiEditsLeft: number | null; onGenerate: (prompt: string) => void; onClose: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const ok = prompt.trim().length >= 3;
  return (
    <Modal title="Generate image with AI" onClose={onClose}>
      <div className="stack">
        <p className="muted">
          Describe the image you want. Uses 1 AI edit{aiEditsLeft !== null ? ` · ${aiEditsLeft} left` : ""}.
        </p>
        <label className="field">
          <span className="vw-label">Image description</span>
          <textarea className="textarea vw-ai-prompt" rows={8} maxLength={4000} autoFocus value={prompt}
                    placeholder={scene.visual_description || "What should the image show?"}
                    onChange={(e) => setPrompt(e.target.value)} />
          <small className="muted">The scene's description is also used to generate the image.</small>
        </label>
        <div className="vw-nav">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary vw-next" disabled={!ok} onClick={() => onGenerate(prompt.trim())}>Generate</button>
        </div>
      </div>
    </Modal>
  );
}

/** A generated image, not on the scene yet: keep uploads it (as blog2video does), discard drops it. */
export function AiReviewModal(p: PanelProps & { scene: VideoScene; base64: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function keep() {
    setBusy(true);
    setFailed(false);
    const bytes = Uint8Array.from(atob(p.base64), (ch) => ch.charCodeAt(0));
    const file = new File([bytes], `scene_${p.scene.id}_ai.png`, { type: "image/png" });
    const ok = await p.act(() => videoEditApi.uploadImage(p.id, p.scene.id, file));
    setBusy(false);
    if (ok) p.onDone();
    else setFailed(true);
  }

  return (
    <Modal title="AI generated image" wide onClose={busy ? () => undefined : p.onDone}
           actions={
             <div className="vw-review-actions">
               <button type="button" className="vw-round-btn keep" onClick={keep} disabled={busy}
                       aria-label="Keep the image" title="Keep the image">
                 {busy ? <span className="vw-spin small" /> : <CheckIcon size={18} />}
               </button>
               <button type="button" className="vw-round-btn" onClick={p.onDone} disabled={busy}
                       aria-label="Discard the image" title="Discard">
                 <XIcon />
               </button>
             </div>
           }>
      <div className="stack">
        <img className="vw-ai-preview" src={`data:image/png;base64,${p.base64}`} alt="The generated image" />
        <p className="muted small">
          {busy ? "Adding the image to the scene..." : "Keeping it replaces this scene's current image or clip. The AI edit is used either way."}
        </p>
        {failed && <p className="error-text">Couldn't add the image. Try again.</p>}
      </div>
    </Modal>
  );
}


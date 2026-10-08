import { useEffect, useRef, useState } from "react";
import { videoEditApi } from "../../api/endpoints";
import type { VideoScene } from "../../api/types";
import { ChevronIcon, FilmIcon, SparkleIcon, TrashIcon, UploadIcon } from "../icons/Icons";
import { errorMessage, Modal } from "../ui";
import type { PanelProps } from "./EditorPanels";
import { FontSliders, SceneEditModal } from "./SceneEditModal";
import { AiImageModal, AiReviewModal, AssetPickerModal, ChoiceModal, IMAGE_MAX, IMAGE_TYPES, RemoveMediaModal, StockSearchModal } from "./SceneMedia";
import { fontDefaults, layoutName, withProps } from "./sceneCode";

const GROUP = 5;
const sorted = (scenes: VideoScene[]) => [...scenes].sort((a, b) => a.order - b.order);

/** An AI image being made for a scene. It is not on the scene until the user keeps it. */
type AiJob = { status: "running" } | { status: "ready"; base64: string } | { status: "failed"; error: string };

/** Scenes as rows, like blog2video's editor: grouped by five, each row expands to its details. */
export function SceneList(p: PanelProps & { aiEditsLeft: number | null }) {
  const scenes = sorted(p.project.scenes);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [openGroup, setOpenGroup] = useState<number | null>(0); // one group of five open at a time, the first to start
  const [editing, setEditing] = useState<VideoScene | null>(null);
  const [adding, setAdding] = useState<number | null>(null); // position for the new scene
  const [deleting, setDeleting] = useState<VideoScene | null>(null); // scene in the delete warning
  // AI images per scene id. Kept here, not in the scene's row, so collapsing the row does not lose one; leaving the
  // editor mid-way does (as on blog2video).
  const [aiJobs, setAiJobs] = useState<Record<number, AiJob>>({});
  const [reviewing, setReviewing] = useState<number | null>(null); // scene id whose generated image is on screen
  const summary = p.project.summary;

  /** Runs in the background (not through act, so other edits carry on); the review opens when it is done. */
  async function generateAi(sceneId: number, prompt: string) {
    setAiJobs((j) => ({ ...j, [sceneId]: { status: "running" } }));
    try {
      const out = await videoEditApi.generateImage(p.id, sceneId, prompt);
      setAiJobs((j) => ({ ...j, [sceneId]: { status: "ready", base64: out.image_base64 } }));
      setReviewing((r) => r ?? sceneId);
    } catch (e) {
      setAiJobs((j) => ({ ...j, [sceneId]: { status: "failed", error: errorMessage(e) } }));
    }
  }

  function closeReview(sceneId: number) {
    setAiJobs(({ [sceneId]: _gone, ...rest }) => rest);
    // Another scene's image may be waiting too.
    const next = Object.entries(aiJobs).find(([id, j]) => Number(id) !== sceneId && j.status === "ready");
    setReviewing(next ? Number(next[0]) : null);
  }

  const reviewScene = reviewing === null ? undefined : scenes.find((sc) => sc.id === reviewing);
  const reviewJob = reviewing === null ? undefined : aiJobs[reviewing];

  const groups: VideoScene[][] = [];
  for (let i = 0; i < scenes.length; i += GROUP) groups.push(scenes.slice(i, i + GROUP));

  return (
    <div className="stack">
      <div className="vw-scenes-head">
        <h2>{p.project.name}</h2>
        <span className="muted">
          {summary?.scenes ?? scenes.length} scenes{summary ? `: ${summary.images} images, ${summary.clips ?? 0} stock clips` : ""}. Click <strong className="vw-accent">Edit</strong> on
          any scene to change it.
        </span>
      </div>

      {groups.map((group, g) => {
        const first = g * GROUP + 1;
        const open = openGroup === g;
        return (
          <section key={g} className="vw-group">
            <button type="button" className="vw-group-head" aria-expanded={open}
                    onClick={() => setOpenGroup(open ? null : g)}>
              <span>Scenes {first}–{first + group.length - 1}</span>
              <ChevronIcon size={18} className={`chevron${open ? " open" : ""}`} />
            </button>
            {open && group.map((s) => {
              const i = scenes.indexOf(s);
              const isOpen = expanded === s.id;
              return (
                <div key={s.id} className={`vw-scene-row${isOpen ? " open" : ""}`}>
                  <div className="vw-scene-main">
                    <div className="vw-scene-line">
                      <span className="vw-num-badge">{i + 1}</span>
                      <button type="button" className="vw-scene-title" onClick={() => setExpanded(isOpen ? null : s.id)}>
                        {s.title || `Scene ${i + 1}`}
                      </button>
                      <div className="vw-scene-actions">
                        <button className="btn btn-small vw-soft" disabled={p.disabled} onClick={() => setEditing(s)}>Edit</button>
                        <span className={`vw-pill${s.layout ? " ok" : ""}`}>Scene</span>
                        <span className={`vw-pill${s.audio_url ? " ok" : ""}`}>Audio</span>
                        <span className="muted small mono">{Number(s.duration_seconds ?? 0).toFixed(1)}s</span>
                        <button type="button" className="icon-btn" aria-label={isOpen ? "Collapse" : "Expand"}
                                onClick={() => setExpanded(isOpen ? null : s.id)}>
                          <ChevronIcon size={18} className={`chevron${isOpen ? " open" : ""}`} />
                        </button>
                        <button type="button" className="icon-btn vw-trash-btn" aria-label={`Delete scene ${i + 1}`} title="Delete scene"
                                disabled={p.disabled} onClick={() => setDeleting(s)}>
                          <TrashIcon size={18} />
                        </button>
                      </div>
                    </div>
                    {isOpen && <SceneDetail {...p} scene={s} aiJob={aiJobs[s.id]}
                                            onGenerateAi={(prompt) => generateAi(s.id, prompt)}
                                            onReviewAi={() => setReviewing(s.id)}
                                            onDismissAi={() => setAiJobs(({ [s.id]: _gone, ...rest }) => rest)} />}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}

      {scenes.length === 0 && (
        <button className="btn" disabled={p.disabled} onClick={() => setAdding(1)}>＋ Add the first scene</button>
      )}

      {editing && (
        <SceneEditModal id={p.id} scene={editing} index={scenes.findIndex((s) => s.id === editing.id)} template={p.project.template}
                        aiEditsLeft={p.aiEditsLeft} onClose={() => setEditing(null)}
                        layoutInfo={p.layoutInfo} layoutNames={p.layoutNames}
                        onSaved={(msg) => { setEditing(null); p.act(async () => undefined, msg); }} />
      )}
      {reviewScene && reviewJob?.status === "ready" && (
        <AiReviewModal {...p} scene={reviewScene} base64={reviewJob.base64} onDone={() => closeReview(reviewScene.id)} />
      )}
      {deleting && (
        <DeleteSceneModal {...p} scene={deleting} number={scenes.findIndex((sc) => sc.id === deleting.id) + 1}
                          onClose={() => setDeleting(null)} />
      )}
      {adding !== null && (
        <AddSceneModal position={adding} onClose={() => setAdding(null)}
                       onAdd={(prompt) => {
                         setAdding(null);
                         return p.startJob("Adding a scene", () => videoEditApi.addScene(p.id, prompt, adding), () => videoEditApi.addSceneStatus(p.id));
                       }} />
      )}
    </div>
  );
}

/** Delete one scene. Stays open (and loading) until it is deleted and the video reloaded; act then refreshes the
 * live preview and the row is gone from the list. */
function DeleteSceneModal(p: PanelProps & { scene: VideoScene; number: number; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function remove() {
    setBusy(true);
    setFailed(false);
    const ok = await p.act(() => videoEditApi.deleteScene(p.id, p.scene.id));
    setBusy(false);
    if (ok) p.onClose();
    else setFailed(true);
  }

  return (
    // While the delete runs, Escape, the backdrop and the close button do nothing.
    <Modal title={`Delete scene ${p.number}?`} onClose={busy ? () => undefined : p.onClose}>
      <div className="stack">
        <p>
          "<strong>{p.scene.title || `Scene ${p.number}`}</strong>" and its voiceover will be deleted from this video.
          This can't be undone.
        </p>
        {failed && <p className="error-text">Couldn't delete the scene. Try again.</p>}
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

function AddSceneModal({ position, onClose, onAdd }: { position: number; onClose: () => void; onAdd: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState("");
  return (
    <Modal title={`Add a scene at position ${position}`} onClose={onClose}>
      <div className="stack">
        <textarea className="input" rows={3} maxLength={2000} autoFocus value={prompt} placeholder="What should the new scene cover?"
                  onChange={(e) => setPrompt(e.target.value)} />
        <p className="muted small">AI writes the scene, its narration and its layout. Uses 1 AI edit.</p>
        <div className="vw-nav">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={prompt.trim().length < 3} onClick={() => onAdd(prompt.trim())}>Add scene</button>
        </div>
      </div>
    </Modal>
  );
}

/** The expanded row: display text, visual description, layout, typography, audio, images and footage. */
function SceneDetail(p: PanelProps & { scene: VideoScene; aiEditsLeft: number | null; aiJob?: AiJob; onGenerateAi: (prompt: string) => void;
                                       onReviewAi: () => void; onDismissAi: () => void }) {
  const s = p.scene;
  const [title, setTitle] = useState<number | null>(s.title_font_size ?? null);
  const [desc, setDesc] = useState<number | null>(s.desc_font_size ?? null);
  // Which media modal is open: the AI prompt, the image / stock choice, the existing-media pickers, the stock search.
  const [modal, setModal] = useState<"ai" | "image" | "stock" | "pick-image" | "pick-clip" | "search" | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ filename: string; kind: string } | null>(null); // media in the remove modal
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  // Which font sizes are changed but not yet saved and applied; their spinners show until the save (and the reload
  // that applies it) finishes. saveSeq tells a finished save whether a newer change is already waiting.
  const [fontSaving, setFontSaving] = useState({ title: false, desc: false });
  const saveSeq = useRef(0);
  const imageInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // Font sizes save by themselves a moment after the slider stops, like blog2video.
  function setFont(kind: "title" | "desc", value: number | null) {
    const next = { title, desc, [kind]: value };
    if (kind === "title") setTitle(value);
    else setDesc(value);
    setFontSaving((f) => ({ ...f, [kind]: true }));
    const seq = ++saveSeq.current;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await p.act(() => videoEditApi.updateScene(p.id, s.id, {
        remotion_code: withProps(s, p.project.template, { titleFontSize: next.title ?? undefined,
                                                         descriptionFontSize: next.desc ?? undefined }),
      }));
      if (saveSeq.current === seq) setFontSaving({ title: false, desc: false });
    }, 500);
  }

  async function upload(f: File) {
    setUploadError(null);
    if (!IMAGE_TYPES.includes(f.type) || f.size > IMAGE_MAX) {
      setUploadError("Pick a PNG, JPEG or WebP image of 5 MB or less.");
      return;
    }
    setUploading(true);
    await p.act(() => videoEditApi.uploadImage(p.id, s.id, f));
    setUploading(false);
  }

  const aiRunning = p.aiJob?.status === "running";

  return (
    <div className="vw-scene-detail">
      <div className="vw-detail-block">
        <span className="vw-label">Display text</span>
        <p>{s.display_text || <span className="muted">None</span>}</p>
      </div>
      {s.visual_description && (
        <div className="vw-detail-block">
          <span className="vw-label">Visual description</span>
          <p className="muted"><em>{s.visual_description}</em></p>
        </div>
      )}
      <div className="vw-detail-block">
        <span className="vw-label">Layout</span>
        <span className="vw-layout-pill">{layoutName(s.layout, p.layoutNames)}</span>
      </div>
      <div className="vw-detail-block vw-narrow">
        <FontSliders title={title} desc={desc} defaults={fontDefaults(p.layoutSchema, s.layout, p.project.aspect_ratio)} saving={fontSaving}
                     onTitle={(v) => setFont("title", v)} onDesc={(v) => setFont("desc", v)} />
      </div>
      <div className="vw-detail-block">
        <span className="vw-label">Audio</span>
        <div className="row wrap">
          {s.audio_url ? <audio className="vw-audio" src={s.audio_url} controls preload="metadata" /> : <span className="muted">No voiceover yet.</span>}
        </div>
      </div>
      <div className="stack">
        <div className="vw-detail-block">
          <span className="vw-label">Images/footage ({s.images?.length ?? 0})</span>
          <div className="vw-tiles">
            {(s.images ?? []).map((img) => (
              <div key={img.filename} className="vw-tile">
                {img.kind === "video" ? <video src={img.url} muted /> : <img src={img.url} alt="" loading="lazy" />}
                <button type="button" className="vw-tile-x" aria-label="Remove from scene" disabled={p.disabled}
                        onClick={() => setRemoving({ filename: img.filename, kind: img.kind })}>✕</button>
              </div>
            ))}
            {aiRunning && (
              <div className="vw-tile loading" aria-label="Generating an image"><span className="vw-spin" /></div>
            )}
            {uploading && (
              <div className="vw-tile loading" aria-label="Uploading the image"><span className="vw-spin" /></div>
            )}
            {/* Add tiles: icon in a tinted circle, label under it */}
            <button type="button" className="vw-tile add ai" title="Generate an image with AI (1 AI edit)"
                    disabled={p.disabled || aiRunning} onClick={() => setModal("ai")}>
              <span className="vw-tile-icon"><SparkleIcon size={18} /></span>
              <small>AI image</small>
            </button>
            <button type="button" className="vw-tile add" title="Use an existing image or upload one"
                    disabled={p.disabled || uploading} onClick={() => setModal("image")}>
              <span className="vw-tile-icon"><UploadIcon size={18} /></span>
              <small>Image</small>
            </button>
            <button type="button" className="vw-tile add" title="Reuse a clip or find a new one"
                    disabled={p.disabled} onClick={() => setModal("stock")}>
              <span className="vw-tile-icon"><FilmIcon size={18} /></span>
              <small>Stock footage</small>
            </button>
            <input ref={imageInput} type="file" accept={IMAGE_TYPES.join(",")} hidden
                   onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
          </div>
          {aiRunning && <p className="vw-media-status"><span className="vw-spin small" /> Generating image...</p>}
          {p.aiJob?.status === "ready" && (
            <p className="vw-media-status">
              Your AI image is ready. <button type="button" className="link-btn" onClick={p.onReviewAi}>Review it</button>
            </p>
          )}
          {p.aiJob?.status === "failed" && (
            <p className="error-text">
              {p.aiJob.error} <button type="button" className="link-btn" onClick={p.onDismissAi}>Dismiss</button>
            </p>
          )}
          {uploadError && <p className="error-text">{uploadError}</p>}
        </div>
      </div>

      {modal === "ai" && (
        <AiImageModal scene={s} aiEditsLeft={p.aiEditsLeft} onClose={() => setModal(null)}
                      onGenerate={(prompt) => { setModal(null); p.onGenerateAi(prompt); }} />
      )}
      {modal === "image" && (
        <ChoiceModal title="Add scene image" subtitle="Choose where to pick the image from."
                     existing="Use existing images" fresh="Upload image file" freshIcon={<UploadIcon size={22} />}
                     onClose={() => setModal(null)}
                     onPick={(c) => { setModal(c === "existing" ? "pick-image" : null); if (c === "new") imageInput.current?.click(); }} />
      )}
      {modal === "stock" && (
        <ChoiceModal title="Add stock footage" subtitle="Reuse a clip this video already has, or find a new one."
                     existing="Choose existing stock footage" fresh="Add a new one" freshIcon={<FilmIcon size={22} />}
                     onClose={() => setModal(null)} onPick={(c) => setModal(c === "existing" ? "pick-clip" : "search")} />
      )}
      {modal === "pick-image" && (
        <AssetPickerModal {...p} scene={s} kind="image" onClose={() => setModal(null)}
                          onNew={() => { setModal(null); imageInput.current?.click(); }} />
      )}
      {modal === "pick-clip" && (
        <AssetPickerModal {...p} scene={s} kind="video" onClose={() => setModal(null)} onNew={() => setModal("search")} />
      )}
      {modal === "search" && <StockSearchModal {...p} scene={s} onClose={() => setModal(null)} />}

      {removing && <RemoveMediaModal {...p} scene={s} filename={removing.filename} kind={removing.kind} onClose={() => setRemoving(null)} />}
    </div>
  );
}

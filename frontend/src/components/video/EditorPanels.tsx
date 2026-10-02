import { useEffect, useState, type ReactNode } from "react";
import { videoEditApi, type LayoutInfo, type LayoutSchema } from "../../api/endpoints";
import type {
  VideoCatalog,
  VideoJobState,
  VideoProjectData,
  VideoScene,
} from "../../api/types";
import { ChevronIcon, TrashIcon } from "../icons/Icons";
import { ConfirmButton, errorMessage } from "../ui";
import { Premium } from "./parts";
import { DeleteAssetModal, RemoveMediaModal } from "./SceneMedia";
import { Voiceovers } from "./Voiceovers";

/** What every panel gets from the editor page. */
export type PanelProps = {
  id: string;
  project: VideoProjectData;
  /** The template's layout_prop_schema (default font sizes per layout); null until loaded or if it failed. */
  layoutSchema: LayoutSchema | null;
  /** The template's display names per layout id; null until loaded or if it failed. */
  layoutNames: Record<string, string> | null;
  /** Every layout of the template with its visual variants (Scene layout / Scene style in the scene editor). */
  layoutInfo: LayoutInfo | null;
  disabled: boolean;
  premium: boolean;
  /** Run a quick change, then reload the project. Resolves true on success, false when it failed. */
  act: (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;
  /** Start a background job and poll it until it finishes. */
  startJob: (label: string, start: () => Promise<unknown>, poll: () => Promise<VideoJobState | null>) => Promise<void>;
  locked: () => void;
};

const sorted = (scenes: VideoScene[]) => [...scenes].sort((a, b) => a.order - b.order);

// Audio: each scene's voiceover

/** Audio tab: each scene's voiceover, to play or record again. */
export function VoicePanel(p: PanelProps & { catalog: VideoCatalog | null }) {
  return <Voiceovers {...p} scenes={sorted(p.project.scenes)} />;
}

// Refresh the script: new titles and layouts, same narration

export function ScriptPanel(p: PanelProps) {
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadPreview() {
    setError(null);
    try {
      setPreview(await videoEditApi.refreshPreview(p.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <section className="card stack">
      <h3>Refresh the script</h3>
      <p className="muted small">Rewrites titles, on-screen text and layouts. The narration and voiceovers stay.</p>
      <textarea className="input" rows={2} value={instruction} maxLength={2000} placeholder="Anything to change (optional)"
                onChange={(e) => setInstruction(e.target.value)} />
      <div className="row wrap">
        <button className="btn btn-primary btn-small" disabled={p.disabled}
                onClick={() => p.startJob("Refreshing the script", () => videoEditApi.refreshScript(p.id, instruction || undefined),
                                          () => videoEditApi.refreshStatus(p.id))}>
          Refresh
        </button>
        <button className="btn btn-small" disabled={p.disabled} onClick={loadPreview}>See the last result</button>
        <button className="btn btn-small" disabled={p.disabled}
                onClick={() => p.act(() => videoEditApi.refreshVerify(p.id), "Checked.")}>Check it</button>
        <button className="btn btn-small" disabled={p.disabled}
                onClick={() => p.startJob("Refreshing the script", () => videoEditApi.refreshRetry(p.id, instruction || undefined),
                                          () => videoEditApi.refreshStatus(p.id))}>
          Try again
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {preview && <pre className="vw-pre">{JSON.stringify(preview, null, 2)}</pre>}
    </section>
  );
}

// AI chat editing ★

type ChatLine = { role: "user" | "assistant"; text: string };

export function ChatPanel(p: PanelProps) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [message, setMessage] = useState("");
  const [conversation, setConversation] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!p.premium) return;
    videoEditApi.chatHistory(p.id).then((h) => {
      const list = (Array.isArray(h) ? h : (h as { messages?: unknown[] })?.messages ?? []) as { role?: string; content?: string; message?: string }[];
      setLines(list.map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.content ?? m.message ?? "" })));
    }).catch(() => undefined);
  }, [p.id, p.premium]);

  if (!p.premium) {
    return (
      <section className="card notice row between wrap">
        <span>Edit the video by chatting with AI. <Premium small /></span>
        <button className="btn btn-small btn-primary" onClick={p.locked}>See plans</button>
      </section>
    );
  }

  async function send() {
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    setLines((l) => [...l, { role: "user", text }]);
    setMessage("");
    try {
      const res = await videoEditApi.chat(p.id, text, conversation);
      if (res.conversation_id) setConversation(res.conversation_id);
      setLines((l) => [...l, { role: "assistant", text: String(res.reply ?? res.message ?? res.response ?? "Done.") }]);
      await p.act(async () => undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h3>Edit with AI chat <span className="muted small">(1 AI edit per message)</span></h3>
      <div className="vw-chat">
        {lines.length === 0 && <p className="muted">Ask for changes, like "make scene 2 shorter" or "use warmer colors".</p>}
        {lines.map((l, i) => <p key={i} className={`vw-chat-line ${l.role}`}>{l.text}</p>)}
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <input className="input" value={message} maxLength={4000} disabled={busy || p.disabled} placeholder="Ask for a change"
               onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
        <button className="btn btn-primary btn-small" disabled={busy || p.disabled || !message.trim()} onClick={send}>
          {busy ? "Working..." : "Send"}
        </button>
      </div>
    </section>
  );
}

// Avatars ★: a talking presenter on chosen scenes

export function AvatarPanel(p: PanelProps) {
  const scenes = sorted(p.project.scenes);
  const [picked, setPicked] = useState<number[]>([]);
  const [progress, setProgress] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (p.premium) videoEditApi.avatarProgress(p.id).then(setProgress).catch(() => undefined);
  }, [p.id, p.premium, p.project]);

  if (!p.premium) {
    return (
      <section className="card notice row between wrap">
        <span>Add a talking presenter to your scenes. <Premium small /></span>
        <button className="btn btn-small btn-primary" onClick={p.locked}>See plans</button>
      </section>
    );
  }

  const toggle = (sid: number) => setPicked((l) => (l.includes(sid) ? l.filter((x) => x !== sid) : [...l, sid]));

  return (
    <div className="stack">
      <section className="card stack">
        <h3>Presenter avatars <span className="muted small">(10 AI edits per scene)</span></h3>
        <div className="stack">
          {scenes.map((s) => (
            <label key={s.id} className="vw-option row between">
              <span>
                <input type="checkbox" checked={picked.includes(s.id)} disabled={!!s.avatar_credits_refunded}
                       onChange={() => toggle(s.id)} /> {s.order}. {s.title}
              </span>
              {s.avatar_video_path && (
                <ConfirmButton className="btn btn-small" onConfirm={() => p.act(() => videoEditApi.deleteAvatar(p.id, s.id), "Avatar removed.")}>
                  Remove avatar
                </ConfirmButton>
              )}
            </label>
          ))}
        </div>
        <div className="row wrap">
          <button className="btn btn-primary btn-small" disabled={p.disabled || picked.length === 0}
                  onClick={() => p.act(async () => {
                    await videoEditApi.authorizeAvatars(p.id, picked);
                    await Promise.all(picked.map((sid) => videoEditApi.makeAvatar(p.id, sid)));
                    setPicked([]);
                  }, "Avatars are being made. They appear as each one finishes.")}>
            Make avatars for {picked.length} scene{picked.length === 1 ? "" : "s"} ({picked.length * 10} AI edits)
          </button>
        </div>
        {progress && <pre className="vw-pre small">{JSON.stringify(progress, null, 2)}</pre>}
      </section>
      <section className="card stack">
        <h3>Your own presenter photo</h3>
        <input className="input" type="file" accept="image/*" disabled={p.disabled}
               onChange={(e) => { const f = e.target.files?.[0]; if (f) p.act(() => videoEditApi.uploadPortrait(p.id, f), "Photo uploaded."); }} />
        <div>
          <ConfirmButton className="btn btn-small" onConfirm={() => p.act(() => videoEditApi.deletePortrait(p.id), "Back to the built-in presenters.")}>
            Use the built-in presenters
          </ConfirmButton>
        </div>
      </section>
    </div>
  );
}

// Frames: a still of any frame

export function FramesPanel(p: PanelProps) {
  const [frame, setFrame] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setSrc(URL.createObjectURL(await videoEditApi.still(p.id, frame)));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h3>Frame still</h3>
      <div className="row">
        <label className="row small">Frame <input className="input vw-num" type="number" min={0} value={frame}
                                                   onChange={(e) => setFrame(Math.max(0, Number(e.target.value)))} /></label>
        <button className="btn btn-small" disabled={busy} onClick={load}>{busy ? "Rendering..." : "Show frame"}</button>
        {src && <a className="btn btn-small" href={src} download={`frame-${frame}.png`}>Download</a>}
      </div>
      {error && <p className="error-text">{error}</p>}
      {src && <img className="vw-still" src={src} alt={`Frame ${frame}`} />}
    </section>
  );
}

// Images/footage: what each scene shows, and what no scene uses yet

type Media = { key: string; filename: string; kind: string; url: string; assetId: number | null };

/** One image or clip, as a small 16:9 tile: clips get a CLIP badge and play on hover. */
function MediaTile({ m, children }: { m: Media; children?: ReactNode }) {
  const clip = m.kind === "video";
  return (
    <div className="vw-media-tile">
      {clip ? (
        <video src={m.url} muted loop playsInline preload="metadata"
               onMouseEnter={(e) => e.currentTarget.play().catch(() => undefined)} onMouseLeave={(e) => e.currentTarget.pause()} />
      ) : (
        <img src={m.url} alt="" loading="lazy" />
      )}
      {clip && <span className="vw-media-badge mono">Clip</span>}
      <span className="vw-media-name mono" title={m.filename}>{m.filename}</span>
      {children}
    </div>
  );
}

const MEDIA_GROUP = 5;

/** Images and stock footage, laid out like blog2video's editor: what each scene shows, grouped by five, and what no
 * scene uses yet. Put an unused one on a scene, or take one off a scene. */
export function ImagesPanel(p: PanelProps) {
  const scenes = sorted(p.project.scenes);
  const assets = (p.project.assets ?? []).filter((a) => (a.asset_type === "image" || a.asset_type === "video") && !a.excluded && a.r2_url);
  const used = new Set(scenes.flatMap((s) => (s.images ?? []).map((i) => i.filename)));
  const unassigned: Media[] = assets.filter((a) => !used.has(a.filename))
    .map((a) => ({ key: `a${a.id}`, filename: a.filename, kind: a.asset_type, url: a.r2_url!, assetId: a.id }));
  const images = assets.filter((a) => a.asset_type === "image").length;
  const clips = assets.length - images;
  const [openGroup, setOpenGroup] = useState<number | null>(0);
  const [removing, setRemoving] = useState<{ scene: VideoScene; filename: string; kind: string } | null>(null);
  const [deleting, setDeleting] = useState<Media | null>(null);

  const groups: VideoScene[][] = [];
  for (let i = 0; i < scenes.length; i += MEDIA_GROUP) groups.push(scenes.slice(i, i + MEDIA_GROUP));


  return (
    <div className="vw-media-cols">
      <section className="stack">
        <div className="vw-media-head">
          <h3>Images and stock footage</h3>
          <span className="muted small">{images} image{images === 1 ? "" : "s"} · {clips} stock clip{clips === 1 ? "" : "s"}</span>
        </div>
        {groups.map((group, g) => {
          const first = g * MEDIA_GROUP + 1;
          const open = openGroup === g;
          return (
            <section key={g} className="vw-group">
              <button type="button" className="vw-group-head" aria-expanded={open} onClick={() => setOpenGroup(open ? null : g)}>
                <span>Scenes {first}–{first + group.length - 1}</span>
                <ChevronIcon size={18} className={`chevron${open ? " open" : ""}`} />
              </button>
              {open && group.map((s) => (
                <div key={s.id} className="vw-media-scene">
                  <div className="vw-media-scene-title">
                    <span className="vw-num-badge">{s.order}</span>
                    <strong>{s.title || `Scene ${s.order}`}</strong>
                  </div>
                  <div className="vw-media-grid">
                    {(s.images ?? []).map((i) => (
                      <MediaTile key={i.filename} m={{ key: i.filename, filename: i.filename, kind: i.kind, url: i.url, assetId: i.asset_id }}>
                        <button type="button" className="vw-media-x" aria-label={`Remove from scene ${s.order}`} title="Remove from scene"
                                disabled={p.disabled} onClick={() => setRemoving({ scene: s, filename: i.filename, kind: i.kind })}>✕</button>
                      </MediaTile>
                    ))}
                    {(s.images ?? []).length === 0 && <span className="muted small">No media</span>}
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </section>

      <section className="stack">
        <div className="vw-media-head">
          <h3>Unassigned</h3>
          <span className="muted small">not used in any scene</span>
        </div>
        {unassigned.length === 0 ? (
          <p className="muted small">Every image and clip is on a scene.</p>
        ) : (
          <div className="vw-media-grid vw-unassigned">
            {unassigned.map((m) => (
              <MediaTile key={m.key} m={m}>
                {m.assetId !== null && (
                  <button type="button" className="vw-media-del" aria-label="Delete permanently" title="Delete permanently"
                          disabled={p.disabled} onClick={() => setDeleting(m)}>
                    <TrashIcon size={15} />
                  </button>
                )}
              </MediaTile>
            ))}
          </div>
        )}
      </section>

      {removing && <RemoveMediaModal {...p} scene={removing.scene} filename={removing.filename} kind={removing.kind}
                                     onClose={() => setRemoving(null)} />}
      {deleting && deleting.assetId !== null && (
        <DeleteAssetModal {...p} asset={{ id: deleting.assetId, kind: deleting.kind }} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

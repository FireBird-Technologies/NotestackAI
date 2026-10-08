import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../../api/client";
import { artifactsApi, launchpadApi, videoEditApi, videosApi } from "../../api/endpoints";
import type { PostableArtifact } from "../../api/types";
import { ArrowRightIcon, DownloadIcon, FilmIcon, HeadphonesIcon, SlidesIcon, SparkleIcon, UploadIcon } from "../icons/Icons";
import { errorMessage, formatDate, Loading, Modal } from "../ui";
import { finished, jobPercent } from "../video/jobState";

/** X's video limit for standard accounts (2:20): longer videos go to LinkedIn only. */
export const X_VIDEO_SECONDS = 140;

export const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** "4 images", "Video 1:12", "Text": what the post carries. */
export function mediaLabel(a: PostableArtifact): string {
  if (a.type === "upload") {
    return a.media === "video" ? `Your video${a.duration_s ? ` ${fmtDuration(a.duration_s)}` : ""}` : "Your image";
  }
  if (a.media === "audio") return `Audio${a.duration_s ? ` ${fmtDuration(a.duration_s)}` : ""} · download only`;
  if (a.media === "video" && a.rendering) return "Rendering: wait for it to finish";
  if (a.media === "video" && a.needs_render) return "Not rendered yet: render it first";
  if (a.media === "video") return a.duration_s ? `Video ${fmtDuration(a.duration_s)}` : "Video";
  if (a.type === "slide_deck") {
    // X takes 4 images and LinkedIn 20 (backend app/services/social/media.py MAX_IMAGES): longer decks are cut there.
    const n = a.media_count;
    const cut = n > 20 ? " · X posts the first 4, LinkedIn the first 20" : n > 4 ? " · X posts the first 4" : "";
    return `${n} slide${n === 1 ? "" : "s"} as images${cut}`;
  }
  if (a.media === "image") return a.media_count === 1 ? "Image" : `${a.media_count} images`;
  return "Text";
}

function Thumb({ a }: { a: PostableArtifact }) {
  if (a.thumb_url) return <img className="lp-thumb" src={a.thumb_url} alt="" />;
  return (
    <span className="lp-thumb lp-thumb-icon" aria-hidden="true">
      {a.media === "video" ? <FilmIcon size={20} /> : a.media === "audio" ? <HeadphonesIcon size={20} />
        : a.type === "slide_deck" ? <SlidesIcon size={20} /> : <SparkleIcon size={20} />}
    </span>
  );
}

/** Look at an uploaded image or video before posting it. */
export function MediaPreviewModal({ a, onClose }: { a: PostableArtifact; onClose: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <Modal title={a.title} onClose={onClose} wide>
      <div className="stack">
        <div className="lp-preview">
          {failed || !a.view_url ? (
            <p className="muted">Couldn't load this file.</p>
          ) : a.media === "video" ? (
            <video src={a.view_url} controls autoPlay playsInline onError={() => setFailed(true)} />
          ) : (
            <img src={a.view_url} alt={a.title} onError={() => setFailed(true)} />
          )}
        </div>
        <p className="muted small">{mediaLabel(a)}</p>
      </div>
    </Modal>
  );
}

/** An audio overview someone tried to schedule: X and LinkedIn take no audio files, so it is offered to download
 * instead. Used by the Launchpad's list and the Library. */
export function AudioOnlyModal({ title, downloadUrl, onClose }: { title: string; downloadUrl: string | null | undefined; onClose: () => void }) {
  return (
    <Modal title="Audio can't be posted" onClose={onClose}>
      <div className="stack lp-audio-only">
        <span className="lp-audio-only-icon" aria-hidden="true"><HeadphonesIcon size={28} /></span>
        <p>
          LinkedIn does not support posting audio files, so <strong>{title}</strong> can't be scheduled. Download it now
          to use it elsewhere, like a podcast app, your newsletter or a website.
        </p>
        <div className="row lp-audio-only-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {downloadUrl ? (
            <a className="btn btn-primary" href={downloadUrl} download onClick={onClose} autoFocus>
              <DownloadIcon size={18} /> Download
            </a>
          ) : (
            <span className="muted small">The file isn't available right now. Try again later.</span>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** The attached item: thumbnail, title, what it carries, and Change / Remove. An uploaded file's thumbnail opens its
 * preview. */
export function AttachmentChip({ a, onChange, onRemove }: {
  a: PostableArtifact;
  onChange?: () => void;
  onRemove?: () => void;
}) {
  const [previewing, setPreviewing] = useState(false);
  return (
    <div className="lp-attach">
      {a.view_url ? (
        <button type="button" className="lp-thumb-btn" aria-label={`Preview ${a.title}`} title="Preview"
                onClick={() => setPreviewing(true)}>
          <Thumb a={a} />
        </button>
      ) : <Thumb a={a} />}
      {previewing && <MediaPreviewModal a={a} onClose={() => setPreviewing(false)} />}
      <span className="lp-attach-text">
        <strong>{a.title}</strong>
        <span className="muted small">{a.type_label} · {mediaLabel(a)}</span>
      </span>
      {onChange && <button type="button" className="btn btn-small" onClick={onChange}>Change</button>}
      {onRemove && <button type="button" className="btn btn-small" onClick={onRemove}>Remove</button>}
    </div>
  );
}

type RenderStep = "confirm" | "rendering" | "done" | "failed";

/** The furthest each video's render has got, kept across opens of the pop-up: blog2video can answer 0% for a while
 * (preparing, or a poll that misses its progress), and reopening must not drop the bar back to 0. */
const renderPct = new Map<string, number>();

/** Render a video that has no MP4 yet, from the Library list: asks first, then shows the render's progress here.
 * Opened on a video already rendering, it says to wait and shows that render's progress. Closing it mid-render
 * leaves the render running (the row shows Rendering). */
export function RenderVideoModal({ video, onClose, onRendered }: {
  video: PostableArtifact;
  onClose: () => void;
  /** The MP4 is made: schedule it (the picker reloads the item and opens the composer with it). */
  onRendered: (id: string, schedule: boolean) => void;
}) {
  const waiting = video.rendering; // opened on a render already under way: scheduling waits for it
  const [step, setStep] = useState<RenderStep>(waiting ? "rendering" : "confirm");
  const [pct, setPct] = useState<number | null>(() => renderPct.get(video.id) ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The latest callback, so a parent re-render doesn't restart the polling below.
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  // While rendering: blog2video's progress for the bar. When it says the job stopped (and every few polls anyway,
  // in case blog2video lost track of the render), /status (which also moves the video to ready with its MP4) says
  // how it ended.
  useEffect(() => {
    if (step !== "rendering") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const tick = async () => {
      try {
        const s = await videoEditApi.renderStatus(video.id);
        if (stopped) return;
        const now = s?.progress_unknown ? null : jobPercent(s);
        if (now !== null) renderPct.set(video.id, Math.max(renderPct.get(video.id) ?? 0, now));
        setPct(renderPct.get(video.id) ?? null);
        if (finished(s) || ++polls % 3 === 0) {
          const st = await videosApi.status(video.id);
          if (stopped) return;
          if (st.artifact_status !== "rendering") {
            renderPct.delete(video.id);
            if (st.video_url && !st.error) {
              setStep("done");
              onRenderedRef.current(video.id, false); // the list shows it as ready behind the modal
            } else {
              setError(st.error ?? "The render stopped before the MP4 was made.");
              setStep("failed");
            }
            return;
          }
        }
      } catch {
        // a missed poll: try again on the next one
      }
      if (!stopped) timer = setTimeout(tick, 4000);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [step, video.id]);

  const render = async () => {
    setBusy(true);
    setError(null);
    try {
      await videoEditApi.render(video.id);
      renderPct.delete(video.id); // a new run starts from 0
      setPct(null);
      setStep("rendering");
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? "Another change is still running on this video, try again in a moment."
        : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const title = step === "done" ? "Video rendered" : step === "failed" ? "Render failed"
    : waiting ? "Still rendering" : step === "rendering" ? "Rendering your video" : "Render this video?";
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <p><strong>{video.title}</strong></p>
        {step === "confirm" && (
          <p className="muted">It has no MP4 yet, so it can't be posted. Render it now; it takes a few minutes and you can close this while it runs.</p>
        )}
        {step === "rendering" && (
          <>
            <p className="muted">
              {waiting ? "Wait for the render to complete before scheduling it." : "You can close this: the render keeps going and the video shows as Rendering until it's done."}
            </p>
            <span className="vw-render-status lp-render-status" role="status">
              <span className="vw-render-line">
                <span className="vw-spin small" aria-hidden="true" />
                <span>{pct ? "Rendering MP4" : "Preparing the render"}</span>
                {pct ? <span className="mono vw-render-pct">{pct}%</span> : null}
              </span>
              <span className="vw-render-bar" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.min(100, pct ?? 0))}%` }} /></span>
            </span>
          </>
        )}
        {step === "done" && <p className="muted">The MP4 is ready. Schedule it now, or pick it from the list later.</p>}
        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          {step === "confirm" && (
            <>
              <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={render} disabled={busy}>
                {busy ? "Starting..." : "Render"}
              </button>
            </>
          )}
          {step === "rendering" && <button type="button" className="btn" onClick={onClose}>{waiting ? "OK" : "Close"}</button>}
          {step === "failed" && (
            <>
              <button type="button" className="btn" onClick={onClose}>Close</button>
              <button type="button" className="btn btn-primary" onClick={render} disabled={busy}>
                {busy ? "Starting..." : "Try again"}
              </button>
            </>
          )}
          {step === "done" && (
            <>
              <button type="button" className="btn" onClick={onClose}>Close</button>
              <button type="button" className="btn btn-primary" onClick={() => onRendered(video.id, true)}>Schedule it</button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

type MenuItem = { label: string; onSelect: () => void; danger?: boolean };

/** A row's ⋮ button and its menu. The menu is drawn over everything (a portal, placed from the button), so the
 * scrolling list and the pop-up around it never cut it off; it opens upwards near the bottom of the screen. */
function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const up = r.bottom + 8 + items.length * 40 > window.innerHeight;
    setAt({ top: up ? r.top - 6 : r.bottom + 6, left: r.right, up });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) close();
    };
    // Escape closes only the menu, not the pop-up the picker sits in.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
      button.current?.focus();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, at]);

  return (
    <>
      <button ref={button} type="button" className="btn btn-small lp-row-menu-btn" aria-label={`Options for ${label}`}
              aria-haspopup="menu" aria-expanded={open} title="Options" onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>
      {open && at && createPortal(
        <div ref={menu} className="lp-menu" role="menu" aria-label={`Options for ${label}`}
             style={{ top: at.top, left: at.left, transform: `translate(-100%, ${at.up ? "-100%" : "0"})` }}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={`lp-menu-item${it.danger ? " danger" : ""}`}
                    onClick={() => {
                      setOpen(false);
                      it.onSelect();
                    }}>
              {it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** The warning before deleting, by kind: what goes, and what happens to the posts that carry it. */
function deleteWording(a: PostableArtifact): { title: string; body: string } {
  if (a.type === "upload") {
    return { title: "Delete this upload?", body: "The file is deleted for good. Posts on your calendar that carry it are removed too." };
  }
  if (a.type === "launch_kit") {
    return { title: "Delete this launch kit?",
             body: "Its LinkedIn post and hooks are deleted for good. Posts already scheduled from it stay on your calendar." };
  }
  if (a.media === "video") {
    return { title: "Delete this video?",
             body: "It's deleted here and on the video service, for good. Posts on your calendar that carry it are removed too." };
  }
  return { title: "Delete this item?", body: "It's deleted for good. Posts on your calendar that carry it are removed too." };
}

type Kind = "all" | "kits" | "video" | "decks" | "audio" | "uploads";
const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "kits", label: "Launch kits" },
  { id: "video", label: "Videos" },
  { id: "decks", label: "Slide decks" },
  { id: "audio", label: "Audio" },
  { id: "uploads", label: "Uploads" },
];
/** Which rows a tab shows: Videos is only the ones the video service made (uploaded videos are under Uploads). */
const matches = (a: PostableArtifact, kind: Kind) =>
  kind === "all" || (kind === "kits" ? a.type === "launch_kit" : kind === "uploads" ? a.type === "upload"
    : kind === "decks" ? a.type === "slide_deck" : kind === "audio" ? a.type === "audio_overview" : a.editable_video);

/** Saves a file from its (presigned, attachment) link. */
function download(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** What can be uploaded to post, and LinkedIn's size limits for it (checked again by the backend). */
const UPLOAD_ACCEPT = "image/png,image/jpeg,image/gif,video/mp4";
const MB = 1024 * 1024;
function uploadProblem(file: File): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const video = file.type === "video/mp4" || ext === "mp4";
  const image = ["image/png", "image/jpeg", "image/gif"].includes(file.type) || ["png", "jpg", "jpeg", "gif"].includes(ext);
  if (!video && !image) return "LinkedIn takes JPG, PNG or GIF images and MP4 videos.";
  if (image && file.size > 36 * MB) return `This image is ${Math.round(file.size / MB)} MB; LinkedIn takes up to 36 MB.`;
  if (video && file.size > 300 * MB) return `This video is ${Math.round(file.size / MB)} MB; uploads are limited to 300 MB.`;
  if (video && file.size < 75 * 1024) return "This video is too small for LinkedIn (at least 75 KB).";
  return null;
}

/** A video file's length in seconds, read by the browser (null if it can't tell). */
function videoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    const done = (d: number | null) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}

/** Pick something made to attach to a post (audio is never offered: X and LinkedIn take no audio files), in a
 * pop-up (the composer, editing a scheduled post). */
export function AttachPicker({ onPick, onCreateKit, onClose }: {
  onPick: (a: PostableArtifact) => void;
  onCreateKit?: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Attach from your Library" onClose={onClose} wide>
      <LibraryPicker onPick={onPick} onCreateKit={onCreateKit} />
    </Modal>
  );
}

/** What can go out with a post: everything postable in the Library, your Launch Kits, or your videos (tabs), and
 * searchable; with a link to create a new launch kit when onCreateKit is given. onPickKit, when given, takes the
 * Launch Kits instead of onPick (the Schedule a launch page opens the kit, to schedule its posts from there). A video
 * with no MP4 yet (or one rendering) opens the render pop-up instead. fill: the rows take the screen's height. */
export function LibraryPicker({ onPick, onPickKit, onCreateKit, fill = false, onReschedule, onDuplicate, refreshKey = 0, openingId }: {
  onPick: (a: PostableArtifact) => void;
  onPickKit?: (a: PostableArtifact) => void;
  onCreateKit?: () => void;
  fill?: boolean;
  /** With these (the Schedule a launch page), an item already scheduled says Reschedule and opens that post
   * (`itemId`), and its menu can schedule it again (a copy of that post). Without them (the composer's picker), every
   * item is simply picked. */
  onReschedule?: (a: PostableArtifact, itemId: string) => void;
  onDuplicate?: (a: PostableArtifact, itemId: string) => void;
  /** Changed by the page to load the list again (a post was rescheduled, moved or deleted). */
  refreshKey?: number;
  /** The item whose scheduled post is being opened: its row shows a spinner and takes no clicks meanwhile. */
  openingId?: string | null;
}) {
  const [items, setItems] = useState<PostableArtifact[] | null>(null);
  const [kind, setKind] = useState<Kind>("all");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState<PostableArtifact | null>(null); // the video in the render pop-up
  const navigate = useNavigate();
  const [uploading, setUploading] = useState<string | null>(null); // the file name being uploaded
  const [dragging, setDragging] = useState(false); // a file is held over the drop area
  const [renaming, setRenaming] = useState<{ id: string; title: string; busy?: boolean } | null>(null);
  const [previewing, setPreviewing] = useState<PostableArtifact | null>(null); // the upload being looked at
  const [audio, setAudio] = useState<PostableArtifact | null>(null); // an audio overview: offered to download, not posted
  const [deleting, setDeleting] = useState<PostableArtifact | null>(null); // the item in the delete pop-up
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** Delete an item after its warning: an upload (record and stored file too), a video (also on blog2video), a kit... */
  const deleteItem = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await artifactsApi.remove(deleting.id);
      setItems((list) => list?.filter((x) => x.id !== deleting.id) ?? list);
      setDeleting(null);
    } catch (e) {
      setDeleteError(errorMessage(e));
    } finally {
      setDeleteBusy(false);
    }
  };

  /** An uploaded file's name, as the picker and the composer show it (the file itself keeps its name). */
  const saveName = async () => {
    if (!renaming) return;
    const title = renaming.title.trim();
    if (!title) return setError("Give it a name.");
    setRenaming({ ...renaming, busy: true });
    try {
      await artifactsApi.update(renaming.id, { title });
      setItems((list) => list?.map((x) => (x.id === renaming.id ? { ...x, title } : x)) ?? list);
      setRenaming(null);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      setRenaming((cur) => cur && { ...cur, busy: false });
    }
  };
  const fileInput = useRef<HTMLInputElement>(null);

  /** A file from the computer: uploaded, made postable, then picked like anything else. */
  const upload = async (file: File) => {
    const problem = uploadProblem(file);
    if (problem) return setError(problem);
    setError(null);
    setUploading(file.name);
    try {
      const seconds = file.type === "video/mp4" || file.name.toLowerCase().endsWith(".mp4") ? await videoDuration(file) : null;
      const item = await launchpadApi.uploadToPost(file, seconds ?? undefined);
      void load().catch(() => undefined);
      onPick(item);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(null);
    }
  };

  const load = useCallback(() => launchpadApi.postable(q).then((list) => {
    setItems(list);
    return list;
  }), [q, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(() => {
      load().catch((e) => setError(errorMessage(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [load]);

  // Videos rendering (from here, the editor, or another tab): check on them, and reload once one is done.
  const renderingIds = useMemo(() => (items ?? []).filter((a) => a.rendering).map((a) => a.id).join(","), [items]);
  useEffect(() => {
    if (!renderingIds) return;
    const t = setInterval(async () => {
      const ids = renderingIds.split(",");
      const states = await Promise.all(ids.map((id) => videosApi.status(id).catch(() => null)));
      if (states.some((s) => s && s.artifact_status !== "rendering")) void load().catch(() => undefined);
    }, 8000);
    return () => clearInterval(t);
  }, [renderingIds, load]);

  const rendered = useCallback((id: string, schedule: boolean) => {
    void load().then((list) => {
      if (!schedule) return;
      const found = list.find((a) => a.id === id);
      setRendering(null);
      if (found && !found.needs_render) onPick(found);
    }).catch((e) => setError(errorMessage(e)));
  }, [load, onPick]);

  // Kits only on the Schedule a launch page (they open the kit); as an attachment they are never offered.
  const kits = Boolean(onPickKit);
  const shown = useMemo(() => (items ?? []).filter((a) => (kits || a.type !== "launch_kit") && matches(a, kind)),
                        [items, kind, kits]);

  return (
      <div className="stack">
        <div className="row between wrap">
          <div className="gen-chips" role="group" aria-label="Kind">
            {KINDS.filter((k) => kits || k.id !== "kits").map((k) => (
              <button key={k.id} type="button" className={`chip${kind === k.id ? " on" : ""}`} aria-pressed={kind === k.id}
                      onClick={() => setKind(k.id)}>
                {k.label}
              </button>
            ))}
          </div>
          {/* A LinkedIn post and hooks from one of your posts: its own pages */}
          {onCreateKit && (
            <button type="button" className="lp-kit-link" onClick={onCreateKit}
                    title="A LinkedIn post and hooks from one of your posts">
              Create a new launch kit <ArrowRightIcon size={16} />
            </button>
          )}
        </div>
        {/* Uploads: a drop area for a file from the computer, above the files uploaded before */}
        {kind === "uploads" && (
          <div className={`lp-drop${dragging ? " over" : ""}${uploading ? " busy" : ""}`} role="button" tabIndex={0}
               aria-label="Upload an image or video from your computer" aria-disabled={uploading !== null}
               onClick={() => !uploading && fileInput.current?.click()}
               onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !uploading && fileInput.current?.click()}
               onDragOver={(e) => {
                 if (!e.dataTransfer.types.includes("Files")) return;
                 e.preventDefault();
                 setDragging(true);
               }}
               onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
               onDrop={(e) => {
                 e.preventDefault();
                 setDragging(false);
                 const file = e.dataTransfer.files[0];
                 if (file && !uploading) void upload(file);
               }}>
            <span className="lp-drop-icon" aria-hidden="true">
              {uploading ? <span className="vw-spin" /> : <UploadIcon size={22} />}
            </span>
            {uploading ? (
              <strong>Uploading {uploading}...</strong>
            ) : (
              <>
                <strong>Drop a file here, or <span className="lp-drop-link">browse your computer</span></strong>
                <span className="muted small">JPG, PNG or GIF up to 36 MB · MP4 video up to 300 MB</span>
              </>
            )}
          </div>
        )}
        {/* Outside the drop area, so its click doesn't bubble back into the area's own click */}
        <input ref={fileInput} type="file" accept={UPLOAD_ACCEPT} hidden onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // the same file can be picked again
          if (file) void upload(file);
        }} />
        <input className="input input-sm search" placeholder="Search by title" value={q}
               onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        {error && <p className="error-text">{error}</p>}
        {!items && !error && (
          <div className={`lp-loading${fill ? " fill" : ""}`}><Loading label="Loading your Library" /></div>
        )}
        {items && shown.length === 0 && (
          <p className="muted lp-pick-empty">{kind === "kits" ? "No launch kits yet: create a new one."
            : kind === "uploads" ? "Nothing uploaded yet." : kind === "decks" ? "No slide decks yet: make one from a notebook."
            : kind === "audio" ? "No audio overviews yet: make one from a notebook."
            : "Nothing to attach here yet."}</p>
        )}
        <ul className={`lk-rows lp-pick-rows${fill ? " lp-pick-rows-fill" : ""}`}>
          {shown.map((a) => {
            const kit = a.type === "launch_kit";
            // Already on the calendar (and this list offers it): open that post rather than start another one.
            const next = onReschedule && !kit && a.media !== "audio" ? a.scheduled?.[0] : undefined;
            const opening = openingId === a.id;
            const go = () => opening ? undefined : (a.media === "audio" ? setAudio(a) : a.needs_render || a.rendering ? setRendering(a)
              : next ? onReschedule!(a, next.id) : kit && onPickKit ? onPickKit(a) : onPick(a));
            if (renaming?.id === a.id) {
              return (
                <li key={a.id}>
                  <form className="lk-row lp-rename-row" onSubmit={(e) => {
                    e.preventDefault();
                    void saveName();
                  }}>
                    <Thumb a={a} />
                    <input className="input input-sm" autoFocus value={renaming.title} maxLength={200}
                           aria-label="Name" disabled={renaming.busy}
                           onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
                           onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setRenaming(null))} />
                    <button type="submit" className="btn btn-small btn-primary" disabled={renaming.busy}>
                      {renaming.busy ? "Saving..." : "Save"}
                    </button>
                    <button type="button" className="btn btn-small" disabled={renaming.busy} onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </form>
                </li>
              );
            }
            return (
              <li key={a.id} className="lp-pick-item">
                <button type="button" className="lk-row lp-pick-row" onClick={go} aria-busy={opening}
                        title={a.rendering ? "Rendering: it can be scheduled once the MP4 is made"
                          : a.needs_render ? "Render it, then post it" : undefined}>
                  <Thumb a={a} />
                  <span className="lk-title">
                    <strong>{a.title}</strong>
                    <span className="muted small">
                      {kit ? "LinkedIn post and hooks ready to schedule" : mediaLabel(a)}
                      {next ? ` · Scheduled ${formatDate(next.scheduled_at, true)}${a.scheduled!.length > 1
                        ? ` +${a.scheduled!.length - 1} more` : ""}` : a.created_at ? ` · ${formatDate(a.created_at)}` : ""}
                    </span>
                  </span>
                  <span className={`lp-tag${a.media === "video" ? " video" : kit ? " kit" : a.type === "slide_deck" ? " deck" : ""}`}>
                    {a.type === "upload" ? "Upload" : a.media === "video" ? "Video" : a.media === "audio" ? "Audio" : kit ? "Launch Kit"
                      : a.type_label}
                  </span>
                  <span className="lp-pick-go">
                    {opening ? (
                      <><span className="vw-spin small" aria-hidden="true" /> Opening...</>
                    ) : a.rendering ? (
                      <><span className="vw-spin small" aria-hidden="true" /> Rendering</>
                    ) : (
                      <>{a.needs_render ? "Render it" : kit && onPickKit ? "Open kit" : next ? "Reschedule" : "Schedule"}
                        {" "}<ArrowRightIcon size={14} /></>
                    )}
                  </span>
                </button>
                <RowMenu label={a.title} items={[
                  ...(a.view_url ? [{ label: "Preview", onSelect: () => setPreviewing(a) }] : []),
                  ...(a.download_url ? [{ label: "Download", onSelect: () => download(a.download_url!) }] : []),
                  ...(next && onDuplicate ? [{ label: "Duplicate schedule", onSelect: () => onDuplicate(a, next.id) }] : []),
                  // Several posts of it coming up: each can be opened.
                  ...(next && a.scheduled!.length > 1 ? a.scheduled!.map((sc) => ({
                    label: `Edit schedule: ${formatDate(sc.scheduled_at, true)}`, onSelect: () => onReschedule!(a, sc.id),
                  })) : []),
                  ...(a.type === "upload" ? [{ label: "Rename", onSelect: () => setRenaming({ id: a.id, title: a.title }) }] : []),
                  ...(kit ? [{ label: "Open kit", onSelect: () => (onPickKit ? onPickKit(a) : navigate(`/app/launchpad/kits/${a.id}`)) }]
                    : a.editable_video ? [{ label: "Open", onSelect: () => navigate(`/app/videos/${a.id}`) }] : []),
                  { label: kit ? "Delete kit" : "Delete", danger: true, onSelect: () => {
                    setDeleteError(null);
                    setDeleting(a);
                  } },
                ]} />
              </li>
            );
          })}
        </ul>
        {rendering && <RenderVideoModal video={rendering} onClose={() => setRendering(null)} onRendered={rendered} />}
        {previewing && <MediaPreviewModal a={previewing} onClose={() => setPreviewing(null)} />}
        {audio && <AudioOnlyModal title={audio.title} downloadUrl={audio.download_url} onClose={() => setAudio(null)} />}
        {deleting && (
          <Modal title={deleteWording(deleting).title} onClose={() => !deleteBusy && setDeleting(null)}>
            <div className="stack">
              <p><strong>{deleting.title}</strong></p>
              <p className="muted">{deleteWording(deleting).body}</p>
              {deleteError && <p className="error-text">{deleteError}</p>}
              <div className="row end">
                <button type="button" className="btn" disabled={deleteBusy} onClick={() => setDeleting(null)}>Cancel</button>
                <button type="button" className="btn btn-danger" disabled={deleteBusy} onClick={deleteItem}>
                  {deleteBusy ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
          </Modal>
        )}
      </div>
  );
}

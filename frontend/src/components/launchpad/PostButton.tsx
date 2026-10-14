import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Artifact } from "../../api/types";
import { ScheduleModal } from "../ScheduleModal";
import { Modal } from "../ui";
import { RocketIcon } from "../icons/Icons";
import { AudioOnlyModal } from "./Attachment";

/** What can go out on X / LinkedIn: images (a slide deck's slides, an infographic), videos, a report (its text, or a
 * PDF on LinkedIn), your uploads and text. Not audio (neither platform takes audio files; the Library explains that),
 * and not quizzes, flashcards or Mind Constellations. */
const POSTABLE = new Set(["video", "quote_card", "carousel", "summary", "launch_kit", "slide_deck", "report",
  "infographic", "upload"]);

/** A blog2video video with no MP4 yet: it can be launched once it is rendered. */
export const needsRender = (a: Artifact) =>
  a.provider === "blog2video" && !(a.content as { video_url?: string } | null)?.video_url;

export function canPost(a: Artifact): boolean {
  if (a.type === "audio_overview") return a.status === "ready"; // Launch explains audio can't be posted (download it)
  if (!POSTABLE.has(a.type)) return false;
  if (a.provider === "blog2video") return a.status === "ready" || Boolean((a.content as { video_url?: string } | null)?.video_url);
  return a.status === "ready";
}

/** "Launch": opens the composer with this item attached and its text filled in. A video not rendered yet asks to render
 * it first, and on yes opens the video's page with the render started. */
export function PostButton({ artifactId, artifact, className = "btn btn-small", label = "Launch", iconOnly = false }: {
  artifactId: string;
  /** The item, when the caller has it: tells whether a video still has to be rendered. */
  artifact?: Artifact;
  className?: string;
  label?: string;
  /** Just a rocket (a notebook card's actions), the label as its hover label. */
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const unrendered = !!artifact && needsRender(artifact);
  const audio = artifact?.type === "audio_overview";
  return (
    <>
      {iconOnly ? (
        <button type="button" className={`${className} btn-icon-only card-act-launch`} aria-label={label} onClick={() => setOpen(true)}>
          <RocketIcon size={16} />
        </button>
      ) : (
        <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      )}
      {open && audio && <AudioOnlyModal title={artifact!.title} downloadUrl={artifact!.download_url} onClose={() => setOpen(false)} />}
      {open && !unrendered && !audio && <ScheduleModal platform="linkedin" posts={[]} artifactId={artifactId} onClose={() => setOpen(false)} />}
      {open && unrendered && (
        <Modal title="Render the video first" onClose={() => setOpen(false)}>
          <div className="stack">
            <p className="muted">This video isn't rendered yet. Render it first to go ahead with the launch: its page opens
              and the render starts there.</p>
            <div className="row end">
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={() => navigate(`/app/videos/${artifactId}?render=1`)}>
                Render video
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

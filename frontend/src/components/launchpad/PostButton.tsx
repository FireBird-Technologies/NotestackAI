import { useState } from "react";
import type { Artifact } from "../../api/types";
import { ScheduleModal } from "../ScheduleModal";

/** What can go out on X / LinkedIn: images, videos and text. Not audio (neither platform takes audio files). */
const POSTABLE = new Set(["video", "quote_card", "carousel", "summary", "launch_kit", "mind_map"]);

export function canPost(a: Artifact): boolean {
  if (!POSTABLE.has(a.type)) return false;
  if (a.provider === "blog2video") return Boolean((a.content as { video_url?: string } | null)?.video_url);
  return a.status === "ready";
}

/** "Post": opens the composer with this item attached and its text filled in. */
export function PostButton({ artifactId, className = "btn btn-small", label = "Post" }: {
  artifactId: string;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{label}</button>
      {open && <ScheduleModal platform="linkedin" posts={[]} artifactId={artifactId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A video's list status and helpers, shared by the web and mobile (web: pages/Videos.tsx, pages/VideoEditor.tsx). */
import { videoEditApi } from "./endpoints";
import type { VideoJobState, VideoListItem, VideoProjectData, VideoStatus } from "./types";

/** A file a scene uses, to load before the preview opens. */
export type VideoMedia = { url: string; kind: "audio" | "image" | "video" };

export const JOB_LABELS: Record<string, string> = {
  regenerating: "Changing template",
  voice_regenerating: "Changing voice",
  language_regenerating: "Translating",
  script_regenerating: "Refreshing script",
};

/** blog2video's status, as a label and a dot color. */
export function statusOf(v: VideoListItem): { label: string; tone: "done" | "ready" | "busy" | "review" | "failed" } {
  const raw = v.b2v_status ?? "";
  if (v.status === "failed" || raw === "failed" || raw === "error") return { label: "Failed", tone: "failed" };
  // An edit job on a finished video (blog2video's status, kept on the artifact too). Before "Complete": a video
  // rendered earlier keeps its MP4 link while it is being changed.
  const job = JOB_LABELS[raw] ?? JOB_LABELS[v.status];
  if (job) return { label: job, tone: "busy" };
  if (raw === "done" || v.url) return { label: "Complete", tone: "done" };
  if (raw === "generated" || v.status === "ready") return { label: "Generated", tone: "ready" };
  if (raw === "awaiting_script_review") return { label: "Review script", tone: "review" };
  if (raw === "awaiting_stock_footage_review") return { label: "Review footage", tone: "review" };
  if (raw === "rendering" || v.status === "rendering") return { label: "Rendering", tone: "busy" };
  return { label: "Generating", tone: "busy" };
}

export function shortUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = url.replace(/^https?:\/\//, "");
  return s.length > 34 ? `${s.slice(0, 34)}…` : s;
}

/** Video statuses that can still change on blog2video's side. */
export const BUSY = new Set(["generating", "pending", "rendering", "regenerating", "voice_regenerating", "language_regenerating",
  "script_regenerating"]);


// The editor's states and background jobs (web: pages/VideoEditor.tsx; mobile: video/editor.tsx).

export const STEPS = ["Reading the source", "Writing the script", "Building scenes", "Finishing"];
// After blog2video says ready, every scene's files are fetched before the preview: still part of Finishing
export const LOADING_STEP = STEPS.length;
export const FINISH_CAP_MS = 90_000; // loading media never holds the editor back longer than this
export const REVIEW = new Set(["awaiting_stock_footage_review", "awaiting_script_review"]);
// blog2video's statuses for a finished, editable video. Before that it says created / scraped / scripted (steps 1-3:
// reading, script, scenes with their voiceovers and clips), and only sets generated once every scene is done.
export const B2V_READY = new Set(["generated", "done", "rendering"]);
// Failed is blog2video saying so: an `error` beside another status can be left over from an earlier run.
export const isFailed = (s: VideoStatus) => s.status === "failed" || s.status === "error";

/** Every file the scenes use (images, clips, voiceovers), and whether all of them exist yet: each scene has its
 *  voiceover (unless the video has no voice) and each picture or clip has its asset. */
export function mediaOf(p: VideoProjectData): { items: VideoMedia[]; complete: boolean } {
  const scenes = p.scenes ?? [];
  const voiced = p.voice_gender !== "none";
  const items: VideoMedia[] = [];
  let complete = scenes.length > 0;
  for (const sc of scenes) {
    if (sc.audio_url) items.push({ url: sc.audio_url, kind: "audio" });
    else if (voiced) complete = false;
    for (const img of sc.images ?? []) {
      if (img.asset_id === null) complete = false;
      items.push({ url: img.url, kind: img.kind === "video" ? "video" : "image" });
    }
  }
  return { items, complete };
}

/** One line on what the job is doing now: "Scene 3 of 14", or for a translation which pass it is on. */
export function jobDetail(s: VideoJobState | null): string | null {
  if (!s) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const total = num(s.total) ?? num(s.total_scenes);
  const done = num(s.completed) ?? num(s.processed_scenes) ?? num(s.processed);
  if (s.kind === "language_change") {
    // Two passes over the scenes: the copy, then every voiceover (blog2video counts both in total).
    const scenes = total ? total / 2 : null;
    if (s.phase === "translating") return `Translating the text${scenes && done !== null ? ` · scene ${Math.min(done + 1, scenes)} of ${scenes}` : ""}`;
    if (s.phase === "voiceover") return `Recording voiceovers${scenes && done !== null ? ` · scene ${Math.min(Math.max(done - scenes, 0) + 1, scenes)} of ${scenes}` : ""}`;
  }
  return total && done !== null ? `Scene ${Math.min(done + 1, total)} of ${total}` : null;
}

/** How far a job is, 0-100, from whichever shape its status endpoint uses; null when it does not say. */
// How a job's progress is drawn: "bar" = the full progress screen in place of the editor; "inline" = the editor stays
// (rendering: the preview is final, the Rendering pill under it shows progress). A new kind of job adds its own.
export type JobView = "bar" | "inline";
export type JobInfo = { label: string; title: string; tip?: string; view: JobView; poll?: (id: string) => Promise<VideoJobState | null> };

/** Edit jobs on a finished video, keyed by the status blog2video (and so our artifact) has while one runs. The label
 * is what startJob is given when the job starts from this tab; poll resumes it after a reload or from another tab. */
export const JOBS: Record<string, JobInfo> = {
  regenerating: { label: "Switching template", title: "Regenerating scene layouts", view: "bar",
                  tip: "Switch the template, colors and fonts anytime from the Settings tab.",
                  poll: (id) => videoEditApi.templateStatus(id) },
  voice_regenerating: { label: "Changing the voice", title: "Re-recording the voiceover", view: "bar",
                        tip: "Preview any voice from the Voices page before switching.",
                        poll: (id) => videoEditApi.voiceStatus(id) },
  language_regenerating: { label: "Translating", title: "Translating your video", view: "bar",
                           tip: "Text, narration and voiceover are all translated.",
                           poll: (id) => videoEditApi.languageStatus(id) },
  rendering: { label: "Rendering", title: "Rendering the MP4", view: "inline",
               poll: (id) => videoEditApi.renderStatus(id) },
  script_regenerating: { label: "Refreshing the script", title: "Refreshing the script", view: "bar",
                         tip: "Narration and voiceovers stay as they are.",
                         poll: (id) => videoEditApi.refreshStatus(id) },
};

/** Jobs with no status of their own on blog2video: only shown when started from this tab. */
export const LOCAL_JOBS: JobInfo[] = [
  { label: "Deleting the voiceover", title: "Removing the voiceover", view: "bar",
    tip: "Render again afterwards to get a silent MP4.", poll: (id) => videoEditApi.voiceStatus(id) },
  { label: "Adding a scene", title: "Writing the new scene", tip: "You can edit any scene once it's added.", view: "bar" },
];

export const jobByLabel = (label: string): JobInfo =>
  Object.values(JOBS).find((j) => j.label === label) ?? LOCAL_JOBS.find((j) => j.label === label)
  ?? { label, title: label, view: "bar" };

/** Ready by blog2video's own status, not only the flag: a stale "ready" can never end the progress screen while it
 *  still reports created / scraped / scripted. An edit job's status counts (the job has its own screen). */
export function isReady(s: VideoStatus): boolean {
  return s.ready && (B2V_READY.has(s.status) || s.status in JOBS);
}

/** blog2video's preview player without its own speed and caption controls: both are set in Settings, not by the
 * viewer (the embed reads ?hide= as a comma-separated list). */
export function embedUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("hide", "speed,captions");
    return u.toString();
  } catch {
    return url;
  }
}

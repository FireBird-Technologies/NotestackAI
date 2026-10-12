import type { VideoJobState } from "../../api/types";

/** blog2video job endpoints report progress in slightly different shapes; any of these means it stopped. */
export function finished(s: VideoJobState | null): boolean {
  if (!s) return true; // e.g. add-status answers null once nothing is running
  // Voice change, voiceover delete and language change say it with active / done. Their `status` is the PROJECT's
  // (e.g. "done" on a video rendered before), so it must not be read as the job's.
  if (typeof s.active === "boolean") return s.done === true || !s.active;
  return s.done === true || s.running === false || !!s.video_url ||
    ["done", "completed", "complete", "ready", "failed", "error", "idle"].includes(String(s.status ?? ""));
}

/** A job's progress as a whole percent, from whichever shape blog2video reported it in (null if it gave none). */
export function jobPercent(s: VideoJobState | null): number | null {
  if (!s) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const pct = n(s.progress) ?? ratio(n(s.processed_scenes), n(s.total_scenes)) ?? ratio(n(s.processed), n(s.total));
  return pct === null ? null : Math.max(0, Math.min(100, Math.round(pct)));
}

function ratio(done: number | null, total: number | null): number | null {
  return done !== null && total ? (done / total) * 100 : null;
}

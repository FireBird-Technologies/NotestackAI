import type { Artifact } from "@notestack/shared/types";

/** Still being made: not ready, not failed, nor a draft or review waiting on the writer. */
export function isMaking(a: Artifact): boolean {
  return a.status !== "ready" && a.status !== "failed" && a.status !== "draft" && a.status !== "review";
}

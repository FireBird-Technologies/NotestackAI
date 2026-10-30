import type { Artifact } from "@notestack/shared/types";

/**
 * Videos whose create request is still on its way. Generate opens the video's screen at once under a `pending-<n>` id;
 * that screen waits here for the request, then becomes the real video's editor.
 */
const pending = new Map<string, Promise<Artifact>>();
let count = 0;

export function trackNewVideo(created: Promise<Artifact>): string {
  const key = `pending-${++count}`;
  pending.set(key, created);
  created.catch(() => undefined); // its screen reports a failure; this only keeps it from counting as unhandled
  return key;
}

export function pendingVideo(key: string): Promise<Artifact> | undefined {
  return pending.get(key);
}

export const isPendingId = (id: string) => id.startsWith("pending-");

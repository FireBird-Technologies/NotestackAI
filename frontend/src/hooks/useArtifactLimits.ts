import { useEffect, useState } from "react";
import { settingsApi } from "../api/endpoints";

/** Posts a report or infographic reads, and a dialog ticks to start with (the server's ARTIFACT_MAX_POSTS; this is the default until it
 * answers). A quiz or flashcard set can pick as many as the plan indexes (`selectable`). */
export type ArtifactLimits = { posts: number; selectable: number };

const DEFAULTS: ArtifactLimits = { posts: 20, selectable: 20 };
let known: ArtifactLimits | null = null;
let asked: Promise<ArtifactLimits> | null = null;
const listeners = new Set<(l: ArtifactLimits) => void>();

/** Ask the server once; everyone shares the answer. */
export function loadArtifactLimits(): Promise<ArtifactLimits> {
  if (!asked) {
    asked = settingsApi.limits().then((r) => {
      known = { posts: r.posts, selectable: r.selectable_posts };
      listeners.forEach((fn) => fn(known!));
      return known;
    }).catch(() => {
      asked = null; // try again next time
      return known ?? DEFAULTS;
    });
  }
  return asked;
}

export function useArtifactLimits(): ArtifactLimits {
  const [limits, setLimits] = useState<ArtifactLimits>(known ?? DEFAULTS);
  useEffect(() => {
    listeners.add(setLimits);
    void loadArtifactLimits();
    return () => {
      listeners.delete(setLimits);
    };
  }, []);
  return limits;
}

import { useEffect, useState } from "react";

export type MediaItem = { url: string; kind: "image" | "video" | "audio" };

const AT_ONCE = 6;
const TIMEOUT_MS = 20_000;

/** Loads one file the way a player would: an image to its last byte, a clip or voiceover until it can play through.
 *  Resolves true when it loaded, false on an error or after the timeout (never rejects). */
function loadOne({ url, kind }: MediaItem): Promise<boolean> {
  return new Promise((resolve) => {
    let el: HTMLImageElement | HTMLMediaElement;
    const end = (ok: boolean) => {
      clearTimeout(timer);
      el.onload = el.onerror = null;
      if (el instanceof HTMLMediaElement) {
        el.oncanplaythrough = null;
        el.removeAttribute("src"); // stop the download; what came in is cached
        el.load();
      }
      resolve(ok);
    };
    const timer = setTimeout(() => end(false), TIMEOUT_MS);
    if (kind === "image") {
      const img = new Image();
      el = img;
      img.onload = () => end(true);
      img.onerror = () => end(false);
      img.src = url;
      return;
    }
    const media = document.createElement(kind === "video" ? "video" : "audio");
    el = media;
    media.muted = true;
    media.preload = "auto";
    media.oncanplaythrough = () => end(true);
    media.onerror = () => end(false);
    media.src = url;
    media.load();
  });
}

/** Fetches every file a video's scenes use (images, clips, voiceovers), a few at a time, each retried once. `items`
 *  null = not yet (nothing loads). `done` once every file has loaded or given up: a missing file never blocks. */
export function useMediaPreload(items: MediaItem[] | null): { loaded: number; total: number; done: boolean } {
  const key = items ? items.map((i) => i.url).join("\n") : null;
  const [state, setState] = useState<{ key: string | null; loaded: number; done: boolean }>({ key: null, loaded: 0, done: false });

  useEffect(() => {
    if (key === null || !items) return;
    let stopped = false;
    let loaded = 0;
    let next = 0;
    setState({ key, loaded: 0, done: items.length === 0 });
    if (items.length === 0) return;

    const worker = async () => {
      while (!stopped && next < items.length) {
        const item = items[next++];
        if (!(await loadOne(item)) && !stopped) await loadOne(item); // one retry
        if (stopped) return;
        loaded += 1;
        setState({ key, loaded, done: loaded === items.length });
      }
    };
    for (let i = 0; i < Math.min(AT_ONCE, items.length); i++) void worker();
    return () => {
      stopped = true;
    };
    // `key` stands for `items`: the same files are not loaded again on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const mine = state.key === key ? state : null;
  return { loaded: mine?.loaded ?? 0, total: items?.length ?? 0, done: !!mine?.done };
}

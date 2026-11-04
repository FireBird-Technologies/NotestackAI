import type { Platform } from "@notestack/shared/platform";

/** The browser side of the shared API layer: tokens in localStorage, app signals as window events. */
export const webPlatform: Platform = {
  baseUrl: import.meta.env.VITE_API_URL ?? "",
  storage: {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* private mode: session only */
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  },
  emit(event, detail) {
    window.dispatchEvent(detail === undefined ? new Event(event) : new CustomEvent(event, { detail }));
  },
  fetch: (input, init) => window.fetch(input, init),
};

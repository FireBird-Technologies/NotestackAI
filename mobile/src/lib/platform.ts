import type { Platform } from "@notestack/shared/platform";
import Constants from "expo-constants";
import { fetch as expoFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";

type Listener = (detail: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

/** Subscribe to a signal the API layer emits (SESSION_EXPIRED_EVENT, PLAN_LIMIT_EVENT). Returns the unsubscribe. */
export function on(event: string, fn: Listener): () => void {
  const set = listeners.get(event) ?? new Set<Listener>();
  set.add(fn);
  listeners.set(event, set);
  return () => set.delete(fn);
}

/**
 * The API address. EXPO_PUBLIC_API_URL wins when set. Otherwise a dev build uses port 8000 on the machine it loads
 * the app from (the dev server's host), so a new Wi-Fi address needs no config change; a release build uses the
 * production API, api.notestack.ai (deploy/nginx-notestack.conf; notestack.ai itself is the web app, with no /api).
 */
function apiUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  const devHost = __DEV__ ? Constants.expoConfig?.hostUri?.split(":")[0] : undefined;
  return devHost ? `http://${devHost}:8000` : "https://api.notestack.ai";
}

/** The native side of the shared API layer: tokens in the Keychain / Keystore, signals through a small emitter. */
export const mobilePlatform: Platform = {
  baseUrl: apiUrl(),
  storage: {
    get: (key) => SecureStore.getItem(key),
    set: (key, value) => SecureStore.setItem(key, value),
    remove: (key) => {
      void SecureStore.deleteItemAsync(key);
    },
  },
  emit(event, detail) {
    listeners.get(event)?.forEach((fn) => fn(detail));
  },
  // expo/fetch streams response bodies, which the chat's SSE reader needs; React Native's own fetch does not.
  fetch: expoFetch as unknown as typeof fetch,
};

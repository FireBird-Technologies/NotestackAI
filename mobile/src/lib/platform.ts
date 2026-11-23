import type { Platform } from "@notestack/shared/platform";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { fetch as expoFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";
import { Platform as RNPlatform } from "react-native";

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
 * An Android emulator that loaded the app through adb reverse sees the host as 127.0.0.1, which is the emulator
 * itself; the Mac is 10.0.2.2 from there.
 */
function apiUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  const host = devHost();
  return host ? `http://${host}:8000` : "https://api.notestack.ai";
}

/** In a dev build, the machine the app loaded from (see apiUrl); undefined in a release build. */
function devHost(): string | undefined {
  const host = __DEV__ ? Constants.expoConfig?.hostUri?.split(":")[0] : undefined;
  const emulator = RNPlatform.OS === "android" && !Device.isDevice;
  return emulator && (host === "127.0.0.1" || host === "localhost") ? "10.0.2.2" : host;
}

/**
 * The web app's address, for files it serves (the onboarding sample PDFs in frontend/public). EXPO_PUBLIC_WEB_URL wins
 * when set; otherwise a dev build uses the Vite dev server (port 5173) on the same machine as the API, so files not yet
 * deployed still load, and a release build uses notestack.ai. A phone or Android emulator needs Vite started with
 * `npm run dev -- --host`, as it listens on localhost only by default.
 */
export function webUrl(): string {
  if (process.env.EXPO_PUBLIC_WEB_URL) return process.env.EXPO_PUBLIC_WEB_URL;
  const host = devHost();
  return host ? `http://${host}:5173` : "https://notestack.ai";
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

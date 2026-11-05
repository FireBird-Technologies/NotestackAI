import {
  getAnalytics,
  logEvent,
  logScreenView,
  resetAnalyticsData,
  setAnalyticsCollectionEnabled,
  setUserId,
  setUserProperty,
} from "@react-native-firebase/analytics";
import * as SecureStore from "expo-secure-store";

/**
 * Google Analytics for the apps, through Firebase (firebase.json keeps collection off until startAnalytics turns it
 * on). Only a build with EXPO_PUBLIC_ANALYTICS=on sends anything (the production profile in eas.json): dev and store
 * builds share one app id, so test traffic would land in the real numbers. It can be turned off in Settings (kept on
 * this phone).
 *
 * Events carry ids of kinds and counts only: never what a writer wrote, read or named.
 */
type Events = {
  sign_up: { method: string };
  login: { method: string };
  onboarding_skip: undefined;
  onboarding_complete: { post_count: number };
  notebook_create: { from: "onboarding" | "manual" };
  source_add: { source_type: "feed" | "url" | "file" };
  chat_answer: undefined;
  chat_error: undefined;
  artifact_generate: { artifact_kind: string };
  video_create: undefined;
  share_link_create: undefined;
  file_export: { file_type: string };
  paywall_view: { limit: string };
  purchase_start: { plan: string; cycle: string };
  purchase_complete: { plan: string };
};

const KEY = "ns_analytics";
const BUILD_SENDS = process.env.EXPO_PUBLIC_ANALYTICS === "on";

let enabled: boolean | null = null;
let userId: string | null = null;
let plan: string | null = null;

/** Analytics never gets in the way of the app: whatever fails here, sync or async, is dropped. */
function quietly(call: () => Promise<unknown> | void): void {
  try {
    void Promise.resolve(call()).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/** This phone's choice in Settings. */
export function analyticsEnabled(): boolean {
  if (enabled === null) {
    try {
      enabled = SecureStore.getItem(KEY) !== "0";
    } catch {
      enabled = true;
    }
  }
  return enabled;
}

const sending = () => BUILD_SENDS && analyticsEnabled();

/** Apply the build and this phone's choice, at app start. */
export function startAnalytics(): void {
  quietly(() => setAnalyticsCollectionEnabled(getAnalytics(), sending()));
}

export function setAnalyticsEnabled(on: boolean): void {
  enabled = on;
  void SecureStore.setItemAsync(KEY, on ? "1" : "0").catch(() => undefined);
  if (!BUILD_SENDS) return;
  quietly(async () => {
    const analytics = getAnalytics();
    // Off: forget who this is first. On again: the account signed in now, with no restart needed.
    await setUserId(analytics, on ? userId : null);
    if (on && plan) await setUserProperty(analytics, "plan", plan);
    await setAnalyticsCollectionEnabled(analytics, on);
  });
}

/** The signed-in account's opaque id, or null once signed out. */
export function identifyUser(id: string | null): void {
  if (id === userId) return;
  userId = id;
  if (id === null) plan = null;
  if (sending()) quietly(() => setUserId(getAnalytics(), id));
}

export function setPlan(next: string): void {
  if (next === plan) return;
  plan = next;
  if (sending()) quietly(() => setUserProperty(getAnalytics(), "plan", next));
}

export function track<E extends keyof Events>(event: E, ...params: Events[E] extends undefined ? [] : [Events[E]]): void {
  if (sending()) quietly(() => logEvent(getAnalytics(), event as string, params[0]));
}

/** `screen` is a route pattern (notebooks/[id]), never a real path: paths hold ids. */
export function logScreen(screen: string): void {
  if (sending()) quietly(() => logScreenView(getAnalytics(), { screen_name: screen, screen_class: screen }));
}

/** The account is being deleted: clear what this phone holds for it. */
export function resetAnalytics(): void {
  if (BUILD_SENDS) quietly(() => resetAnalyticsData(getAnalytics()));
}

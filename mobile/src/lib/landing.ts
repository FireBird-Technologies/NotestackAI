import { notebooksApi } from "@notestack/shared/endpoints";
import type { Href } from "expo-router";
import * as SecureStore from "expo-secure-store";

/** Set once onboarding is finished or skipped on this phone (web: ONBOARDED_KEY in localStorage). */
const ONBOARDED_KEY = "ns_onboarded";

export async function markOnboarded(): Promise<void> {
  await SecureStore.setItemAsync(ONBOARDED_KEY, "1").catch(() => undefined);
}

/**
 * Where signing in opens (web: lib/landing.ts startPath, with shared/auth afterSignUp): onboarding for a new account,
 * or a workspace with no source yet that didn't skip it here; else the notebook worked on last, else All posts.
 */
export async function startPath(created: boolean): Promise<Href> {
  if (created) return "/onboarding";
  try {
    const got = await notebooksApi.landing();
    const skipped = (await SecureStore.getItemAsync(ONBOARDED_KEY).catch(() => null)) === "1";
    if (!got.onboarded && !skipped) return "/onboarding";
    const id = got.notebook_id ?? (await notebooksApi.archive()).id;
    return { pathname: "/notebooks/[id]", params: { id } };
  } catch {
    return "/notebooks";
  }
}

import { notebooksApi, sourcesApi } from "../api/endpoints";
import { PENDING_SOURCE_KEY } from "../pages/Landing";
import { ONBOARDED_KEY } from "../pages/Welcome";

function read(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

/** A link pasted on the landing page by someone signed in: taken once (it was checked there). */
function takePending(): string | null {
  const pending = read(() => sessionStorage, PENDING_SOURCE_KEY);
  try {
    sessionStorage.removeItem(PENDING_SOURCE_KEY);
  } catch {
    /* ignore */
  }
  return pending?.trim() || null;
}

/** Where signing in opens: onboarding for a workspace that never did it, else the notebook worked on last, else the
 * All posts notebook. A link pasted on the landing page starts connecting, and All posts opens to receive it. */
export async function startPath(): Promise<string> {
  const got = await notebooksApi.landing();
  const skipped = read(() => localStorage, ONBOARDED_KEY) === "1";
  if (!got.onboarded && !skipped) return "/welcome"; // onboarding picks up a pasted link itself
  const pending = takePending();
  if (pending) {
    await sourcesApi.connect(pending).catch(() => undefined); // a bad link shows as a failed import, not here
    return `/app/notebooks/${(await notebooksApi.archive()).id}`;
  }
  const id = got.notebook_id ?? (await notebooksApi.archive()).id;
  return `/app/notebooks/${id}`;
}

/** The place to open after signing in: `next`, or (with no particular place asked for) the start above. */
export async function landingFor(next: string): Promise<string> {
  return next === "/app/start" ? startPath().catch(() => "/app/notebooks") : next;
}

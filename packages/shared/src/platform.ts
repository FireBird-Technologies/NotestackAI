/** What the API layer needs from the app it runs in: the web app and the mobile app each register one at startup. */
export type Platform = {
  /** API origin, "" for same origin (the web app behind the Vite proxy). */
  baseUrl: string;
  /** Synchronous key/value store for the session tokens. */
  storage: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
  /** App-wide signals such as PLAN_LIMIT_EVENT and SESSION_EXPIRED_EVENT. */
  emit(event: string, detail?: unknown): void;
  /** A fetch whose responses can be read as a stream (streamSSE needs res.body). */
  fetch: typeof fetch;
};

let current: Platform | null = null;

export function configurePlatform(p: Platform): void {
  current = p;
}

export function platform(): Platform {
  if (!current) throw new Error("configurePlatform() must run before the API is used");
  return current;
}

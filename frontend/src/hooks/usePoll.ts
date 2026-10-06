import { useEffect, useRef, useState } from "react";

/**
 * Calls `fn` every `intervalMs` until `until(result)` is true. Calls never overlap (each waits for the last),
 * it pauses while the tab is hidden, and it backs off after errors. Change `key` to restart it.
 *
 * `data`, `error` and `done` belong to the run (the `key`) that produced them: a new key or turning polling off reads
 * as a fresh start in the same render. Otherwise a caller's "finished?" check would still see the previous run's
 * `done` the moment a new run begins, and end it at once.
 */
export function usePoll<T>(
  fn: (() => Promise<T>) | null,
  { intervalMs, until, key }: { intervalMs: number; until: (t: T) => boolean; key?: unknown },
): { data: T | null; error: unknown; done: boolean } {
  const [result, setResult] = useState<{ key: unknown; data: T | null; error: unknown; done: boolean } | null>(null);
  const fnRef = useRef(fn);
  const untilRef = useRef(until);
  fnRef.current = fn;
  untilRef.current = until;
  const enabled = fn !== null;

  useEffect(() => {
    if (!enabled) return;
    const runKey = key;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    setResult(null); // a re-enabled run with the same key starts clean too

    const tick = async () => {
      if (stopped) return;
      if (document.hidden) {
        timer = setTimeout(tick, intervalMs);
        return;
      }
      try {
        const next = await fnRef.current!();
        if (stopped) return;
        failures = 0;
        const done = untilRef.current(next);
        setResult({ key: runKey, data: next, error: null, done });
        if (done) return;
      } catch (e) {
        if (stopped) return;
        failures += 1;
        setResult((r) => ({ key: runKey, data: r !== null && r.key === runKey ? r.data : null, error: e, done: false }));
      }
      timer = setTimeout(tick, intervalMs * Math.min(2 ** failures, 8));
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, intervalMs, key]);

  const mine = enabled && result !== null && result.key === key ? result : null;
  return { data: mine?.data ?? null, error: mine?.error ?? null, done: mine?.done ?? false };
}

import { useEffect, useRef, useState } from "react";
import { streamSSE } from "../api/stream";
import type { Job } from "../api/types";

const TERMINAL = new Set(["done", "failed"]);

/** Follows a job over SSE until it finishes. `onFinish` fires once with the final state. */
export function useJob(initial: Job | null | undefined, onFinish?: (job: Job) => void): Job | null {
  const [job, setJob] = useState<Job | null>(initial ?? null);
  const finish = useRef(onFinish);
  finish.current = onFinish;
  const id = initial?.id;

  useEffect(() => {
    setJob(initial ?? null);
    if (!initial || TERMINAL.has(initial.status)) return;
    const ctrl = new AbortController();
    let done = false;
    streamSSE(
      `/api/jobs/${initial.id}/events`,
      (_event, data) => {
        const next = data as Job;
        setJob(next);
        if (TERMINAL.has(next.status) && !done) {
          done = true;
          finish.current?.(next);
        }
      },
      {},
      ctrl.signal,
    ).catch(() => {
      /* aborted or dropped: the row keeps the final state */
    });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return job;
}

/** Tracks many jobs by key (e.g. per source), each streamed until done. */
export function useJobMap(onFinish?: (key: string, job: Job) => void) {
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const ctrls = useRef<Record<string, AbortController>>({});
  const finish = useRef(onFinish);
  finish.current = onFinish;

  useEffect(() => () => Object.values(ctrls.current).forEach((c) => c.abort()), []);

  const watch = (key: string, job: Job) => {
    ctrls.current[key]?.abort();
    setJobs((j) => ({ ...j, [key]: job }));
    if (TERMINAL.has(job.status)) return;
    const ctrl = new AbortController();
    ctrls.current[key] = ctrl;
    streamSSE(
      `/api/jobs/${job.id}/events`,
      (_e, data) => {
        const next = data as Job;
        setJobs((j) => ({ ...j, [key]: next }));
        if (TERMINAL.has(next.status)) finish.current?.(key, next);
      },
      {},
      ctrl.signal,
    ).catch(() => {});
  };

  return { jobs, watch };
}

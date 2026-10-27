import { STEPS } from "@notestack/shared/video";

import { CheckIcon } from "../icons/Icons";
import { StatusPill } from "../ui";

/**
 * "Making your video": the steps as a row of circles. The editor shows it while the video is made; the wizard shows it
 * at step 1 the moment Generate is clicked, while the server is still accepting the request.
 */
export function MakingVideo({ step, status }: { step: number; status?: string }) {
  return (
    <section className="card stack vw-making">
      <h2>Making your video</h2>
      <ol className="vw-progress" aria-label={`Step ${step} of ${STEPS.length}`}>
        {STEPS.map((s, i) => {
          const n = i + 1;
          const done = n < step;
          return (
            <li key={s} className={done ? "done" : n === step ? "on" : ""} aria-current={n === step ? "step" : undefined}>
              <span className="vw-progress-dot">{done ? <CheckIcon size={16} /> : n}</span>
              <span className="vw-progress-label">{s}</span>
            </li>
          );
        })}
      </ol>
      <p className="muted">You can leave this page; the video keeps going.</p>
      {status && <StatusPill status={status} />}
    </section>
  );
}

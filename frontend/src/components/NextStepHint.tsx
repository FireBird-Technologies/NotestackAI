import { useEffect, useState, type ReactNode } from "react";

export type NextStep = { id: string; label: string; icon: ReactNode; run: () => void };

// Long enough to read a label that names the answer's topic ("Make a video about submitting a blog to BlogHub").
const EVERY_MS = 6000;

/** 0..n-1 in a random order (Fisher-Yates); `notFirst` keeps a new round from opening with the step just shown. */
function shuffled(n: number, notFirst?: number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (n > 1 && out[0] === notFirst) [out[0], out[1]] = [out[1], out[0]];
  return out;
}

/** One suggested next step beside the last answer (make audio, a report, a quiz...), switching every few seconds.
 * The order is random, but every step is shown once before any repeats. It holds still while hovered or focused,
 * so it never changes under the pointer. */
export function NextStepHint({ actions }: { actions: NextStep[] }) {
  // A shuffled round of every step and the position in it; when the round ends, a new shuffle starts.
  const [round, setRound] = useState(() => ({ order: shuffled(actions.length), pos: 0 }));
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || actions.length < 2) return;
    const t = setInterval(() => {
      setRound(({ order, pos }) =>
        pos + 1 < order.length ? { order, pos: pos + 1 } : { order: shuffled(actions.length, order[pos]), pos: 0 });
    }, EVERY_MS);
    return () => clearInterval(t);
  }, [paused, actions.length]);

  const step = actions[(round.order[round.pos] ?? 0) % actions.length];
  if (!step) return null;
  return (
    <span
      className="nbv-next-wrap"
      aria-live="off"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <button type="button" className="nbv-next" key={step.id} onClick={step.run} title={step.label}>
        {step.icon}
        <span className="nbv-next-label">{step.label}</span>
        <span className="nbv-next-arrow" aria-hidden="true">→</span>
      </button>
    </span>
  );
}

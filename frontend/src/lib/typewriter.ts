/** Smooth typing for a streamed chat answer.
 *
 * The model sends text in bursts of half words ("ac", "tual", "ly ex") with pauses in between, so painting each piece
 * as it lands looks broken. The typewriter keeps everything received as a target and reveals it at a steady pace, one
 * frame at a time, a whole word at a time, and never shows a word before its last letter has arrived, unless the
 * stream is over. See Pace for how fast.
 */

/** How fast to type. The model (Z.ai GLM) delivers in batches: 200 to 400 characters at once, then nothing for 1 to 3
 * seconds. Typing a little slower than the text arrives (60% of its average rate), after a one second head start,
 * turns each batch into a buffer that carries the typing through the next pause, instead of racing ahead and then
 * stopping mid-answer. Replayed on recorded GLM answers this cut the time spent stopped mid-answer from 7.6 s to
 * 2.9 s over three answers. Once the stream is over, what is left is typed out quickly. */
export type Pace = {
  minCharsPerSecond: number; // never slower than this (about 8 words a second)
  arrivalFloorSeconds: number; // the average rate is taken over at least this long, so the first batch is not a sprint
  maxLagSeconds: number; // speed up when the text shown falls this far behind
  finishSeconds: number; // after the last piece, what is left is typed out in about this long
  arrivalShare: number; // type at this share of the arrival rate, so a buffer builds up
  startDelaySeconds: number; // wait this long after the first text before typing, to have a buffer from the start
};

export const DEFAULT_PACE: Pace = {
  minCharsPerSecond: 45, arrivalFloorSeconds: 1.5, maxLagSeconds: 4, finishSeconds: 0.8, arrivalShare: 0.6, startDelaySeconds: 1,
};

export type Typewriter = {
  /** Everything received so far, as it should read (the caller hides draft-only details such as [n] markers). */
  setTarget: (text: string) => void;
  /** Drop what was shown: another path writes the answer. */
  reset: () => void;
  /** No more text will come: type out `text` (the final answer as shown while typing), then resolve. */
  finish: (text: string) => Promise<void>;
  /** Stop at once, e.g. on an error or when a new question is asked. */
  stop: () => void;
};

/** The end of the last complete word: text up to its last whitespace. */
function wholeWords(text: string): number {
  const last = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"));
  return last + 1;
}

/** Close markup the next words will close, so "**Blog" does not flash as raw asterisks while typing. */
export function closeOpenMarkup(text: string): string {
  if ((text.match(/```/g) ?? []).length % 2) return `${text}\n\`\`\``;
  let out = text;
  if ((out.match(/\*\*/g) ?? []).length % 2) out += "**";
  if ((out.replace(/```/g, "").match(/`/g) ?? []).length % 2) out += "`";
  return out;
}

export function createTypewriter(paint: (text: string) => void, pace: Pace = DEFAULT_PACE): Typewriter {
  let target = "";
  let shown = 0;
  let done = false;
  let frame = 0;
  let lastTime = 0;
  let firstAt = 0; // when the first text arrived
  let resolveDone: (() => void) | null = null;

  const limit = () => (done ? target.length : wholeWords(target));

  const tick = (now: number) => {
    frame = 0;
    const elapsed = lastTime ? Math.min(now - lastTime, 100) : 16;
    lastTime = now;
    const end = limit();
    if (shown > target.length) shown = target.length; // the target shrank (a reset, or the final text is shorter)
    if (!firstAt && end > 0) firstAt = now;
    const waiting = !done && firstAt > 0 && now - firstAt < pace.startDelaySeconds * 1000;
    if (shown < end && !waiting) {
      const backlog = end - shown;
      const arriving = target.length / Math.max(pace.arrivalFloorSeconds, (now - firstAt) / 1000); // chars a second
      const perSecond = done
        ? Math.max(pace.minCharsPerSecond, backlog / pace.finishSeconds)
        : Math.max(pace.minCharsPerSecond, arriving * pace.arrivalShare, backlog / pace.maxLagSeconds);
      let next = Math.min(end, shown + Math.max(1, Math.round((perSecond * elapsed) / 1000)));
      while (next < end && !/\s/.test(target[next])) next++; // finish the word being typed
      shown = next;
      paint(closeOpenMarkup(target.slice(0, shown)));
    }
    if (shown < limit() || waiting) {
      frame = requestAnimationFrame(tick);
    } else {
      lastTime = 0;
      if (done && resolveDone) {
        const resolve = resolveDone;
        resolveDone = null;
        resolve();
      }
    }
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };

  return {
    setTarget(text) {
      target = text;
      schedule();
    },
    reset() {
      target = "";
      shown = 0;
      firstAt = 0;
      paint("");
    },
    finish(text) {
      target = text;
      done = true;
      return new Promise((resolve) => {
        resolveDone = resolve;
        schedule();
      });
    },
    stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      resolveDone = null;
    },
  };
}

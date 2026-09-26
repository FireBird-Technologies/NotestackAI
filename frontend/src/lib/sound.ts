/** Soft UI click: a short, quiet blip synthesized with Web Audio, so there is no asset to load.
 * Plays on buttons and button-styled links. Viewers can turn it off in Settings (stored per browser). */

const KEY = "ns_click_sounds";

let ctx: AudioContext | null = null;

export function soundsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSoundsEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private mode: default stays on */
  }
}

export function playClick(kind: "tap" | "primary" = "tap"): void {
  if (!soundsEnabled()) return;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    // Primary actions get a small rising two-tone; everything else a single soft tick.
    const [from, to] = kind === "primary" ? [660, 990] : [520, 420];
    osc.frequency.setValueAtTime(from, now);
    osc.frequency.exponentialRampToValueAtTime(to, now + 0.07);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(kind === "primary" ? 0.05 : 0.035, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  } catch {
    /* audio is decoration only */
  }
}

/** One delegated listener for the whole app. */
export function installClickSounds(): void {
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      const el = (e.target as Element | null)?.closest?.("button, a.btn, [role='tab'], .cal-item, .agenda-row");
      if (!el || (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return;
      playClick(el.classList.contains("btn-primary") ? "primary" : "tap");
    },
    { capture: true, passive: true },
  );
}

/** Space-flavored UI sounds, synthesized with Web Audio (no assets to load):
 *  - tap: a soft sonar ping (sine with a shimmering detuned partner) that fades into a faint echo
 *  - primary: a short rising "launch" chirp with a breath of filtered noise, also echoing
 * Everything is very quiet. Viewers can turn sounds off in Settings (stored per browser). */

const KEY = "ns_click_sounds";

let ctx: AudioContext | null = null;
let bus: GainNode | null = null;

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

/** Master bus with a dark feedback echo, built once. */
function output(ac: AudioContext): GainNode {
  if (bus) return bus;
  bus = ac.createGain();
  bus.gain.value = 0.9;
  const delay = ac.createDelay(1);
  delay.delayTime.value = 0.19;
  const feedback = ac.createGain();
  feedback.gain.value = 0.32;
  const tone = ac.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 1800;
  const wet = ac.createGain();
  wet.gain.value = 0.35;
  bus.connect(ac.destination);
  bus.connect(delay);
  delay.connect(tone).connect(feedback).connect(delay);
  tone.connect(wet).connect(ac.destination);
  return bus;
}

function voice(ac: AudioContext, out: AudioNode, type: OscillatorType, from: number, to: number, start: number,
               dur: number, peak: number, detune = 0): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.detune.value = detune;
  osc.frequency.setValueAtTime(from, start);
  osc.frequency.exponentialRampToValueAtTime(to, start + dur * 0.8);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(out);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function whoosh(ac: AudioContext, out: AudioNode, start: number, dur: number, peak: number): void {
  const len = Math.floor(ac.sampleRate * dur);
  const buffer = ac.createBuffer(1, len, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const band = ac.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 6;
  band.frequency.setValueAtTime(600, start);
  band.frequency.exponentialRampToValueAtTime(3200, start + dur);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + dur * 0.3);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(band).connect(gain).connect(out);
  src.start(start);
  src.stop(start + dur);
}

export function playClick(kind: "tap" | "primary" = "tap"): void {
  if (!soundsEnabled()) return;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime + 0.005;
    const out = output(ctx);
    if (kind === "primary") {
      // Launch: two detuned voices sweep up an octave and a half, a thin noise trail rises with them.
      voice(ctx, out, "sine", 330, 880, now, 0.28, 0.035);
      voice(ctx, out, "triangle", 330, 880, now, 0.28, 0.012, 9);
      voice(ctx, out, "sine", 1320, 1760, now + 0.09, 0.2, 0.01);
      whoosh(ctx, out, now, 0.26, 0.012);
    } else {
      // Sonar ping: a clean tone with a slightly detuned shimmer, dropping a touch as it fades.
      voice(ctx, out, "sine", 1046, 988, now, 0.22, 0.025);
      voice(ctx, out, "sine", 1568, 1480, now, 0.16, 0.006, 7);
    }
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

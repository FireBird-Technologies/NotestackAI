/** Advanced voice options (★), sent to blog2video as voice_emotion: a JSON string array
 *  ["<expressiveness>","<speed>","<emotion>","<character>","<enabled 1|0>"]. Same values and ranges as blog2video. */

export const EXPRESSIVENESS = { min: 0, max: 1, default: 0.5 };
export const SPEED = { min: 0.7, max: 1.2, default: 1.0 };
export const CHARACTER = { min: 0, max: 0.5, default: 0 };
export const TUNING_STEP = 0.05;

export const EMOTIONS: { value: string; label: string }[] = [
  { value: "excited", label: "Excited" },
  { value: "happy", label: "Happy" },
  { value: "calm", label: "Calm" },
  { value: "serious", label: "Serious" },
  { value: "curious", label: "Curious" },
  { value: "sad", label: "Sad" },
  { value: "angry", label: "Angry" },
  { value: "whispers", label: "Whispering" },
];

export type VoiceTuning = { enabled: boolean; expressiveness: number; speed: number; emotion: string; character: number };

export const DEFAULT_TUNING: VoiceTuning = {
  enabled: false,
  expressiveness: EXPRESSIVENESS.default,
  speed: SPEED.default,
  emotion: "",
  character: CHARACTER.default,
};

const clamp = (v: number, r: { min: number; max: number }) => Math.max(r.min, Math.min(r.max, v));

/** undefined when the options are off: the video narrates with plain defaults. */
export function serializeTuning(t: VoiceTuning): string | undefined {
  if (!t.enabled) return undefined;
  const emotion = EMOTIONS.some((e) => e.value === t.emotion) ? t.emotion : "";
  return JSON.stringify([
    clamp(t.expressiveness, EXPRESSIVENESS).toFixed(2),
    clamp(t.speed, SPEED).toFixed(2),
    emotion,
    clamp(t.character, CHARACTER).toFixed(2),
    "1",
  ]);
}

import { type AudioPlayer, createAudioPlayer, setAudioModeAsync } from "expo-audio";
import * as SecureStore from "expo-secure-store";

/**
 * The web's click (frontend/src/lib/sound.ts): one soft sonar ping on every button press, very quiet. The web
 * synthesizes it with Web Audio; here it is the same sound rendered to assets/sounds/click.wav. It can be turned off
 * in Settings (kept on this phone).
 */

const KEY = "ns_click_sounds";
/** Players taken in turn, so a tap while the last ping still rings starts a fresh one instead of cutting it short. */
const POOL = 4;

let players: AudioPlayer[] = [];
let next = 0;
let enabled: boolean | null = null;

export function soundsEnabled(): boolean {
  if (enabled === null) {
    try {
      enabled = SecureStore.getItem(KEY) !== "0";
    } catch {
      enabled = true;
    }
  }
  return enabled;
}

export function setSoundsEnabled(on: boolean): void {
  enabled = on;
  void SecureStore.setItemAsync(KEY, on ? "1" : "0").catch(() => undefined);
  if (on) preloadClicks();
}

/** Load the sound before the first tap (at app start), so that tap is not lost to loading. */
export function preloadClicks(): void {
  if (players.length || !soundsEnabled()) return;
  try {
    // A tap's ping plays over whatever the phone is playing, never pausing it (lib/audio.ts uses the same mode).
    void setAudioModeAsync({ playsInSilentMode: true, interruptionMode: "mixWithOthers" }).catch(() => undefined);
    players = Array.from({ length: POOL }, () => createAudioPlayer(require("@/assets/sounds/click.wav")));
  } catch {
    players = [];
  }
}

export function playClick(): void {
  if (!soundsEnabled()) return;
  preloadClicks();
  const player = players[next++ % POOL];
  if (!player) return;
  try {
    // Back to the start first (a used player sits at its end), then play.
    player.seekTo(0).then(
      () => player.play(),
      () => player.play(),
    );
  } catch {
    // audio is decoration only
  }
}

import { voiceApi } from "@notestack/shared/endpoints";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useCallback, useState } from "react";

// Samples play even with the phone's silent switch on: the person pressed Play.
void setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);

/**
 * One sample at a time (voice rows, previews, recorded takes): play a URL under an id, tap again to stop. `playing`
 * is the id sounding now, so its button can show Stop.
 */
export function useVoicePlayer() {
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [current, setCurrent] = useState<string | null>(null);
  // Sounding (or still loading) right now; a sample that ends on its own frees its button.
  const playing = current && (status.playing || status.isBuffering || !status.isLoaded) ? current : null;

  const stop = useCallback(() => {
    player.pause();
    setCurrent(null);
  }, [player]);

  const play = useCallback(
    (id: string, url: string | null | undefined) => {
      if (playing === id) return stop();
      if (!url) return;
      player.replace({ uri: url });
      player.play();
      setCurrent(id);
    },
    [player, playing, stop],
  );

  return { playing, play, stop };
}

/** The workspace's own voices have no sample link: the server speaks a line in them. Kept while the app runs. */
const previewLinks = new Map<string, Promise<string>>();
export function voicePreviewUrl(voiceId: string): Promise<string> {
  let got = previewLinks.get(voiceId);
  if (!got) {
    got = voiceApi.preview(voiceId).then((r) => r.url);
    got.catch(() => previewLinks.delete(voiceId));
    previewLinks.set(voiceId, got);
  }
  return got;
}

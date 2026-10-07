import { useCallback, useEffect, useState } from "react";
import { videosApi, videoVoicesApi, voiceApi } from "../../api/endpoints";
import type { VideoLibraryVoice, VideoSavedVoice, VideoVoicesResponse } from "../../api/types";
import { useUpgrade } from "../../hooks/useUpgrade";
import { errorMessage, Loading } from "../ui";
import { Premium, PlayButton, useAudio } from "../video/parts";

const cap = (s?: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "");

/** Play a voice: library voices have a sample link; the workspace's own (Notestack) voices have none, so the Voice
 * page speaks a line in them. */
export function useVoicePlayer(onError: (msg: string) => void) {
  const { playing, play, stop } = useAudio();
  const playNotestack = async (voiceId: string) => {
    if (playing === voiceId) return stop();
    const res = await voiceApi.preview(voiceId).catch((e) => {
      onError(errorMessage(e));
      return null;
    });
    if (res?.url) play(voiceId, res.url);
  };
  const playSaved = (v: VideoSavedVoice) =>
    v.source === "notestack" ? playNotestack(v.voice_id) : play(v.voice_id, v.preview_url);
  return { playing, play, playNotestack, playSaved };
}

/** The Voice page's Speaking voices: the workspace's voices (one list for audio overviews and videos, as many as
 * wanted) and, below, the built-in library to add from. New voices (Add voices) are saved here by the server. */
export function YourVoices({ reloadKey = 0, onAdd }: {
  /** Bumped by the Voice page after a voice was made or cloned, so the list reloads. */
  reloadKey?: number;
  /** Opens the Add voices modal (build, describe or clone). */
  onAdd: () => void;
}) {
  const [voices, setVoices] = useState<VideoVoicesResponse | null>(null);
  const [premium, setPremium] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { playing, play, playSaved } = useVoicePlayer(setError);
  const { openUpgrade } = useUpgrade();

  const load = useCallback(() => videoVoicesApi.list().then(setVoices).catch((e) => setError(errorMessage(e))), []);
  useEffect(() => {
    load();
    videosApi.config().then((c) => setPremium(!!c.premium)).catch(() => undefined);
  }, [load, reloadKey]);

  async function act(voiceId: string, fn: () => Promise<unknown>) {
    setBusy(voiceId);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const add = (v: VideoLibraryVoice) =>
    v.premium && !premium ? openUpgrade() : act(v.voice_id, () => videoVoicesApi.save(v.voice_id));
  const library = voices?.library.filter((v) => !v.saved) ?? [];

  return (
    <div className="stack">
      <div className="row between wrap manage-top">
        <p className="muted">Your voices read your audio overviews and videos. Add your own, or pick from the library.</p>
        <button className="btn btn-primary" onClick={onAdd}>Add voices</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {!voices && !error && <div className="loading-center inline stacked"><Loading label="Loading voices" /></div>}

      {voices && (
        <>
          <section className="stack yv-panel">
            <h3 className="yv-head">Your voices <span className="yv-count mono">{voices.saved.length}</span></h3>
            {voices.saved.length === 0 ? (
              <p className="muted">No voices yet. Add one, or pick from the library below.</p>
            ) : (
              <div className="vw-voice-list vw-voice-list-tight vw-voice-list-four">
                {voices.saved.map((v) => (
                  <div key={v.voice_id} className="vw-vrow">
                    <PlayButton on={playing === v.voice_id} disabled={v.source !== "notestack" && !v.preview_url}
                                label={v.name} onClick={() => playSaved(v)} />
                    <div className="vw-vpick static">
                      <strong>{v.name}</strong>
                      <span className="muted">
                        {v.source === "notestack" || v.is_custom ? "Your voice"
                          : [cap(v.gender), cap(v.accent)].filter(Boolean).join(" • ")}
                      </span>
                    </div>
                    {v.premium && <Premium small />}
                    <button className="btn btn-small" disabled={busy === v.voice_id}
                            onClick={() => act(v.voice_id, () => videoVoicesApi.unsave(v.voice_id))}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="stack yv-panel">
            <h3 className="yv-head">Voice library</h3>
            {library.length === 0 ? (
              <p className="muted">Every library voice is in your voices.</p>
            ) : (
              <div className="vw-voice-list vw-voice-list-tight">
                {library.map((v) => (
                  <div key={v.voice_id} className="vw-vrow">
                    <PlayButton on={playing === v.voice_id} disabled={!v.preview_url} label={v.name}
                                onClick={() => play(v.voice_id, v.preview_url)} />
                    <div className="vw-vpick static">
                      <strong>{v.name}</strong>
                      <span className="muted">
                        {[cap(v.gender), cap(v.accent), cap(v.age)].filter(Boolean).join(" • ")}
                        {v.description ? ` - ${v.description}` : ""}
                      </span>
                    </div>
                    {v.premium && <Premium small />}
                    <button className="btn btn-small btn-primary" disabled={busy === v.voice_id} onClick={() => add(v)}>
                      Add
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { videoVoicesApi, voiceApi } from "@notestack/shared/endpoints";
import type { VideoLibraryVoice, VideoSavedVoice, VideoVoicesResponse } from "@notestack/shared/types";
import { errorMessage, Loading } from "../ui";
import { PlayButton, useAudio } from "../video/parts";

const cap = (s?: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "");

/* The workspace's own voices have no sample link: the server speaks a line in them (once, then serves it from its
   cache). Each voice's link is kept here for the page's life (it lasts an hour), and its audio fetched ahead, so a
   play starts at once. */
const PREVIEW_FOR = 50 * 60 * 1000;
const previews = new Map<string, { at: number; url: Promise<string>; audio?: HTMLAudioElement }>();

export function voicePreviewUrl(voiceId: string): Promise<string> {
  const hit = previews.get(voiceId);
  if (hit && Date.now() - hit.at < PREVIEW_FOR) return hit.url;
  const entry: { at: number; url: Promise<string>; audio?: HTMLAudioElement } = { at: Date.now(), url: Promise.resolve("") };
  entry.url = voiceApi.preview(voiceId).then((r) => {
    // Fetched ahead: the browser holds its audio, so playing it later needs no download.
    entry.audio = new Audio();
    entry.audio.preload = "auto";
    entry.audio.src = r.url;
    return r.url;
  });
  entry.url.catch(() => previews.delete(voiceId)); // a failure is asked again next time
  previews.set(voiceId, entry);
  return entry.url;
}

/** Ask for the workspace's voices' samples ahead of any play (the list just loaded). */
export function prefetchVoicePreviews(saved: VideoSavedVoice[]) {
  for (const v of saved) if (v.source === "notestack") voicePreviewUrl(v.voice_id).catch(() => undefined);
}

/** Play a voice: library voices have a sample link; the workspace's own (Notestack) voices use the kept one. */
export function useVoicePlayer(onError: (msg: string) => void) {
  const { playing, play, stop } = useAudio();
  const playNotestack = async (voiceId: string) => {
    if (playing === voiceId) return stop();
    const url = await voicePreviewUrl(voiceId).catch((e) => {
      onError(errorMessage(e));
      return null;
    });
    if (url) play(voiceId, url);
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { playing, play, playSaved } = useVoicePlayer(setError);

  const load = useCallback(() => videoVoicesApi.list().then((v) => {
    setVoices(v);
    prefetchVoicePreviews(v.saved);
  }).catch((e) => setError(errorMessage(e))), []);
  useEffect(() => {
    load();
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

  const add = (v: VideoLibraryVoice) => act(v.voice_id, () => videoVoicesApi.save(v.voice_id));
  const library = voices?.library.filter((v) => !v.saved) ?? [];

  return (
    <div className="stack">
      <div className="row between wrap manage-top">
        <p className="muted">Your voices read your audio overviews, and narrate your videos. Add your own, or pick from the library.</p>
        <button className="btn btn-primary" onClick={onAdd}>Add voices</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {!voices && !error && <div className="loading-center inline"><Loading label="Loading voices" /></div>}

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
                        {v.source === "notestack" ? "Your voice"
                          : [cap(v.gender), cap(v.accent)].filter(Boolean).join(" • ")}
                      </span>
                    </div>
                    <button className="btn btn-small" disabled={busy === v.voice_id}
                            onClick={() => act(v.voice_id, () => videoVoicesApi.unsave(v.voice_id))}>
                      {busy === v.voice_id ? "Removing..." : "Remove"}
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
                    <button className="btn btn-small btn-primary" disabled={busy === v.voice_id} onClick={() => add(v)}>
                      {busy === v.voice_id ? "Adding..." : "Add"}
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

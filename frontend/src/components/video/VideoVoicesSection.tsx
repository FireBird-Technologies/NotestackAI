import { type ReactNode, useCallback, useEffect, useState } from "react";
import { videosApi, videoVoicesApi, voiceApi } from "../../api/endpoints";
import type { VideoSavedVoice, VideoVoicesResponse } from "../../api/types";
import { errorMessage, Loading, Modal, Tabs } from "../ui";
import { useUpgrade } from "../../hooks/useUpgrade";
import { VoiceLibrary } from "./VoiceLibrary";
import { Premium, PlayButton, useAudio } from "./parts";

const KIND = { clone: "Your cloned voice", designed: "Generated", library: "From the voice library" } as const;

/** Play a voice: blog2video voices have a sample link; Notestack voices have none, so the Voice page speaks a line. */
function useVoicePlayer(onError: (msg: string) => void) {
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
  return { playing, playNotestack, playSaved };
}

/** The Voice page's "Video voiceovers" tab: My video voices (what step 3 of a new video offers, up to max_saved) and
 * "Manage your voiceovers", which adds from the video voice library or the workspace's own Notestack voices. Notestack
 * voices work in videos because blog2video speaks with the same ElevenLabs account. */
export function VideoVoicesSection({ renderAddVoice, reloadKey = 0 }: {
  /** The modal's Add your voice tab: the Voice page's generator. onDone = saved (back to the library); close = close the
   * modal (cloning opens its own). The new voice is added to the video voices by the Voice page. */
  renderAddVoice: (onDone: () => void, close: () => void) => ReactNode;
  /** Bumped by the Voice page after it made a voice, so the list here reloads. */
  reloadKey?: number;
}) {
  const [voices, setVoices] = useState<VideoVoicesResponse | null>(null);
  const [premium, setPremium] = useState(false);
  const [managing, setManaging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { playing, playSaved } = useVoicePlayer(setError);

  const load = useCallback(() => videoVoicesApi.list().then(setVoices).catch((e) => setError(errorMessage(e))), []);
  useEffect(() => {
    load();
    videosApi.config().then((c) => setPremium(!!c.premium)).catch(() => undefined);
  }, [load, reloadKey]);

  const remove = async (voiceId: string) => {
    setBusy(voiceId);
    setError(null);
    try {
      await videoVoicesApi.unsave(voiceId);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div id="video-voices" className="stack">
      <div className="row between wrap manage-top">
        <p className="muted">
          Up to {voices?.max_saved ?? 5} voices, offered in step 3 of a new video. Mix your own voices with the video
          voice library.
        </p>
        <button className="btn btn-primary" disabled={!voices} onClick={() => setManaging(true)}>
          Manage your voiceovers
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {!voices && !error && <div className="loading-center inline"><Loading label="Loading voices" /></div>}

      {voices && (
        <div className="stack">
          <h3>My video voices <span className="mono muted small">{voices.saved.length} of {voices.max_saved}</span></h3>
          <div className="vw-voice-list">
            {voices.saved.map((v) => (
              <div key={v.voice_id} className="vw-vrow">
                <PlayButton on={playing === v.voice_id} disabled={v.source !== "notestack" && !v.preview_url}
                            label={v.name} onClick={() => playSaved(v)} />
                <div className="vw-vpick static">
                  <strong>{v.name}</strong>
                  <span className="muted">
                    {v.source === "notestack" || v.is_custom ? "Your voice" : [v.gender, v.accent].filter(Boolean).join(" • ")}
                  </span>
                </div>
                {v.premium && <Premium small />}
                <button className="btn btn-small" disabled={busy === v.voice_id} onClick={() => remove(v.voice_id)}>
                  Remove
                </button>
              </div>
            ))}
            {voices.saved.length === 0 && <p className="muted">No voices yet. Add some with Manage your voiceovers.</p>}
          </div>
        </div>
      )}

      {managing && voices && (
        <ManageVideoVoicesModal voices={voices} premium={premium} onChange={load} onClose={() => setManaging(false)}
                                renderAddVoice={renderAddVoice} />
      )}
    </div>
  );
}

/** Add or remove video voices: blog2video's library (and custom voices) plus the workspace's own Notestack voices, or
 * make a new voice (Add your voice). */
function ManageVideoVoicesModal({ voices, premium, onChange, onClose, renderAddVoice }: {
  voices: VideoVoicesResponse;
  premium: boolean;
  onChange: () => Promise<unknown>;
  onClose: () => void;
  renderAddVoice: (onDone: () => void, close: () => void) => ReactNode;
}) {
  const { openUpgrade } = useUpgrade();
  const [tab, setTab] = useState<"library" | "add">("library");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { playing, playNotestack } = useVoicePlayer(setError);
  const full = voices.saved.length >= voices.max_saved;
  // Sections: saved (from a voice library) and cloned voices, voices created (designed), and the built-in library.
  const ownSaved = voices.notestack.filter((v) => v.kind !== "designed");
  const ownCreated = voices.notestack.filter((v) => v.kind === "designed");
  const clonedCustom = voices.custom.some((c) => c.source === "clone");
  const createdCustom = voices.custom.some((c) => c.source !== "clone");
  const libProps = { voices, premium, full, onChange, onLocked: () => openUpgrade() };

  const ownRow = (v: VideoVoicesResponse["notestack"][number]) => (
    <div key={v.voice_id} className="vw-vrow">
      <PlayButton on={playing === v.voice_id} label={v.name} onClick={() => playNotestack(v.voice_id)} />
      <div className="vw-vpick static">
        <strong>{v.name}</strong>
        <span className="muted">{KIND[v.kind]}</span>
      </div>
      <Premium small />
      {v.saved ? (
        <button className="btn btn-small" disabled={busy === v.voice_id}
                onClick={() => act(v.voice_id, () => videoVoicesApi.unsave(v.voice_id))}>Remove</button>
      ) : (
        <button className="btn btn-small btn-primary" disabled={busy === v.voice_id || full}
                onClick={() => (premium ? act(v.voice_id, () => videoVoicesApi.save(v.voice_id)) : openUpgrade())}>
          Add
        </button>
      )}
    </div>
  );

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await onChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title="Manage your voiceovers" onClose={onClose} wide>
      <div className="stack">
        <p className="mono muted small">
          {voices.saved.length} of {voices.max_saved} added
          {full ? ". Remove one to add another." : ""}
        </p>
        <Tabs
          tabs={[
            { id: "library", label: "Voice library" },
            { id: "add", label: "Add your voice" },
          ]}
          value={tab}
          onChange={setTab}
        />
        {error && <p className="error-text">{error}</p>}
        {tab === "add" ? (
          renderAddVoice(() => setTab("library"), onClose)
        ) : (
          <div className="stack">
            {(ownSaved.length > 0 || clonedCustom) && (
              <section className="stack">
                <h3>Saved and cloned</h3>
                {ownSaved.length > 0 && <div className="vw-voice-list">{ownSaved.map(ownRow)}</div>}
                <VoiceLibrary {...libProps} part="custom" customKind="clone" />
              </section>
            )}
            {(ownCreated.length > 0 || createdCustom) && (
              <section className="stack">
                <h3>Created by you</h3>
                {ownCreated.length > 0 && <div className="vw-voice-list">{ownCreated.map(ownRow)}</div>}
                <VoiceLibrary {...libProps} part="custom" customKind="designed" />
              </section>
            )}
            <section className="stack">
              <h3>Built-in voices</h3>
              <VoiceLibrary {...libProps} part="library" />
            </section>
          </div>
        )}
      </div>
    </Modal>
  );
}

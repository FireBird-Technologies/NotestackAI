import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { videosApi, videoVoicesApi } from "../api/endpoints";
import type { VideoConfig, VideoVoicesResponse } from "../api/types";
import { errorMessage, Loading, PageHeader } from "../components/ui";
import { VoiceCreator } from "../components/video/VoiceCreator";
import { VoiceLibrary } from "../components/video/VoiceLibrary";
import { Premium, PlayButton, useAudio } from "../components/video/parts";
import { useUpgrade } from "../hooks/useUpgrade";

/** The workspace's video voices: My voices (what the wizard offers), the library, and custom voices. */
export default function VideoVoices() {
  const { openUpgrade } = useUpgrade();
  const [voices, setVoices] = useState<VideoVoicesResponse | null>(null);
  const [config, setConfig] = useState<VideoConfig | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { playing, play } = useAudio();

  const load = useCallback(() => videoVoicesApi.list().then(setVoices).catch((e) => setError(errorMessage(e))), []);
  useEffect(() => {
    load();
    videosApi.config().then(setConfig).catch(() => undefined);
  }, [load]);

  const premium = !!config?.premium;
  const custom = config?.limits.custom_voices;
  const designs = config?.limits.voice_designs_daily;

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="Videos" title="Voices">
        <Link to="/app/videos" className="btn">Back to videos</Link>
        <button className="btn btn-primary" onClick={() => (premium ? setCreating(true) : openUpgrade())}>
          Create a voice {!premium && <Premium small />}
        </button>
      </PageHeader>
      {custom && designs && premium && (
        <p className="mono muted">
          {custom.used} of {custom.limit} custom voices · {designs.used} of {designs.limit} voice designs today
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
      {!voices && !error && <Loading label="Loading voices" />}
      {voices && (
        <div className="stack">
          <section className="card stack">
            <h3>My voices</h3>
            <p className="muted small">These are the voices offered in step 3 of a new video.</p>
            <div className="vw-voice-list">
              {voices.saved.map((v) => (
                <div key={v.voice_id} className="vw-vrow">
                  <PlayButton on={playing === v.voice_id} disabled={!v.preview_url} label={v.name}
                              onClick={() => play(v.voice_id, v.preview_url)} />
                  <div className="vw-vpick static">
                    <strong>{v.name}</strong>
                    <span className="muted">{v.is_custom ? "Your voice" : [v.gender, v.accent].filter(Boolean).join(" • ")}</span>
                  </div>
                  {v.premium && <Premium small />}
                  <button className="btn btn-small" onClick={() => videoVoicesApi.unsave(v.voice_id).then(load).catch((e) => setError(errorMessage(e)))}>
                    Remove
                  </button>
                </div>
              ))}
              {voices.saved.length === 0 && <p className="muted">No voices saved. Save some from the library below.</p>}
            </div>
          </section>
          <section className="card">
            <VoiceLibrary voices={voices} premium={premium} onChange={load} onLocked={() => openUpgrade()} />
          </section>
        </div>
      )}
      {creating && <VoiceCreator onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); videosApi.config().then(setConfig); }} />}
    </div>
  );
}

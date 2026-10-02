import { useMemo, useState } from "react";
import { videoVoicesApi } from "../../api/endpoints";
import type { VideoVoicesResponse } from "../../api/types";
import { ConfirmButton, errorMessage } from "../ui";
import { Premium, PlayButton, useAudio } from "./parts";

const cap = (s?: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "");

/** The built-in voices to add to "My voices", and this workspace's custom voices. */
export function VoiceLibrary({ voices, premium, onChange, onLocked }: {
  voices: VideoVoicesResponse; premium: boolean; onChange: () => void; onLocked: () => void;
}) {
  const [gender, setGender] = useState("");
  const [accent, setAccent] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { playing, play } = useAudio();

  const accents = useMemo(() => [...new Set(voices.library.map((v) => v.accent).filter(Boolean) as string[])].sort(), [voices]);
  const shown = voices.library.filter((v) => (!gender || v.gender === gender) && (!accent || v.accent === accent));

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function playCustom(id: number, url: string | null) {
    if (url) return play(`c${id}`, url);
    const res = await videoVoicesApi.customPreview(id).catch(() => null);
    if (res?.preview_url) play(`c${id}`, res.preview_url);
    else setError("The preview is not ready yet. Try again in a minute.");
  }

  return (
    <div className="stack">
      {voices.custom.length > 0 && (
        <section className="stack">
          <h3>Your custom voices</h3>
          <div className="vw-voice-list">
            {voices.custom.map((c) => (
              <div key={c.id} className="vw-vrow">
                <PlayButton on={playing === `c${c.id}`} label={c.name} onClick={() => playCustom(c.id, c.preview_url)} />
                <div className="vw-vpick static">
                  <strong>{c.name}</strong>
                  <span className="muted">{c.source === "clone" ? "Cloned" : "Designed"}</span>
                </div>
                {c.saved ? (
                  <button className="btn btn-small" disabled={busy === c.voice_id}
                          onClick={() => act(c.voice_id, () => videoVoicesApi.unsave(c.voice_id))}>Remove from my voices</button>
                ) : (
                  <button className="btn btn-small" disabled={busy === c.voice_id}
                          onClick={() => act(c.voice_id, () => videoVoicesApi.save(c.voice_id))}>Add to my voices</button>
                )}
                <ConfirmButton onConfirm={() => act(`d${c.id}`, () => videoVoicesApi.removeCustom(c.id))}>Delete</ConfirmButton>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="stack">
        <div className="row between wrap">
          <h3>Voice library</h3>
          <div className="row">
            <select className="input" value={gender} onChange={(e) => setGender(e.target.value)} aria-label="Gender">
              <option value="">Any gender</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
            <select className="input" value={accent} onChange={(e) => setAccent(e.target.value)} aria-label="Accent">
              <option value="">Any accent</option>
              {accents.map((a) => <option key={a} value={a}>{cap(a)}</option>)}
            </select>
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="vw-voice-list">
          {shown.map((v) => (
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
              {v.saved ? (
                <button className="btn btn-small" disabled={busy === v.voice_id}
                        onClick={() => act(v.voice_id, () => videoVoicesApi.unsave(v.voice_id))}>Saved ✓</button>
              ) : (
                <button className="btn btn-small btn-primary" disabled={busy === v.voice_id}
                        onClick={() => (v.premium && !premium ? onLocked() : act(v.voice_id, () => videoVoicesApi.save(v.voice_id)))}>
                  Save
                </button>
              )}
            </div>
          ))}
          {shown.length === 0 && <p className="muted">No voices match.</p>}
        </div>
      </section>
    </div>
  );
}

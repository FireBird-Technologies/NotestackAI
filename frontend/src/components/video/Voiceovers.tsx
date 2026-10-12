import { useEffect, useRef, useState } from "react";
import type { VideoScene } from "../../api/types";
import type { PanelProps } from "./EditorPanels";

const GROUP = 5;

const clock = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** Each scene's voiceover, grouped by five (one group open at a time), to play with a progress bar. */
export function Voiceovers(p: PanelProps & { scenes: VideoScene[] }) {
  const { scenes } = p;
  const [openGroup, setOpenGroup] = useState<number | null>(0);
  const [playing, setPlaying] = useState<{ id: number; at: number; length: number } | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const ready = scenes.filter((s) => s.audio_url).length;
  const total = Math.round(scenes.reduce((n, s) => n + Number(s.duration_seconds ?? 0), 0));

  // Stop playback when leaving the tab.
  useEffect(() => () => audio.current?.pause(), []);

  function toggle(s: VideoScene) {
    const el = audio.current;
    if (!el || !s.audio_url) return;
    if (playing?.id === s.id) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.src = s.audio_url;
    el.currentTime = 0;
    setPlaying({ id: s.id, at: 0, length: Number(s.duration_seconds ?? 0) });
    el.play().catch(() => setPlaying(null));
  }

  const groups: VideoScene[][] = [];
  for (let i = 0; i < scenes.length; i += GROUP) groups.push(scenes.slice(i, i + GROUP));

  return (
    <section className="card stack">
      <div className="vw-vo-head">
        <h3>Voiceovers</h3>
        <span className="muted small">{ready} / {scenes.length} scenes · {total}s total</span>
        <span className="vw-vo-legend muted small">
          <span><i className="vw-vo-dot ok" /> Ready</span>
          <span><i className="vw-vo-dot" /> Pending</span>
        </span>
      </div>
      <audio ref={audio} preload="none" hidden
             onTimeUpdate={(e) => {
               const el = e.currentTarget;
               setPlaying((pl) => pl && { ...pl, at: el.currentTime, length: el.duration || pl.length });
             }}
             onEnded={() => setPlaying(null)} />

      {groups.map((group, g) => {
        const first = g * GROUP + 1;
        const open = openGroup === g;
        return (
          <section key={g} className="vw-group">
            <button type="button" className="vw-group-head" aria-expanded={open} onClick={() => setOpenGroup(open ? null : g)}>
              <span>Scenes {first}–{first + group.length - 1}{!open && <span className="muted small"> · Expand to view scenes</span>}</span>
              <span className="muted">{open ? "︿" : "﹀"}</span>
            </button>
            {open && group.map((s) => {
              const on = playing?.id === s.id;
              const length = on ? playing.length : Number(s.duration_seconds ?? 0);
              const at = on ? playing.at : 0;
              return (
                <div key={s.id} className="vw-vo-row">
                  <span className="vw-num-badge">{s.order}</span>
                  <button type="button" className="vw-vo-play" disabled={!s.audio_url}
                          aria-label={on ? `Pause scene ${s.order}` : `Play scene ${s.order}`} onClick={() => toggle(s)}>
                    {on ? <span className="vw-vo-pause" /> : <span className="vw-vo-tri" />}
                  </button>
                  <div className="vw-vo-main">
                    <div className="vw-vo-line">
                      <strong>{s.title || `Scene ${s.order}`}</strong>
                      <span className="mono muted small">{clock(at)} / {clock(length)}</span>
                    </div>
                    <div className="vw-vo-bar"><span style={{ width: `${length ? Math.min(100, (at / length) * 100) : 0}%` }} /></div>
                  </div>
                  <i className={`vw-vo-dot${s.audio_url ? " ok" : ""}`} title={s.audio_url ? "Ready" : "Pending"} />
                </div>
              );
            })}
          </section>
        );
      })}
    </section>
  );
}

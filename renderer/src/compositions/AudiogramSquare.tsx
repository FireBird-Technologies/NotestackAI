import { useAudioData, visualizeAudio } from "@remotion/media-utils";
import { AbsoluteFill, Audio, useCurrentFrame, useVideoConfig } from "remotion";
import { FPS, type AudiogramSquareProps } from "../schema";
import { theme } from "../theme";
import { Logo, ProgressBar } from "./shared";
import { Starfield } from "./Starfield";

const BARS = 48;

export function audiogramDuration(props: AudiogramSquareProps): number {
  return Math.max(FPS, Math.round(props.durationS * FPS));
}

function Waveform({ src, accent }: { src: string; accent: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const audio = useAudioData(src);
  const values = audio
    ? visualizeAudio({ fps, frame, audioData: audio, numberOfSamples: 64, smoothing: true }).slice(0, BARS)
    : Array.from({ length: BARS }, () => 0.02);
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, height: 260 }}>
      {values.map((v, i) => {
        const h = Math.max(6, Math.min(1, v * 6) * 240);
        return (
          <div
            key={i}
            style={{
              width: 10,
              height: h,
              borderRadius: 5,
              background: i % 2 ? theme.white : accent,
              boxShadow: `0 0 16px ${accent}`,
              opacity: 0.9,
            }}
          />
        );
      })}
    </div>
  );
}

/** 1:1 audiogram: title, live waveform, the current line of the conversation and who is speaking. */
export function AudiogramSquare(props: AudiogramSquareProps) {
  const accent = props.brand.accent ?? theme.blue;
  const frame = useCurrentFrame();
  const ms = (frame / FPS) * 1000;
  const current = props.segments.find((s) => ms >= s.startMs && ms < s.endMs);
  const speaker = current?.speaker === "host_b" ? "Host B" : "Host A";
  return (
    <AbsoluteFill>
      <Starfield accent={accent} count={100} />
      <Audio src={props.audioUrl} />
      <AbsoluteFill style={{ padding: 90, justifyContent: "space-between" }}>
        <div>
          <p style={{ fontFamily: theme.mono, fontSize: 26, letterSpacing: 4, color: accent, textTransform: "uppercase" }}>
            Audio overview
          </p>
          <h1 style={{ fontFamily: theme.display, fontSize: 58, lineHeight: 1.1, color: theme.white, marginTop: 18 }}>
            {props.title}
          </h1>
        </div>
        <Waveform src={props.audioUrl} accent={accent} />
        <div style={{ minHeight: 220 }}>
          {current && (
            <>
              <p style={{ fontFamily: theme.mono, fontSize: 24, color: "rgba(255,255,255,0.6)" }}>{speaker}</p>
              <p style={{ fontFamily: theme.body, fontSize: 38, lineHeight: 1.3, color: theme.white, marginTop: 10 }}>
                {current.text.length > 180 ? `${current.text.slice(0, 180)}...` : current.text}
              </p>
            </>
          )}
        </div>
      </AbsoluteFill>
      <ProgressBar accent={accent} height={8} />
      <Logo url={props.brand.logoUrl} size={64} inset={50} />
    </AbsoluteFill>
  );
}

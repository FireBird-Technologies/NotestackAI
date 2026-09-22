import { AbsoluteFill, Audio, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FPS, type ShortVerticalProps } from "../schema";
import { theme } from "../theme";
import { Starfield } from "./Starfield";

const HOOK_S = 2; // hook lands in the first 2 seconds

export function shortVerticalDuration(props: ShortVerticalProps): number {
  return Math.round((HOOK_S + props.scenes.reduce((s, sc) => s + sc.durationS, 0)) * FPS);
}

function Hook({ text, accent }: { text: string; accent: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 14 } });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 80 }}>
      <h1
        style={{
          fontFamily: theme.display,
          fontSize: 92,
          lineHeight: 1.05,
          color: theme.white,
          textAlign: "center",
          transform: `scale(${0.85 + s * 0.15})`,
          opacity: s,
          textShadow: `0 0 40px ${accent}aa`,
        }}
      >
        {text}
      </h1>
    </AbsoluteFill>
  );
}

function SceneCard({ text, citation, type, accent }: { text: string; citation?: string; type: string; accent: string }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  const y = interpolate(frame, [0, 12], [40, 0], { extrapolateRight: "clamp" });
  const isQuote = type === "pull_quote";
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: 90, opacity, transform: `translateY(${y}px)` }}>
      <p
        style={{
          fontFamily: isQuote ? theme.display : theme.body,
          fontSize: isQuote ? 72 : 64,
          fontWeight: 600,
          lineHeight: 1.2,
          color: theme.white,
          borderLeft: isQuote ? `6px solid ${accent}` : undefined,
          paddingLeft: isQuote ? 36 : 0,
        }}
      >
        {text}
      </p>
      {citation && (
        <p style={{ fontFamily: theme.mono, fontSize: 30, color: "rgba(255,255,255,0.6)", marginTop: 40 }}>
          Source: {citation}
        </p>
      )}
    </AbsoluteFill>
  );
}

/** Kinetic captions: the active word glows in the accent color. */
function Captions({ words, accent }: { words: ShortVerticalProps["captions"]; accent: string }) {
  const frame = useCurrentFrame();
  const ms = (frame / FPS) * 1000;
  const idx = words.findIndex((w) => ms >= w.startMs && ms < w.endMs);
  if (idx < 0) return null;
  const start = Math.max(0, idx - 2);
  const window = words.slice(start, start + 5);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 260 }}>
      <p style={{ fontFamily: theme.display, fontSize: 60, fontWeight: 700, textAlign: "center", padding: "0 60px" }}>
        {window.map((w, i) => (
          <span
            key={start + i}
            style={{
              color: start + i === idx ? theme.white : "rgba(255,255,255,0.55)",
              textShadow: start + i === idx ? `0 0 24px ${accent}` : "none",
              marginRight: 16,
            }}
          >
            {w.text}
          </span>
        ))}
      </p>
    </AbsoluteFill>
  );
}

function ProgressBar({ accent }: { accent: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 10, background: "rgba(255,255,255,0.1)" }}>
      <div
        style={{
          width: `${(frame / durationInFrames) * 100}%`,
          height: "100%",
          background: accent,
          boxShadow: `0 0 20px ${accent}`,
        }}
      />
    </div>
  );
}

export function ShortVertical(props: ShortVerticalProps) {
  const accent = props.brand.accent ?? theme.blue;
  let cursor = HOOK_S * FPS;
  return (
    <AbsoluteFill>
      <Starfield accent={accent} />
      {props.audioUrl && <Audio src={props.audioUrl} />}
      <Sequence durationInFrames={HOOK_S * FPS}>
        <Hook text={props.hook} accent={accent} />
      </Sequence>
      {props.scenes.map((scene, i) => {
        const from = cursor;
        const dur = Math.round(scene.durationS * FPS);
        cursor += dur;
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            <SceneCard text={scene.onScreenText} citation={scene.citation} type={scene.type} accent={accent} />
          </Sequence>
        );
      })}
      <Captions words={props.captions} accent={accent} />
      <ProgressBar accent={accent} />
    </AbsoluteFill>
  );
}

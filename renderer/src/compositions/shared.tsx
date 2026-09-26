import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { FPS, type Scene } from "../schema";
import { theme } from "../theme";

type Word = { text: string; startMs: number; endMs: number };

/** Kinetic captions: the active word glows in the accent color. Frame 0 = start of the narration. */
export function Captions({
  words,
  accent,
  fontSize = 60,
  bottom = 260,
}: {
  words: Word[];
  accent: string;
  fontSize?: number;
  bottom?: number;
}) {
  const frame = useCurrentFrame();
  const ms = (frame / FPS) * 1000;
  const idx = words.findIndex((w) => ms >= w.startMs && ms < w.endMs);
  if (idx < 0) return null;
  const start = Math.max(0, idx - 2);
  const visible = words.slice(start, start + 5);
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: bottom }}>
      <p style={{ fontFamily: theme.display, fontSize, fontWeight: 700, textAlign: "center", padding: "0 60px" }}>
        {visible.map((w, i) => (
          <span
            key={start + i}
            style={{
              color: start + i === idx ? theme.white : "rgba(255,255,255,0.55)",
              textShadow: start + i === idx ? `0 0 24px ${accent}` : "none",
              marginRight: fontSize / 4,
            }}
          >
            {w.text}
          </span>
        ))}
      </p>
    </AbsoluteFill>
  );
}

export function ProgressBar({ accent, height = 10 }: { accent: string; height?: number }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height, background: "rgba(255,255,255,0.1)" }}>
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

export function SceneCard({ scene, accent, scale = 1 }: { scene: Scene; accent: string; scale?: number }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  const y = interpolate(frame, [0, 12], [40, 0], { extrapolateRight: "clamp" });
  const isQuote = scene.type === "pull_quote";
  const isNumber = scene.type === "number";
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: 90 * scale, opacity, transform: `translateY(${y}px)` }}>
      <p
        style={{
          fontFamily: isQuote || isNumber ? theme.display : theme.body,
          fontSize: (isNumber ? 120 : isQuote ? 72 : 64) * scale,
          fontWeight: isNumber ? 700 : 600,
          lineHeight: 1.2,
          color: theme.white,
          borderLeft: isQuote ? `${6 * scale}px solid ${accent}` : undefined,
          paddingLeft: isQuote ? 36 * scale : 0,
          textShadow: isNumber ? `0 0 40px ${accent}` : undefined,
        }}
      >
        {scene.onScreenText}
      </p>
      {scene.citation && (
        <p style={{ fontFamily: theme.mono, fontSize: 30 * scale, color: "rgba(255,255,255,0.6)", marginTop: 40 }}>
          Source: {scene.citation}
        </p>
      )}
    </AbsoluteFill>
  );
}

export function Logo({ url, size = 72, inset = 60 }: { url?: string; size?: number; inset?: number }) {
  if (!url) return null;
  return <img src={url} style={{ position: "absolute", right: inset, bottom: inset, width: size, height: size }} />;
}

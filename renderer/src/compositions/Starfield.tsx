import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

/** Deterministic starfield (seeded with remotion's random) so every render frame is reproducible. */
export function Starfield({ count = 140, accent = theme.blue }: { count?: number; accent?: string }) {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill style={{ backgroundColor: theme.black }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(60% 40% at 50% 105%, ${accent}33, transparent 70%),
                       radial-gradient(40% 30% at 80% 15%, ${accent}1a, transparent 70%)`,
        }}
      />
      <svg width={width} height={height}>
        {Array.from({ length: count }).map((_, i) => {
          const x = random(`x${i}`) * width;
          const y = (random(`y${i}`) * height + t * (4 + random(`s${i}`) * 10)) % height;
          const r = 0.6 + random(`r${i}`) * 1.6;
          const twinkle = 0.45 + 0.55 * Math.abs(Math.sin(t * (0.6 + random(`p${i}`)) + i));
          return <circle key={i} cx={x} cy={y} r={r} fill={theme.white} opacity={twinkle} />;
        })}
      </svg>
    </AbsoluteFill>
  );
}

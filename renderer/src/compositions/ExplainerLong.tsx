import { AbsoluteFill, Audio, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FPS, type ExplainerLongProps } from "../schema";
import { theme } from "../theme";
import { Captions, Logo, ProgressBar, SceneCard } from "./shared";
import { Starfield } from "./Starfield";

const TITLE_S = 3;

export function explainerDuration(props: ExplainerLongProps): number {
  return Math.round((TITLE_S + props.scenes.reduce((s, sc) => s + sc.durationS, 0)) * FPS);
}

function TitleCard({ title, accent, name }: { title: string; accent: string; name?: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 16 } });
  const line = interpolate(frame, [10, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: "0 160px" }}>
      <h1
        style={{
          fontFamily: theme.display,
          fontSize: 96,
          lineHeight: 1.05,
          color: theme.white,
          opacity: s,
          transform: `translateY(${(1 - s) * 30}px)`,
          textShadow: `0 0 50px ${accent}88`,
        }}
      >
        {title}
      </h1>
      <div style={{ width: `${line * 420}px`, height: 5, background: accent, boxShadow: `0 0 24px ${accent}`, marginTop: 40 }} />
      {name && (
        <p style={{ fontFamily: theme.mono, fontSize: 30, marginTop: 36, color: "rgba(255,255,255,0.7)" }}>{name}</p>
      )}
    </AbsoluteFill>
  );
}

/** 16:9 explainer: a title card, then one card per storyboard scene over narration with captions. */
export function ExplainerLong(props: ExplainerLongProps) {
  const accent = props.brand.accent ?? theme.blue;
  let cursor = TITLE_S * FPS;
  return (
    <AbsoluteFill>
      <Starfield accent={accent} count={220} />
      <Sequence durationInFrames={TITLE_S * FPS}>
        <TitleCard title={props.title} accent={accent} name={props.brand.name} />
      </Sequence>
      {props.scenes.map((scene, i) => {
        const from = cursor;
        const dur = Math.round(scene.durationS * FPS);
        cursor += dur;
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            <AbsoluteFill style={{ padding: "0 140px" }}>
              <SceneCard scene={scene} accent={accent} scale={0.95} />
            </AbsoluteFill>
          </Sequence>
        );
      })}
      <Sequence from={TITLE_S * FPS}>
        {props.audioUrl && <Audio src={props.audioUrl} />}
        <Captions words={props.captions} accent={accent} fontSize={46} bottom={90} />
      </Sequence>
      <ProgressBar accent={accent} height={8} />
      <Logo url={props.brand.logoUrl} size={80} inset={50} />
    </AbsoluteFill>
  );
}

import { AbsoluteFill, Audio, Sequence, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FPS, type ShortVerticalProps } from "../schema";
import { theme } from "../theme";
import { Captions, Logo, ProgressBar, SceneCard } from "./shared";
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

export function ShortVertical(props: ShortVerticalProps) {
  const accent = props.brand.accent ?? theme.blue;
  let cursor = HOOK_S * FPS;
  return (
    <AbsoluteFill>
      <Starfield accent={accent} />
      <Sequence durationInFrames={HOOK_S * FPS}>
        <Hook text={props.hook} accent={accent} />
      </Sequence>
      {props.scenes.map((scene, i) => {
        const from = cursor;
        const dur = Math.round(scene.durationS * FPS);
        cursor += dur;
        return (
          <Sequence key={i} from={from} durationInFrames={dur}>
            <SceneCard scene={scene} accent={accent} />
          </Sequence>
        );
      })}
      {/* Narration and caption timings start with the first scene, after the hook. */}
      <Sequence from={HOOK_S * FPS}>
        {props.audioUrl && <Audio src={props.audioUrl} />}
        <Captions words={props.captions} accent={accent} />
      </Sequence>
      <ProgressBar accent={accent} />
      <Logo url={props.brand.logoUrl} size={96} inset={70} />
    </AbsoluteFill>
  );
}

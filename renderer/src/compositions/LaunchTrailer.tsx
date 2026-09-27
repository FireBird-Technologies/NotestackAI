import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Audio as SoundTrack, Easing, Img, interpolate, random, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";
import { Flare, WarpField } from "./LandingDemo";
import { LAUNCH_BPM, LAUNCH_SCENES, LAUNCH_SECONDS, type LaunchSceneId } from "./launchTimeline";

/** Launch trailer: a journey of knowledge through the galaxies of untapped potential.
 * One galaxy per feature, cut on the beat (see launchTimeline.ts, generated with the score),
 * narrated by Nora Vale, ending on "Notestack AI. Coming soon." 1920x1080, 30 fps. */

export const LAUNCH_FPS = 30;
const S = (seconds: number) => Math.round(seconds * LAUNCH_FPS);
export const LAUNCH_DURATION = S(LAUNCH_SECONDS);

const BLUE = theme.blue;
const WHITE = theme.white;
const BEAT = 60 / LAUNCH_BPM;
const XF = 0.3; // each scene fades in over the tail of the previous one
const ease = Easing.bezier(0.22, 1, 0.36, 1);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// ---------------------------------------------------------------- audio

const VO_WINDOWS: [number, number][] = LAUNCH_SCENES.filter((s) => s.vo !== null).map((s) => [
  S(s.start + (s.vo ?? 0)),
  S(s.start + (s.vo ?? 0) + (s.voLen ?? 0)),
]);
const MUSIC = 0.62;
const DUCKED = 0.24;

function musicVolume(frame: number): number {
  const ramp = 8;
  let level = MUSIC;
  for (const [a, b] of VO_WINDOWS) {
    if (frame >= a - ramp && frame <= b + ramp) {
      const into = interpolate(frame, [a - ramp, a, b, b + ramp], [0, 1, 1, 0], clamp);
      level = Math.min(level, MUSIC - (MUSIC - DUCKED) * into);
    }
  }
  return level;
}

// ---------------------------------------------------------------- shared pieces

/** 1 on each beat, decaying quickly. Scenes start on bar lines, so local time is beat aligned. */
function usePulse(sharp = 8) {
  const frame = useCurrentFrame();
  const t = frame / LAUNCH_FPS;
  return Math.exp(-(t % BEAT) * sharp);
}

/** A spiral galaxy with a white core; rotates slowly, drifts toward the camera over the scene. */
function Galaxy({ seed, x, y, size, tilt = 0.55, arms = 2, spin = 1, coreBoost = 0 }: {
  seed: string; x: number; y: number; size: number; tilt?: number; arms?: number; spin?: number; coreBoost?: number;
}) {
  const frame = useCurrentFrame();
  const rot = frame * 0.0035 * spin + random(`${seed}-rot`) * 6;
  const count = 520;
  const stars = [];
  for (let i = 0; i < count; i++) {
    const arm = i % arms;
    const u = Math.sqrt(random(`${seed}-u${i}`));
    const r = u * size;
    const theta = u * 5.2 + (arm * Math.PI * 2) / arms + rot + (random(`${seed}-j${i}`) - 0.5) * 0.7 * (1 - u * 0.4);
    const spread = (random(`${seed}-s${i}`) - 0.5) * size * 0.12;
    const px = Math.cos(theta) * (r + spread);
    const py = Math.sin(theta) * (r + spread) * tilt;
    const near = 1 - u;
    const fill = near > 0.55 ? WHITE : random(`${seed}-c${i}`) < 0.55 ? BLUE : "#9cc4ff";
    stars.push(<circle key={i} cx={px} cy={py} r={0.6 + random(`${seed}-r${i}`) * 1.8 * (0.5 + near)} fill={fill} opacity={0.35 + 0.65 * random(`${seed}-o${i}`)} />);
  }
  const core = 0.85 + coreBoost;
  return (
    <svg style={{ position: "absolute", left: x - size * 1.3, top: y - size * 1.3, overflow: "visible" }} width={size * 2.6} height={size * 2.6}>
      <defs>
        <radialGradient id={`${seed}-halo`}>
          <stop offset="0%" stopColor={BLUE} stopOpacity={0.35} />
          <stop offset="100%" stopColor={BLUE} stopOpacity={0} />
        </radialGradient>
        <radialGradient id={`${seed}-core`}>
          <stop offset="0%" stopColor={WHITE} stopOpacity={Math.min(1, core)} />
          <stop offset="18%" stopColor={WHITE} stopOpacity={0.45 * core} />
          <stop offset="45%" stopColor="#9cc4ff" stopOpacity={0.12 * core} />
          <stop offset="100%" stopColor={BLUE} stopOpacity={0} />
        </radialGradient>
      </defs>
      <g transform={`translate(${size * 1.3} ${size * 1.3})`}>
        <ellipse rx={size * 1.25} ry={size * 1.25 * tilt} fill={`url(#${seed}-halo)`} />
        {stars}
        <ellipse rx={size * 0.42} ry={size * 0.42 * Math.max(tilt, 0.7)} fill={`url(#${seed}-core)`} />
        <circle r={size * 0.035} fill={WHITE} style={{ filter: `drop-shadow(0 0 ${size * 0.06}px ${WHITE}) drop-shadow(0 0 ${size * 0.15}px ${BLUE})` }} />
      </g>
    </svg>
  );
}

/** Deep space backdrop: drifting stars and a faint far galaxy. */
function Space({ drift = 1, children }: { drift?: number; children?: ReactNode }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const t = frame / LAUNCH_FPS;
  return (
    <AbsoluteFill style={{ backgroundColor: theme.black, overflow: "hidden" }}>
      <AbsoluteFill style={{ background: `radial-gradient(50% 40% at 70% 50%, ${BLUE}1f, transparent 70%), radial-gradient(35% 30% at 15% 85%, ${BLUE}14, transparent 70%)` }} />
      <svg width={width} height={height} style={{ position: "absolute" }}>
        {Array.from({ length: 260 }).map((_, i) => {
          const depth = 0.3 + random(`d${i}`) * 0.7;
          const x = (((random(`x${i}`) * width - t * 22 * depth * drift) % width) + width) % width;
          const y = random(`y${i}`) * height;
          const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * (0.5 + random(`p${i}`)) + i));
          return <circle key={i} cx={x} cy={y} r={0.4 + depth * 1.4} fill={random(`b${i}`) < 0.2 ? "#9cc4ff" : WHITE} opacity={tw * depth} />;
        })}
      </svg>
      {children}
    </AbsoluteFill>
  );
}

const panel: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 24,
  background: "rgba(0,0,0,0.7)",
  boxShadow: `0 0 60px ${BLUE}33, 0 0 2px ${BLUE}`,
  backdropFilter: "blur(2px)",
};

function useIn(delay: number, damping = 16) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping } });
}

function typed(text: string, frame: number, start: number, cps = 30): string {
  return text.slice(0, Math.max(0, Math.floor(((frame - start) / LAUNCH_FPS) * cps)));
}

// ---------------------------------------------------------------- journey HUD

const STOPS: { id: LaunchSceneId; short: string; name: string; line: string }[] = [
  { id: "sources", short: "Sources", name: "The Source Nebula", line: "Any blog, newsletter, website or markdown, pulled into orbit." },
  { id: "research", short: "Research", name: "The Research Cluster", line: "Answers cited to the exact lines you wrote." },
  { id: "map", short: "Topic map", name: "The Constellation Field", line: "See which ideas are rising, and which went dark." },
  { id: "voice", short: "Voice", name: "The Voice Pulsar", line: "Everything it makes still sounds like you." },
  { id: "audio", short: "Audio", name: "The Audio Belt", line: "Two host audio overviews of any notebook." },
  { id: "video", short: "Studio", name: "The Studio Galaxy", line: "Shorts, explainers, audiograms and quote cards." },
  { id: "launchkit", short: "Launch Kit", name: "The Launch Kit Spiral", line: "Threads, LinkedIn, Notes, SEO and carousels." },
  { id: "launchpad", short: "Launchpad", name: "The Launchpad", line: "Schedule and auto post to X, LinkedIn and Bluesky." },
  { id: "resurface", short: "Resurface", name: "The Evergreen Belt", line: "Your best old posts, back in orbit." },
];

function Hud({ index }: { index: number }) {
  const frame = useCurrentFrame();
  const pulse = usePulse(10);
  const inn = useIn(2, 20);
  const travel = interpolate(frame, [0, 24], [index - 1, index], { ...clamp, easing: ease });
  const x0 = 360;
  const x1 = 1560;
  const px = (i: number) => x0 + ((x1 - x0) * i) / (STOPS.length - 1);
  return (
    <AbsoluteFill style={{ opacity: inn }}>
      <div style={{ position: "absolute", left: 80, top: 56, fontFamily: theme.mono, fontSize: 20, letterSpacing: 5, color: "rgba(255,255,255,0.6)" }}>
        NOTESTACK EXPEDITION
      </div>
      <div style={{ position: "absolute", right: 80, top: 56, fontFamily: theme.mono, fontSize: 20, letterSpacing: 5, color: BLUE }}>
        GALAXY {String(index + 1).padStart(2, "0")} / {String(STOPS.length).padStart(2, "0")}
      </div>
      <svg width={1920} height={1080} style={{ position: "absolute" }}>
        <line x1={x0} y1={990} x2={x1} y2={990} stroke="rgba(255,255,255,0.18)" strokeWidth={2} strokeDasharray="6 8" />
        <line x1={x0} y1={990} x2={px(travel)} y2={990} stroke={BLUE} strokeWidth={3} style={{ filter: `drop-shadow(0 0 6px ${BLUE})` }} />
        {STOPS.map((s, i) => {
          const done = i <= index;
          const here = i === index;
          return (
            <g key={s.id}>
              <circle cx={px(i)} cy={990} r={here ? 9 + pulse * 3 : 6} fill={done ? (here ? WHITE : BLUE) : "#000"} stroke={done ? BLUE : "rgba(255,255,255,0.35)"} strokeWidth={2}
                style={here ? { filter: `drop-shadow(0 0 10px ${WHITE}) drop-shadow(0 0 18px ${BLUE})` } : undefined} />
              <text x={px(i)} y={1030} textAnchor="middle" fontFamily={theme.mono} fontSize={15} letterSpacing={2} fill={here ? WHITE : done ? "rgba(156,196,255,0.8)" : "rgba(255,255,255,0.35)"}>
                {s.short.toUpperCase()}
              </text>
            </g>
          );
        })}
        <circle cx={px(travel)} cy={990} r={4} fill={WHITE} />
      </svg>
    </AbsoluteFill>
  );
}

/** Frame for every feature stop: galaxy flying in on the right, name and line on the left, the visual on top. */
function Stop({ id, children }: { id: LaunchSceneId; children: ReactNode }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const index = STOPS.findIndex((s) => s.id === id);
  const stop = STOPS[index];
  const pulse = usePulse(9);
  const approach = interpolate(frame, [0, durationInFrames], [0.55, 1.08], { easing: Easing.out(Easing.quad) });
  const eyebrow = useIn(4, 18);
  const name = useIn(8, 15);
  const line = useIn(16, 20);
  const visual = useIn(10, 17);
  return (
    <Space drift={1.4}>
      <div style={{ position: "absolute", inset: 0, transform: `scale(${approach})`, transformOrigin: "1260px 520px" }}>
        <Galaxy seed={`g-${id}`} x={1260} y={520} size={430} tilt={0.42 + random(`t-${id}`) * 0.3} arms={2 + (index % 2)} coreBoost={pulse * 0.25} />
      </div>
      <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.55) 38%, transparent 62%)" }} />
      <div style={{ position: "absolute", left: 120, top: 250, width: 700 }}>
        <p style={{ margin: 0, fontFamily: theme.mono, fontSize: 24, letterSpacing: 7, color: BLUE, opacity: eyebrow, transform: `translateX(${(1 - eyebrow) * -30}px)` }}>
          GALAXY {String(index + 1).padStart(2, "0")}
        </p>
        <h2 style={{ margin: "18px 0 0", fontFamily: theme.display, fontWeight: 700, fontSize: 92, lineHeight: 1.0, color: WHITE, opacity: name, transform: `translateY(${(1 - name) * 30}px)`, textShadow: `0 0 40px ${BLUE}88` }}>
          {stop.name}
        </h2>
        <p style={{ margin: "28px 0 0", fontFamily: theme.body, fontSize: 36, lineHeight: 1.35, color: "rgba(255,255,255,0.82)", opacity: line, transform: `translateY(${(1 - line) * 20}px)` }}>
          {stop.line}
        </p>
      </div>
      <div style={{ position: "absolute", left: 900, top: 190, width: 900, height: 660, opacity: visual, transform: `translateY(${(1 - visual) * 40}px) scale(${0.94 + visual * 0.06})` }}>
        {children}
      </div>
      <Hud index={index} />
    </Space>
  );
}

// ---------------------------------------------------------------- feature visuals (900 x 660 box)

function SourcesVisual() {
  const frame = useCurrentFrame();
  const kinds = ["Blog", "Newsletter", "Website", "Markdown", "PDF", "Substack", "Ghost", "WordPress"];
  const cx = 450;
  const cy = 330;
  const count = Math.round(interpolate(frame, [40, 240], [0, 248], { ...clamp, easing: ease }));
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <svg width={900} height={660} style={{ position: "absolute", overflow: "visible" }}>
        <ellipse cx={cx} cy={cy} rx={330} ry={130} fill="none" stroke={`${BLUE}88`} strokeWidth={2} strokeDasharray="4 10" />
        <ellipse cx={cx} cy={cy} rx={220} ry={86} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={1.5} />
        <circle cx={cx} cy={cy} r={74} fill="#000" stroke={BLUE} strokeWidth={3} style={{ filter: `drop-shadow(0 0 30px ${BLUE})` }} />
        <circle cx={cx} cy={cy} r={40} fill={WHITE} opacity={0.9} style={{ filter: `drop-shadow(0 0 24px ${WHITE})` }} />
      </svg>
      {kinds.map((k, i) => {
        const arrive = interpolate(frame, [12 + i * 9, 50 + i * 9], [0, 1], { ...clamp, easing: ease });
        const ring = i % 2 ? 220 : 330;
        const ringY = i % 2 ? 86 : 130;
        const a = (i / kinds.length) * Math.PI * 2 + frame * 0.012;
        const tx = cx + Math.cos(a) * ring;
        const ty = cy + Math.sin(a) * ringY;
        const sx = cx + Math.cos(a) * 1100;
        const sy = cy + Math.sin(a) * 700;
        const x = sx + (tx - sx) * arrive;
        const y = sy + (ty - sy) * arrive;
        const front = Math.sin(a) > 0;
        return (
          <div key={k} style={{ position: "absolute", left: x, top: y, transform: `translate(-50%, -50%) scale(${front ? 1 : 0.82})`, opacity: arrive * (front ? 1 : 0.7), zIndex: front ? 2 : 0, padding: "12px 22px", borderRadius: 999, background: front ? "rgba(0,0,0,0.85)" : "rgba(0,0,0,0.6)", border: `1.5px solid ${front ? BLUE : "rgba(255,255,255,0.3)"}`, color: WHITE, fontFamily: theme.body, fontWeight: 600, fontSize: 24, whiteSpace: "nowrap", boxShadow: front ? `0 0 24px ${BLUE}66` : undefined }}>
            {k}
          </div>
        );
      })}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, textAlign: "center", fontFamily: theme.mono, fontSize: 28, letterSpacing: 3, color: WHITE }}>
        <span style={{ color: BLUE }}>{count}</span> POSTS IN ORBIT
      </div>
    </div>
  );
}

function ResearchVisual() {
  const frame = useCurrentFrame();
  const q = "What have I said about pricing?";
  const answer = "You argue for charging early and raising prices with each new tier";
  const cite1 = useIn(62, 14);
  const cite2 = useIn(72, 14);
  const lines = useIn(80, 18);
  return (
    <div style={{ ...panel, position: "absolute", left: 40, right: 0, top: 20, padding: 36, display: "grid", gap: 22, alignContent: "start" }}>
      <div style={{ justifySelf: "end", padding: "14px 22px", borderRadius: 18, background: BLUE, color: WHITE, fontFamily: theme.body, fontSize: 28 }}>
        {typed(q, frame, 4, 34)}
        <span style={{ opacity: frame % 20 < 10 ? 1 : 0 }}>|</span>
      </div>
      <div style={{ fontFamily: theme.body, fontSize: 28, lineHeight: 1.5, color: WHITE, minHeight: 90 }}>
        {typed(answer, frame, 30, 40)}
        <span style={{ display: "inline-block", marginLeft: 10, padding: "0 10px", borderRadius: 8, background: BLUE, fontFamily: theme.mono, fontSize: 20, transform: `scale(${cite1})` }}>1</span>
        <span style={{ display: "inline-block", marginLeft: 8, padding: "0 10px", borderRadius: 8, background: BLUE, fontFamily: theme.mono, fontSize: 20, transform: `scale(${cite2})` }}>2</span>
      </div>
      <div style={{ opacity: lines, transform: `translateY(${(1 - lines) * 20}px)`, border: "1px solid rgba(255,255,255,0.14)", borderRadius: 16, padding: 20, fontFamily: theme.mono, fontSize: 19, lineHeight: 1.7 }}>
        <div style={{ color: BLUE, marginBottom: 6 }}>sources/blog/2024-03-11-price-early.md</div>
        {["12  Charge from day one. Free teaches", "13  people your work is worth nothing.", "14  Raise the price with every tier you", "15  add, not every year."].map((l, i) => (
          <div key={l} style={{ color: i < 3 ? WHITE : "rgba(255,255,255,0.55)", background: i < 3 ? `${BLUE}33` : undefined, borderLeft: i < 3 ? `3px solid ${BLUE}` : "3px solid transparent", paddingLeft: 12 }}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

function MapVisual() {
  const frame = useCurrentFrame();
  const pulse = usePulse(6);
  const nodes = [
    { x: 450, y: 320, r: 26, name: "Writing" },
    { x: 250, y: 200, r: 16, name: "Pricing" },
    { x: 660, y: 190, r: 20, name: "AI tools", rising: true },
    { x: 700, y: 430, r: 14, name: "Newsletters" },
    { x: 230, y: 470, r: 12, name: "Habits", dormant: true },
    { x: 470, y: 560, r: 15, name: "Audience" },
    { x: 120, y: 330, r: 9, name: "Design" },
    { x: 820, y: 300, r: 10, name: "Research" },
  ];
  const edges = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 6], [2, 7], [3, 5], [2, 3], [1, 4]];
  return (
    <svg width={900} height={660} style={{ position: "absolute", overflow: "visible" }}>
      <defs>
        <radialGradient id="map-core">
          <stop offset="0%" stopColor={WHITE} stopOpacity={0.75} />
          <stop offset="20%" stopColor={WHITE} stopOpacity={0.3} />
          <stop offset="55%" stopColor={BLUE} stopOpacity={0.1} />
          <stop offset="100%" stopColor={BLUE} stopOpacity={0} />
        </radialGradient>
      </defs>
      <circle cx={450} cy={330} r={260 + pulse * 10} fill="url(#map-core)" />
      {edges.map(([a, b], i) => {
        const p = interpolate(frame, [18 + i * 5, 40 + i * 5], [0, 1], clamp);
        const A = nodes[a];
        const B = nodes[b];
        return <line key={i} x1={A.x} y1={A.y} x2={A.x + (B.x - A.x) * p} y2={A.y + (B.y - A.y) * p} stroke={WHITE} strokeOpacity={0.45} strokeWidth={2} />;
      })}
      {nodes.map((n, i) => {
        const s = spring({ frame: frame - 6 - i * 4, fps: LAUNCH_FPS, config: { damping: 12 } });
        return (
          <g key={n.name} opacity={Math.min(1, s)}>
            <circle cx={n.x} cy={n.y} r={n.r * 2.4 * s} fill={BLUE} opacity={0.25} />
            <circle cx={n.x} cy={n.y} r={n.r * 0.6 * s} fill={n.rising ? WHITE : n.dormant ? "rgba(255,255,255,0.45)" : "#9cc4ff"} style={n.rising ? { filter: `drop-shadow(0 0 12px ${WHITE})` } : undefined} />
            {n.dormant && <circle cx={n.x} cy={n.y} r={n.r + 8} fill="none" stroke={WHITE} strokeOpacity={0.6} strokeDasharray="3 5" strokeWidth={1.5} />}
            <text x={n.x} y={n.y + n.r + 30} textAnchor="middle" fontFamily={theme.body} fontWeight={600} fontSize={22} fill={WHITE} stroke="#000" strokeWidth={5} paintOrder="stroke">
              {n.name}
            </text>
          </g>
        );
      })}
      <g opacity={interpolate(frame, [80, 96], [0, 1], clamp)}>
        <rect x={700} y={100} width={190} height={46} rx={23} fill={WHITE} />
        <text x={795} y={131} textAnchor="middle" fontFamily={theme.mono} fontSize={20} fill="#000">RISING 2.4x</text>
      </g>
      <g opacity={interpolate(frame, [110, 126], [0, 1], clamp)}>
        <rect x={80} y={520} width={170} height={46} rx={23} fill="#000" stroke="rgba(255,255,255,0.6)" strokeDasharray="4 5" />
        <text x={165} y={551} textAnchor="middle" fontFamily={theme.mono} fontSize={20} fill={WHITE}>DORMANT</text>
      </g>
    </svg>
  );
}

function VoiceVisual() {
  const frame = useCurrentFrame();
  const traits = [["Tone", "warm, direct"], ["Openers", "a sharp question"], ["Rhythm", "short, punchy lines"], ["Avoids", "jargon, hype"]];
  const match = Math.round(interpolate(frame, [70, 140], [0, 96], { ...clamp, easing: ease }));
  return (
    <div style={{ ...panel, position: "absolute", left: 40, right: 0, top: 30, padding: 40, display: "grid", gap: 26, alignContent: "start" }}>
      <svg width={780} height={150}>
        {Array.from({ length: 60 }).map((_, i) => {
          const h = 16 + Math.abs(Math.sin(i * 0.55 + frame * 0.22) * Math.sin(i * 0.13 + frame * 0.07)) * 120;
          return <rect key={i} x={i * 13} y={75 - h / 2} width={7} height={h} rx={3.5} fill={i % 7 === 0 ? WHITE : BLUE} opacity={0.5 + 0.5 * (h / 136)} />;
        })}
      </svg>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {traits.map(([k, v], i) => {
          const s = spring({ frame: frame - 20 - i * 10, fps: LAUNCH_FPS, config: { damping: 15 } });
          return (
            <div key={k} style={{ opacity: s, transform: `translateY(${(1 - s) * 16}px)`, border: `1px solid ${BLUE}88`, borderRadius: 14, padding: "14px 18px", fontFamily: theme.body, fontSize: 24, color: WHITE }}>
              <span style={{ fontFamily: theme.mono, fontSize: 18, color: BLUE, letterSpacing: 2 }}>{k.toUpperCase()}</span>
              <br />
              {v}
            </div>
          );
        })}
      </div>
      <div style={{ fontFamily: theme.mono, fontSize: 28, color: WHITE, letterSpacing: 2 }}>
        VOICE MATCH <span style={{ color: BLUE }}>{match}%</span>
      </div>
    </div>
  );
}

function AudioVisual() {
  const frame = useCurrentFrame();
  const speaker = Math.floor(frame / 36) % 2;
  const lines = ["So the big idea here is simple.", "Charge early. It changes who shows up.", "And it is all from their own posts.", "Every line, cited."];
  const host = (label: string, active: boolean, x: number) => (
    <div style={{ position: "absolute", left: x, top: 120, width: 170, height: 170, borderRadius: "50%", display: "grid", placeItems: "center", background: active ? WHITE : "#000", color: active ? "#000" : WHITE, border: `3px solid ${BLUE}`, fontFamily: theme.display, fontWeight: 700, fontSize: 64, boxShadow: active ? `0 0 0 ${10 + Math.sin(frame * 0.5) * 6}px ${BLUE}55, 0 0 60px ${BLUE}` : undefined }}>
      {label}
    </div>
  );
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {host("A", speaker === 0, 60)}
      {host("B", speaker === 1, 670)}
      <svg width={900} height={660} style={{ position: "absolute" }}>
        {Array.from({ length: 36 }).map((_, i) => {
          const h = 10 + Math.abs(Math.sin(i * 0.8 + frame * 0.35) * Math.cos(i * 0.21 - frame * 0.1)) * 150;
          return <rect key={i} x={265 + i * 10.5} y={205 - h / 2} width={6} height={h} rx={3} fill={BLUE} opacity={0.85} />;
        })}
      </svg>
      <div style={{ ...panel, position: "absolute", left: 60, right: 50, top: 400, padding: "26px 32px", fontFamily: theme.body, fontSize: 32, color: WHITE }}>
        <span style={{ fontFamily: theme.mono, fontSize: 20, color: BLUE, letterSpacing: 3 }}>HOST {speaker ? "B" : "A"}</span>
        <br />
        {lines[Math.floor(frame / 36) % lines.length]}
      </div>
    </div>
  );
}

function VideoVisual() {
  const frame = useCurrentFrame();
  const card = (delay: number, style: CSSProperties, label: string, body: ReactNode) => {
    const s = spring({ frame: frame - delay, fps: LAUNCH_FPS, config: { damping: 14 } });
    return (
      <div style={{ ...panel, position: "absolute", overflow: "hidden", opacity: s, transform: `translateY(${(1 - s) * 80}px) rotate(${(1 - s) * 4}deg)`, ...style }}>
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(80% 60% at 50% 110%, ${BLUE}55, transparent 70%)` }} />
        <div style={{ position: "absolute", left: 18, top: 14, fontFamily: theme.mono, fontSize: 16, letterSpacing: 3, color: BLUE }}>{label}</div>
        <div style={{ position: "absolute", inset: "50px 22px 22px", display: "grid", placeItems: "center", textAlign: "center", color: WHITE, fontFamily: theme.display, fontWeight: 600 }}>{body}</div>
      </div>
    );
  };
  const play = <div style={{ width: 0, height: 0, borderLeft: `34px solid ${WHITE}`, borderTop: "20px solid transparent", borderBottom: "20px solid transparent" }} />;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {card(4, { left: 40, top: 60, width: 250, height: 444 }, "SHORT 9:16", <div style={{ fontSize: 34, lineHeight: 1.15 }}>Your archive already is a podcast</div>)}
      {card(14, { left: 320, top: 40, width: 520, height: 292 }, "EXPLAINER 16:9", <div style={{ display: "grid", gap: 16, placeItems: "center" }}>{play}<span style={{ fontSize: 30 }}>Why pricing early works</span></div>)}
      {card(24, { left: 320, top: 360, width: 250, height: 250 }, "AUDIOGRAM 1:1",
        <svg width={200} height={120}>{Array.from({ length: 16 }).map((_, i) => { const h = 12 + Math.abs(Math.sin(i + frame * 0.3)) * 90; return <rect key={i} x={i * 12.5} y={60 - h / 2} width={7} height={h} rx={3} fill={i % 4 ? BLUE : WHITE} />; })}</svg>)}
      {card(34, { left: 590, top: 360, width: 250, height: 250 }, "QUOTE CARD", <div style={{ fontSize: 26, lineHeight: 1.25 }}>"Free teaches people your work is worth nothing."</div>)}
    </div>
  );
}

function LaunchKitVisual() {
  const frame = useCurrentFrame();
  const items = [["X THREAD", "1/7  Most writers undercharge. Here is why."], ["LINKEDIN", "I raised my prices three times last year."], ["SUBSTACK NOTES", "Charge from day one. Seriously."], ["BLUESKY", "Pricing is a signal, not a number."], ["SEO PACK", "Title, meta, slug, keywords, links"], ["CAROUSEL", "8 slides: How to price your writing"]];
  return (
    <div style={{ position: "absolute", inset: "20px 0 0 30px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
      {items.map(([k, v], i) => {
        const s = spring({ frame: frame - 8 - i * S(BEAT), fps: LAUNCH_FPS, config: { damping: 13 } });
        return (
          <div key={k} style={{ ...panel, opacity: Math.min(1, s), transform: `translateY(${(1 - s) * 60}px) scale(${0.9 + 0.1 * s})`, padding: "22px 24px", minHeight: 160 }}>
            <div style={{ fontFamily: theme.mono, fontSize: 18, letterSpacing: 3, color: BLUE }}>{k}</div>
            <div style={{ marginTop: 12, fontFamily: theme.body, fontSize: 26, lineHeight: 1.35, color: WHITE }}>{v}</div>
          </div>
        );
      })}
    </div>
  );
}

function LaunchpadVisual() {
  const frame = useCurrentFrame();
  const days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  const posts: [number, number, string][] = [[0, 0, "X"], [1, 1, "LinkedIn"], [2, 0, "Bluesky"], [3, 2, "X"], [4, 1, "Notes"], [5, 0, "LinkedIn"], [6, 2, "X"]];
  const lift = interpolate(frame, [120, 200], [0, 1], { ...clamp, easing: Easing.in(Easing.cubic) });
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ ...panel, position: "absolute", left: 30, top: 20, width: 620, padding: 26 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 10 }}>
          {days.map((d) => (
            <div key={d} style={{ fontFamily: theme.mono, fontSize: 16, color: "rgba(255,255,255,0.6)", textAlign: "center" }}>{d}</div>
          ))}
          {Array.from({ length: 21 }).map((_, cell) => {
            const col = cell % 7;
            const row = Math.floor(cell / 7);
            const post = posts.find(([c, r]) => c === col && r === row);
            const s = post ? spring({ frame: frame - 10 - posts.indexOf(post) * 8, fps: LAUNCH_FPS, config: { damping: 12 } }) : 0;
            const sent = post && frame > 90 + posts.indexOf(post) * 5;
            return (
              <div key={cell} style={{ height: 96, borderRadius: 12, border: "1px solid rgba(255,255,255,0.12)", display: "grid", placeItems: "center" }}>
                {post && (
                  <div style={{ transform: `scale(${s})`, padding: "6px 8px", borderRadius: 8, background: sent ? WHITE : BLUE, color: sent ? "#000" : WHITE, fontFamily: theme.body, fontWeight: 600, fontSize: 15 }}>
                    {post[2]}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 18, fontFamily: theme.mono, fontSize: 20, letterSpacing: 2, color: frame > 100 ? WHITE : "rgba(255,255,255,0.6)" }}>
          {frame > 100 ? "7 POSTS LIVE" : "7 POSTS SCHEDULED"}
        </div>
      </div>
      <svg width={260} height={660} style={{ position: "absolute", left: 660, top: 0, overflow: "visible" }}>
        <g transform={`translate(130 ${470 - lift * 700})`}>
          <path d={`M -14 60 Q 0 ${120 + lift * 260} 14 60 Z`} fill={WHITE} opacity={0.5 + lift * 0.5} style={{ filter: `drop-shadow(0 0 16px ${BLUE})` }} />
          <path d="M 0 -80 C 34 -40 34 20 24 60 L -24 60 C -34 20 -34 -40 0 -80 Z" fill={WHITE} />
          <circle cx={0} cy={-18} r={12} fill={BLUE} />
          <path d="M -24 30 L -46 70 L -22 58 Z M 24 30 L 46 70 L 22 58 Z" fill={BLUE} />
        </g>
        <line x1={40} y1={560} x2={220} y2={560} stroke="rgba(255,255,255,0.4)" strokeWidth={3} />
      </svg>
    </div>
  );
}

function ResurfaceVisual() {
  const frame = useCurrentFrame();
  const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
  const rise = interpolate(frame, [30, 80], [0, 1], { ...clamp, easing: ease });
  const score = Math.round(interpolate(frame, [60, 110], [0, 92], clamp));
  const x = (i: number) => 60 + i * 110;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <svg width={900} height={660} style={{ position: "absolute" }}>
        <line x1={40} y1={560} x2={860} y2={560} stroke="rgba(255,255,255,0.3)" strokeWidth={2} />
        {years.map((y, i) => (
          <g key={y}>
            <circle cx={x(i)} cy={560} r={6} fill={i === 2 ? WHITE : BLUE} />
            <text x={x(i)} y={600} textAnchor="middle" fontFamily={theme.mono} fontSize={18} fill="rgba(255,255,255,0.6)">{y}</text>
          </g>
        ))}
        <path d={`M ${x(2)} 560 C ${x(2)} ${560 - 200 * rise}, ${x(4)} ${420 - 200 * rise}, ${x(4)} ${360 - 180 * rise}`} fill="none" stroke={WHITE} strokeOpacity={0.6} strokeWidth={2} strokeDasharray="5 7" />
      </svg>
      <div style={{ ...panel, position: "absolute", left: x(2) + 60 + rise * 140, top: 420 - rise * 330, width: 480, padding: 26, boxShadow: `0 0 ${40 + rise * 60}px ${BLUE}${rise > 0.5 ? "99" : "44"}` }}>
        <div style={{ fontFamily: theme.mono, fontSize: 18, color: BLUE, letterSpacing: 2 }}>MARCH 2021</div>
        <div style={{ marginTop: 10, fontFamily: theme.display, fontWeight: 600, fontSize: 34, color: WHITE, lineHeight: 1.15 }}>The quiet power of a small audience</div>
        <div style={{ marginTop: 18, display: "flex", gap: 14, fontFamily: theme.mono, fontSize: 20 }}>
          <span style={{ padding: "6px 14px", borderRadius: 999, background: WHITE, color: "#000" }}>EVERGREEN {score}</span>
          <span style={{ padding: "6px 14px", borderRadius: 999, border: `1px solid ${BLUE}`, color: WHITE }}>RESHARE</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bookend scenes

function Intro() {
  const frame = useCurrentFrame();
  const a = useIn(24, 22);
  const b = useIn(S(3.4), 22);
  const c = useIn(S(6.2), 20);
  const push = interpolate(frame, [0, S(8)], [1, 1.12]);
  return (
    <Space drift={0.4}>
      <div style={{ position: "absolute", inset: 0, transform: `scale(${push})`, opacity: interpolate(frame, [0, 40], [0, 1], clamp) }}>
        <Galaxy seed="far-1" x={1500} y={260} size={150} tilt={0.35} />
        <Galaxy seed="far-2" x={330} y={820} size={110} tilt={0.6} arms={3} />
        <Galaxy seed="far-3" x={1650} y={860} size={70} tilt={0.5} />
        <Galaxy seed="far-4" x={260} y={200} size={60} tilt={0.7} />
      </div>
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", textAlign: "center", gap: 28 }}>
        <h1 style={{ margin: 0, fontFamily: theme.display, fontWeight: 600, fontSize: 80, color: WHITE, opacity: a, transform: `translateY(${(1 - a) * 30}px)` }}>
          You have written more than you remember.
        </h1>
        <h2 style={{ margin: 0, fontFamily: theme.display, fontWeight: 500, fontSize: 64, color: "rgba(255,255,255,0.75)", opacity: b, transform: `translateY(${(1 - b) * 24}px)` }}>
          Whole worlds of ideas, <span style={{ color: WHITE, textShadow: `0 0 30px ${BLUE}, 0 0 70px ${BLUE}` }}>still uncharted.</span>
        </h2>
        <p style={{ margin: "30px 0 0", fontFamily: theme.mono, fontSize: 24, letterSpacing: 8, color: BLUE, opacity: c }}>A JOURNEY OF KNOWLEDGE</p>
      </AbsoluteFill>
    </Space>
  );
}

function Launch() {
  const frame = useCurrentFrame();
  const speed = interpolate(frame, [0, 20, 90, 120], [2, 22, 18, 8], clamp);
  const streak = interpolate(frame, [0, 12, 95, 120], [0, 1, 1, 0.3], clamp);
  const title = useIn(10, 14);
  const sub = useIn(28, 18);
  const shake = frame < 14 ? Math.sin(frame * 3.1) * (14 - frame) * 0.8 : 0;
  return (
    <AbsoluteFill style={{ transform: `translate(${shake}px, ${shake * 0.6}px)` }}>
      <WarpField speed={speed} streak={streak} count={520} />
      <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 50%, rgba(255,255,255,${interpolate(frame, [0, 10], [0.8, 0], clamp)}), transparent 60%)` }} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", textAlign: "center", gap: 26 }}>
        <h1 style={{ margin: 0, fontFamily: theme.display, fontWeight: 700, fontSize: 132, lineHeight: 1, color: WHITE, opacity: title, transform: `scale(${0.85 + title * 0.15})`, textShadow: `0 0 50px ${BLUE}` }}>
          A journey of knowledge
        </h1>
        <p style={{ margin: 0, fontFamily: theme.body, fontSize: 40, color: "rgba(255,255,255,0.85)", opacity: sub, transform: `translateY(${(1 - sub) * 20}px)` }}>
          exploring the galaxies of untapped potential
        </p>
      </AbsoluteFill>
      <Flare at={6} duration={30} y={47} />
    </AbsoluteFill>
  );
}

function Montage() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const speed = interpolate(frame, [0, durationInFrames], [4, 40], { easing: Easing.in(Easing.quad) });
  const lit = Math.floor(frame / S(BEAT / 2)); // one galaxy per eighth note
  const whiteout = interpolate(frame, [durationInFrames - 14, durationInFrames], [0, 1], clamp);
  const go = useIn(S(2.6), 12);
  return (
    <AbsoluteFill>
      <WarpField speed={speed} streak={interpolate(frame, [0, 60], [0.2, 1], clamp)} count={560} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 440px)", gap: 22 }}>
          {STOPS.map((s, i) => {
            const on = i < lit;
            return (
              <div key={s.id} style={{ ...panel, padding: "22px 26px", opacity: on ? 1 : 0.18, borderColor: on ? BLUE : "rgba(255,255,255,0.16)", background: on ? "rgba(0,0,0,0.8)" : "rgba(0,0,0,0.4)", boxShadow: on ? `0 0 40px ${BLUE}88` : "none", transform: `scale(${on ? 1 : 0.95})` }}>
                <div style={{ fontFamily: theme.mono, fontSize: 18, letterSpacing: 3, color: BLUE }}>GALAXY {String(i + 1).padStart(2, "0")}</div>
                <div style={{ marginTop: 6, fontFamily: theme.display, fontWeight: 600, fontSize: 32, color: WHITE }}>{s.short}</div>
              </div>
            );
          })}
        </div>
        <p style={{ marginTop: 44, fontFamily: theme.mono, fontSize: 34, letterSpacing: 12, color: WHITE, opacity: go, textShadow: `0 0 24px ${BLUE}` }}>ALL SYSTEMS GO</p>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: WHITE, opacity: whiteout }} />
    </AbsoluteFill>
  );
}

function Outro() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const flash = interpolate(frame, [0, 22], [1, 0], clamp);
  const logo = useIn(4, 13);
  const name = useIn(12, 15);
  const soon = useIn(S(3.2), 12);
  const tag = useIn(S(4.4), 20);
  const pulse = usePulse(5);
  const end = interpolate(frame, [durationInFrames - 30, durationInFrames], [1, 0], clamp);
  const letters = "COMING SOON".split("");
  return (
    <AbsoluteFill style={{ opacity: end }}>
      <Space drift={0.3}>
        <div style={{ position: "absolute", inset: 0, transform: `scale(${interpolate(frame, [0, durationInFrames], [1.15, 1])})`, transformOrigin: "960px 540px" }}>
          <Galaxy seed="home" x={960} y={560} size={620} tilt={0.3} arms={2} spin={0.6} coreBoost={0.15 + pulse * 0.1} />
        </div>
        <AbsoluteFill style={{ background: "radial-gradient(45% 45% at 50% 50%, rgba(0,0,0,0.55), transparent 80%)" }} />
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", textAlign: "center" }}>
          {/* The navbar mark (frontend/public/logo.svg, copied to public/logo.svg). */}
          <Img src={staticFile("logo.svg")} width={144} height={144} style={{ borderRadius: 32, opacity: logo, transform: `scale(${logo})`, boxShadow: `0 0 90px ${BLUE}, 0 0 30px ${WHITE}` }} />          <h1 style={{ margin: "34px 0 0", fontFamily: theme.display, fontWeight: 700, fontSize: 150, lineHeight: 1, color: WHITE, opacity: name, transform: `translateY(${(1 - name) * 30}px)`, textShadow: `0 0 50px ${BLUE}` }}>
            Notestack <span style={{ color: BLUE, textShadow: `0 0 30px ${BLUE}` }}>AI</span>
          </h1>
          <div style={{ marginTop: 44, display: "flex", gap: 6 }}>
            {letters.map((ch, i) => {
              const s = spring({ frame: frame - S(3.2) - i * 2, fps: LAUNCH_FPS, config: { damping: 11 } });
              return (
                <span key={i} style={{ display: "inline-block", minWidth: ch === " " ? 30 : undefined, fontFamily: theme.mono, fontWeight: 400, fontSize: 64, letterSpacing: 10, color: WHITE, opacity: Math.min(1, s) * soon, transform: `translateY(${(1 - s) * 40}px)`, textShadow: `0 0 ${20 + pulse * 20}px ${BLUE}, 0 0 60px ${BLUE}` }}>
                  {ch}
                </span>
              );
            })}
          </div>
          <p style={{ margin: "40px 0 0", fontFamily: theme.body, fontSize: 34, color: "rgba(255,255,255,0.8)", opacity: tag }}>
            Your knowledge, in orbit. <span style={{ color: BLUE }}>notestack.ai</span>
          </p>
        </AbsoluteFill>
        <Flare at={S(3.1)} duration={34} y={64} />
      </Space>
      <AbsoluteFill style={{ background: WHITE, opacity: flash }} />
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------- composition

const RENDER: Record<LaunchSceneId, () => JSX.Element> = {
  intro: Intro,
  launch: Launch,
  sources: () => <Stop id="sources"><SourcesVisual /></Stop>,
  research: () => <Stop id="research"><ResearchVisual /></Stop>,
  map: () => <Stop id="map"><MapVisual /></Stop>,
  voice: () => <Stop id="voice"><VoiceVisual /></Stop>,
  audio: () => <Stop id="audio"><AudioVisual /></Stop>,
  video: () => <Stop id="video"><VideoVisual /></Stop>,
  launchkit: () => <Stop id="launchkit"><LaunchKitVisual /></Stop>,
  launchpad: () => <Stop id="launchpad"><LaunchpadVisual /></Stop>,
  resurface: () => <Stop id="resurface"><ResurfaceVisual /></Stop>,
  montage: Montage,
  outro: Outro,
};

function FadeIn({ skip, children }: { skip: boolean; children: ReactNode }) {
  const frame = useCurrentFrame();
  const opacity = skip ? 1 : interpolate(frame, [0, S(XF)], [0, 1], clamp);
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
}

export function LaunchTrailer() {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.black }}>
      <SoundTrack src={staticFile("launch-vo/music.wav")} volume={musicVolume} />
      {LAUNCH_SCENES.map((scene, i) => {
        const last = i === LAUNCH_SCENES.length - 1;
        const Scene = RENDER[scene.id];
        // Hard cut into the outro (the montage whites out); crossfade everywhere else.
        const skipFade = i === 0 || scene.id === "outro" || scene.id === "launch";
        return (
          <Sequence key={scene.id} from={S(scene.start)} durationInFrames={S(scene.len + (last ? 0 : XF))} name={scene.id}>
            <FadeIn skip={skipFade}>
              <Scene />
            </FadeIn>
            {scene.vo !== null && (
              <Sequence from={S(scene.vo)} name={`vo-${scene.id}`}>
                <SoundTrack src={staticFile(`launch-vo/${scene.id}.mp3`)} volume={1} />
              </Sequence>
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

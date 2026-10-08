import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Audio as SoundTrack, Easing, interpolate, random, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";
import { DEMO_VO_SECONDS } from "./demoVo";
import { Lockup } from "./Lockup";

/** Landing page product demo: the real app, one feature at a time. 1920x1080, 30 fps, ~47 s.
 * Scenes: intro, sync, ask, map, audio, video, edit, launch kit, outro. Each product scene is a
 * window with a cursor that does the thing; the narrator adds a sparse journey-of-discovery line here and there.
 * Strict palette: black, #217cff, white. */

export const DEMO_FPS = 30;
const S = (seconds: number) => Math.round(seconds * DEMO_FPS);

// Narration (public/demo-vo/*.mp3, voiced by "Nora Vale, Mission Control"): a few scenes (intro, sync, map,
// launch kit, outro) speak, starting `vo` seconds in. Scenes keep their minimum length for the animation and stretch when a
// line needs more room, so it always ends with a breath before the scene changes.
const BASE_SCENES = [
  { id: "warp", len: 5.2, vo: 0.6 },
  { id: "sync", len: 5.0, vo: 0.5 },
  { id: "ask", len: 6.0 },
  { id: "map", len: 6.5, vo: 0.6 },
  { id: "audio", len: 5.5 },
  { id: "video", len: 6.5 },
  { id: "edit", len: 6.0 },
  { id: "kit", len: 5.5, vo: 0.5 },
  { id: "outro", len: 4.2, vo: 0.5 },
] as const;
type SceneId = (typeof BASE_SCENES)[number]["id"];
const XFADE = 0.5; // seconds of overlap between scenes
const BREATH = 0.8; // gap between the end of a line and the scene change (includes the crossfade)

// Narration clip lengths, written by scripts/make_demo_vo.py; the music ducks under them.
const VO_SECONDS: Partial<Record<SceneId, number>> = DEMO_VO_SECONDS;
const SCENES = BASE_SCENES.map((s) => {
  const vo = "vo" in s ? s.vo : undefined;
  const line = VO_SECONDS[s.id];
  return { id: s.id, vo, len: vo !== undefined && line ? Math.max(s.len, vo + line + BREATH) : s.len };
});

/** Frame ranges where the narrator is speaking, in composition time. */
const VO_WINDOWS: [number, number][] = (() => {
  let cursor = 0;
  const windows: [number, number][] = [];
  for (const scene of SCENES) {
    const line = VO_SECONDS[scene.id];
    if (scene.vo !== undefined && line) {
      const start = cursor + scene.vo;
      windows.push([Math.round(start * DEMO_FPS), Math.round((start + line) * DEMO_FPS)]);
    }
    cursor += scene.len - XFADE;
  }
  return windows;
})();

const MUSIC = 0.5;
const MUSIC_DUCKED = 0.17;

/** Music level: full between lines, eased down around each line (0.3 s ramps). */
function musicVolume(frame: number): number {
  const ramp = 9;
  let level = MUSIC;
  for (const [a, b] of VO_WINDOWS) {
    if (frame >= a - ramp && frame <= b + ramp) {
      const into = interpolate(frame, [a - ramp, a, b, b + ramp], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
      level = Math.min(level, MUSIC - (MUSIC - MUSIC_DUCKED) * into);
    }
  }
  return level;
}

export const DEMO_DURATION = S(SCENES.reduce((n, s) => n + s.len, 0) - XFADE * (SCENES.length - 1));

const BLUE = theme.blue;
const ease = Easing.bezier(0.22, 1, 0.36, 1);

// Shared pieces

/** 3D starfield flying toward the camera. `speed` can ramp for warp streaks. */
export function WarpField({ speed, count = 420, streak = 0 }: { speed: number; count?: number; streak?: number }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const cx = width / 2;
  const cy = height / 2;
  return (
    <AbsoluteFill style={{ backgroundColor: theme.black }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(55% 45% at 50% 50%, ${BLUE}22, transparent 70%), radial-gradient(40% 30% at 80% 20%, ${BLUE}14, transparent 70%)`,
        }}
      />
      <svg width={width} height={height}>
        {Array.from({ length: count }).map((_, i) => {
          const angle = random(`a${i}`) * Math.PI * 2;
          const base = random(`z${i}`);
          const z = (((base - frame * speed * 0.004) % 1) + 1) % 1; // 1 far, 0 at the camera
          const depth = 0.04 + z;
          const r = (random(`r${i}`) * 0.9 + 0.1) * 900;
          const x = cx + (Math.cos(angle) * r) / depth / 6;
          const y = cy + (Math.sin(angle) * r) / depth / 6;
          const size = Math.max(0.4, (1 - z) * 2.6);
          const alpha = Math.min(1, (1 - z) * 1.4);
          const blue = random(`b${i}`) < 0.25;
          if (streak > 0.02) {
            const z2 = z + streak * 0.08;
            const d2 = 0.04 + z2;
            const x2 = cx + (Math.cos(angle) * r) / d2 / 6;
            const y2 = cy + (Math.sin(angle) * r) / d2 / 6;
            return (
              <line key={i} x1={x} y1={y} x2={x2} y2={y2} stroke={blue ? BLUE : theme.white} strokeOpacity={alpha} strokeWidth={size * 0.8} strokeLinecap="round" />
            );
          }
          return <circle key={i} cx={x} cy={y} r={size} fill={blue ? BLUE : theme.white} opacity={alpha} />;
        })}
      </svg>
    </AbsoluteFill>
  );
}

/** A diagonal light flare that sweeps across, with a hot core and anamorphic streak. */
export function Flare({ at, duration = 24, y = 50 }: { at: number; duration?: number; y?: number }) {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [at, at + duration], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  if (p <= 0 || p >= 1) return null;
  const x = interpolate(p, [0, 1], [-10, 110]);
  const a = Math.sin(p * Math.PI);
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen" }}>
      <div
        style={{
          position: "absolute",
          left: `${x}%`,
          top: `${y}%`,
          width: 520,
          height: 520,
          marginLeft: -260,
          marginTop: -260,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(255,255,255,${0.9 * a}) 0%, ${BLUE}${Math.round(a * 120).toString(16).padStart(2, "0")} 18%, transparent 60%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${y}%`,
          height: 3,
          marginTop: -1.5,
          opacity: a * 0.9,
          background: `linear-gradient(90deg, transparent, ${BLUE} ${x - 20}%, #ffffff ${x}%, ${BLUE} ${x + 20}%, transparent)`,
          boxShadow: `0 0 30px ${BLUE}`,
        }}
      />
    </AbsoluteFill>
  );
}

function FadeScene({ len, children }: { len: number; children: ReactNode }) {
  const frame = useCurrentFrame();
  const total = S(len);
  const fade = S(XFADE);
  const opacity = interpolate(frame, [0, fade, total - fade, total], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scale = interpolate(frame, [0, total], [1.04, 1], { easing: ease });
  return <AbsoluteFill style={{ opacity, transform: `scale(${scale})` }}>{children}</AbsoluteFill>;
}

function Caption({ eyebrow, title, delay = 0 }: { eyebrow: string; title: string; delay?: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 18 } });
  return (
    <div style={{ position: "absolute", left: 140, top: 96, opacity: s, transform: `translateY(${(1 - s) * 24}px)` }}>
      <p style={{ margin: 0, fontFamily: theme.mono, fontSize: 24, letterSpacing: 6, textTransform: "uppercase", color: BLUE }}>{eyebrow}</p>
      <h2 style={{ margin: "14px 0 0", fontFamily: theme.display, fontSize: 64, lineHeight: 1.05, color: theme.white, maxWidth: 1400 }}>{title}</h2>
    </div>
  );
}

const panel: CSSProperties = {
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 22,
  background: "rgba(0,0,0,0.72)",
  boxShadow: `0 0 60px ${BLUE}33, 0 0 2px ${BLUE}`,
};

function typed(text: string, frame: number, start: number, cps = 26): string {
  const n = Math.max(0, Math.floor(((frame - start) / DEMO_FPS) * cps));
  return text.slice(0, n);
}

const clamp01 = (frame: number, a: number, b: number) => interpolate(frame, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
/** 0 to 1 and back over 10 frames from `at`: the press of a clicked control. */
const pulse = (frame: number, at: number) => Math.sin(clamp01(frame, at, at + 10) * Math.PI);

// App window and cursor

/** Where a window's content area starts in scene coordinates, so cursor targets can be written in window space. */
const WX = 141;
const WY = 303;
const at = (x: number, y: number) => ({ x: WX + x, y: WY + y });

/** A browser-style app window: 1640 x 668 of content under a 52 px title bar. */
function Win({ children }: { children: ReactNode }) {
  return (
    <div style={{ ...panel, position: "absolute", left: 140, top: 250, width: 1640, height: 720, overflow: "hidden", background: "rgba(3,7,16,0.9)" }}>
      <div style={{ height: 52, display: "flex", alignItems: "center", gap: 10, padding: "0 22px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: 13, height: 13, borderRadius: "50%", background: "rgba(255,255,255,0.22)" }} />
        ))}
        <span style={{ marginLeft: 22, padding: "5px 22px", borderRadius: 999, background: "rgba(255,255,255,0.08)", fontFamily: theme.mono, fontSize: 18, color: "rgba(255,255,255,0.6)" }}>notestack.ai/app</span>
      </div>
      <div style={{ position: "absolute", left: 0, top: 52, right: 0, bottom: 0 }}>{children}</div>
    </div>
  );
}

function Chip({ children, on = false, press = 0, style }: { children: ReactNode; on?: boolean; press?: number; style?: CSSProperties }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 999,
        border: `1px solid ${on ? BLUE : "rgba(255,255,255,0.2)"}`,
        background: on ? `${BLUE}33` : "rgba(255,255,255,0.04)",
        boxShadow: on ? `0 0 22px ${BLUE}77` : "none",
        fontFamily: theme.body,
        fontSize: 26,
        color: theme.white,
        transform: `scale(${1 - 0.06 * press})`,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function Label({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ position: "absolute", fontFamily: theme.mono, fontSize: 20, letterSpacing: 3, textTransform: "uppercase", color: "rgba(255,255,255,0.55)", ...style }}>{children}</span>;
}

type Key = { f: number; x: number; y: number };

/** A mouse cursor that glides through `keys` (scene coordinates) and ripples on each frame in `clicks`. */
function Cursor({ keys, clicks = [] }: { keys: Key[]; clicks?: number[] }) {
  const frame = useCurrentFrame();
  const fs = keys.map((k) => k.f);
  const opts = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease } as const;
  const x = interpolate(frame, fs, keys.map((k) => k.x), opts);
  const y = interpolate(frame, fs, keys.map((k) => k.y), opts);
  const down = clicks.reduce((m, c) => Math.max(m, pulse(frame, c)), 0);
  return (
    <>
      {clicks.map((c) => {
        const p = clamp01(frame, c, c + 16);
        if (p <= 0 || p >= 1) return null;
        return <div key={c} style={{ position: "absolute", left: x - 36 * p, top: y - 36 * p, width: 72 * p, height: 72 * p, borderRadius: "50%", border: `3px solid ${BLUE}`, opacity: 1 - p }} />;
      })}
      <svg width={40} height={44} viewBox="0 0 24 34" style={{ position: "absolute", left: x, top: y, transform: `scale(${1 - 0.12 * down})`, transformOrigin: "0 0", filter: `drop-shadow(0 0 10px ${BLUE})`, zIndex: 50 }}>
        <path d="M1 1 L1 26 L7.5 20.5 L12 31 L16.5 29 L12 18.5 L21 18.5 Z" fill="#ffffff" stroke="#000000" strokeWidth={1.6} strokeLinejoin="round" />
      </svg>
    </>
  );
}

// Scenes

function Warp() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const speed = interpolate(frame, [0, 40, 70, 102], [14, 26, 6, 1.5], { extrapolateRight: "clamp" });
  const streak = interpolate(frame, [0, 35, 70], [1, 1, 0], { extrapolateRight: "clamp" });
  const title = spring({ frame: frame - 42, fps, config: { damping: 14 } });
  const sub = spring({ frame: frame - 58, fps, config: { damping: 18 } });
  return (
    <AbsoluteFill>
      <WarpField speed={speed} streak={streak} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", textAlign: "center" }}>
        <h1 style={{ margin: 0, fontFamily: theme.display, fontSize: 150, lineHeight: 1, color: theme.white, opacity: title, transform: `scale(${0.8 + title * 0.2})` }}>
          Your knowledge,
          <br />
          <span style={{ color: theme.white, textShadow: `0 0 30px ${BLUE}, 0 0 80px ${BLUE}` }}>in orbit.</span>
        </h1>
        <div style={{ marginTop: 44, opacity: sub }}>
          <Lockup size={60} glow={0.7} />
        </div>
      </AbsoluteFill>
      <Flare at={50} duration={30} y={46} />
    </AbsoluteFill>
  );
}

const SOURCES = ["Substack", "Ghost", "WordPress", "Medium", "RSS", "Markdown"];

const POSTS = [
  "Why Things Fall", "Curved Space", "Notes on Orbits", "What Is Entropy?",
  "The Quantum Leap", "Light as a Wave", "Time Is Strange", "Black Hole Basics",
];
const POST_DATES = ["Mar 12", "Mar 04", "Feb 21", "Feb 09", "Jan 30", "Jan 18", "Jan 03", "Dec 20"];

/** 01: paste a link, the archive syncs in. */
function Sync() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const url = typed("yourblog.com", frame, 8, 14);
  const press = pulse(frame, 52);
  const count = Math.round(142 * ease(clamp01(frame, 58, 120)));
  const bar = clamp01(frame, 54, 84);
  return (
    <AbsoluteFill>
      <WarpField speed={1} />
      <Caption eyebrow="01 · Sync" title="Point it at your writing." />
      <Win>
        <div style={{ position: "absolute", left: 80, top: 56, width: 1060, height: 84, borderRadius: 999, border: `1px solid ${BLUE}88`, background: "rgba(255,255,255,0.05)", display: "flex", alignItems: "center", paddingLeft: 38, fontFamily: theme.body, fontSize: 38, color: url ? theme.white : "rgba(255,255,255,0.4)" }}>
          {url || "yourblog.com"}
          <span style={{ opacity: frame % 30 < 15 ? 1 : 0, color: BLUE }}>|</span>
        </div>
        <div style={{ position: "absolute", left: 1160, top: 56, width: 220, height: 84, borderRadius: 999, background: BLUE, display: "grid", placeItems: "center", fontFamily: theme.body, fontWeight: 600, fontSize: 32, color: theme.white, transform: `scale(${1 - 0.06 * press})`, boxShadow: `0 0 ${24 + press * 40}px ${BLUE}` }}>
          Sync
        </div>
        <div style={{ position: "absolute", left: 80, top: 158, width: 1060 * bar, height: 4, borderRadius: 2, background: BLUE, boxShadow: `0 0 14px ${BLUE}`, opacity: bar > 0 && bar < 1 ? 1 : 0 }} />
        <div style={{ position: "absolute", left: 80, top: 186, display: "flex", gap: 12 }}>
          {SOURCES.map((name, i) => {
            const on = spring({ frame: frame - 14 - i * 5, fps, config: { damping: 16 } });
            return (
              <Chip key={name} on={on > 0.5} style={{ padding: "8px 20px", fontSize: 21, fontFamily: theme.mono, opacity: 0.3 + on * 0.7 }}>
                {name}
              </Chip>
            );
          })}
        </div>
        <div style={{ position: "absolute", right: 80, top: 176, fontFamily: theme.mono, color: theme.white, display: "flex", alignItems: "baseline", gap: 14 }}>
          <span style={{ fontFamily: theme.display, fontSize: 56, textShadow: `0 0 24px ${BLUE}` }}>{count}</span>
          <span style={{ fontSize: 20, letterSpacing: 3, color: "rgba(255,255,255,0.6)" }}>POSTS SYNCED</span>
        </div>
        <div style={{ position: "absolute", left: 80, top: 280, width: 1480, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          {POSTS.map((title, i) => {
            const s = spring({ frame: frame - 60 - i * 5, fps, config: { damping: 14 } });
            return (
              <div key={title} style={{ display: "flex", alignItems: "center", gap: 20, height: 74, padding: "0 26px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.04)", opacity: s, transform: `translateY(${(1 - s) * 30}px)`, fontFamily: theme.body, fontSize: 28, color: theme.white }}>
                <span style={{ width: 30, height: 30, borderRadius: "50%", background: BLUE, display: "grid", placeItems: "center", fontSize: 18, boxShadow: `0 0 14px ${BLUE}` }}>✓</span>
                <span style={{ flex: 1 }}>{title}</span>
                <span style={{ fontFamily: theme.mono, fontSize: 20, color: "rgba(255,255,255,0.5)" }}>{POST_DATES[i]}</span>
              </div>
            );
          })}
        </div>
      </Win>
      <Cursor
        keys={[{ f: 0, x: 1560, y: 880 }, { f: 42, ...at(1270, 98) }, { f: 74, ...at(1270, 98) }, { f: 100, ...at(1100, 470) }]}
        clicks={[52]}
      />
    </AbsoluteFill>
  );
}

/** 02: ask a question, click the citation, see the exact lines. */
function Ask() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const q = typed("What have I written about gravity?", frame, 8, 30);
  const answer = spring({ frame: frame - 66, fps, config: { damping: 18 } });
  const cite = spring({ frame: frame - 92, fps, config: { damping: 16 } });
  const open = spring({ frame: frame - 114, fps, config: { damping: 18 } });
  const steps = ["Searching for gravity|spacetime", "Reading Why Things Fall, lines 12 to 20", "Reading Curved Space, lines 4 to 9"];
  const context = ["Newton called it a force pulling things down.", "Einstein saw something different: gravity is", "the curvature of spacetime itself.", "Mass tells space how to bend.", "Objects follow the straightest path."];
  return (
    <AbsoluteFill>
      <WarpField speed={0.7} count={300} />
      <Caption eyebrow="02 · Ask" title="Every answer, cited to the line." />
      <Win>
        <div style={{ position: "absolute", left: 80, top: 36, width: 880, display: "grid", gap: 20 }}>
          <div style={{ justifySelf: "end", padding: "14px 24px", borderRadius: "18px 18px 4px 18px", background: `${BLUE}22`, border: `1px solid ${BLUE}66`, fontFamily: theme.body, fontSize: 30, color: theme.white, minWidth: 40, minHeight: 46 }}>
            {q || " "}
          </div>
          <div style={{ fontFamily: theme.mono, fontSize: 20, color: BLUE, display: "grid", gap: 6 }}>
            {steps.map((s, i) => (
              <span key={s} style={{ opacity: clamp01(frame, 40 + i * 8, 48 + i * 8) }}>
                {s}
              </span>
            ))}
          </div>
          <p style={{ margin: 0, fontFamily: theme.body, fontSize: 32, lineHeight: 1.5, color: theme.white, opacity: answer, transform: `translateY(${(1 - answer) * 16}px)` }}>
            You wrote that <b>gravity is the curvature of spacetime</b> <Marker n={1} glow={cite} /> and that orbits are objects falling around that curve <Marker n={2} glow={cite} />.
          </p>
        </div>
        {[
          { n: 1, label: "Why Things Fall · L12 to 14" },
          { n: 2, label: "Curved Space · L4 to 9" },
        ].map((c, i) => (
          <Chip key={c.n} on={cite > 0.5 && (i === 0 ? frame >= 112 : false)} press={i === 0 ? pulse(frame, 112) : 0} style={{ position: "absolute", left: 80 + i * 450, top: 460, width: 420, height: 60, fontFamily: theme.mono, fontSize: 21, opacity: cite, gap: 10 }}>
            <span style={{ color: BLUE }}>[{c.n}]</span> {c.label}
          </Chip>
        ))}
        <div style={{ ...panel, position: "absolute", left: 1010, top: 36, width: 560, padding: 30, opacity: open, transform: `translateX(${(1 - open) * 60}px)` }}>
          <p style={{ margin: 0, fontFamily: theme.mono, fontSize: 20, color: BLUE, letterSpacing: 2 }}>[1] WHY THINGS FALL · L12 TO 14</p>
          {context.map((l, i) => {
            const hit = i >= 1 && i <= 3;
            return (
              <div key={l} style={{ display: "flex", gap: 18, marginTop: 12, fontFamily: theme.body, fontSize: 25, color: hit ? theme.white : "rgba(255,255,255,0.45)", background: hit ? `${BLUE}26` : "transparent", boxShadow: hit ? `inset 4px 0 0 ${BLUE}` : "none", padding: "6px 12px", borderRadius: 8 }}>
                <span style={{ fontFamily: theme.mono, fontSize: 18, color: "rgba(255,255,255,0.5)", paddingTop: 4 }}>{11 + i}</span>
                {l}
              </div>
            );
          })}
          <p style={{ margin: "22px 0 0", fontFamily: theme.mono, fontSize: 19, color: BLUE }}>✓ Line range verified</p>
        </div>
      </Win>
      <Cursor
        keys={[{ f: 0, x: 1560, y: 880 }, { f: 100, ...at(260, 490) }, { f: 126, ...at(260, 490) }, { f: 160, ...at(1250, 560) }]}
        clicks={[112]}
      />
    </AbsoluteFill>
  );
}

function Marker({ n, glow }: { n: number; glow: number }) {
  return (
    <span style={{ display: "inline-block", minWidth: 34, padding: "0 8px", borderRadius: 8, fontFamily: theme.mono, fontSize: 20, verticalAlign: "super", color: theme.white, background: `${BLUE}${glow > 0.5 ? "" : "55"}`, border: `1px solid ${BLUE}`, boxShadow: `0 0 ${glow * 24}px ${BLUE}`, textAlign: "center" }}>
      {n}
    </span>
  );
}

const TOPICS = [
  "Gravity", "Spacetime", "Black holes", "Orbits", "Relativity", "Quantum", "Entropy", "Optics",
  "Waves", "Energy", "Chaos", "Cosmology", "Fields", "Symmetry", "Time",
];
const MAP_SHAPES = ["Orbit", "Spiral", "Figure", "Cluster"];
type Shape = "orbit" | "spiral" | "figure" | "cluster";

/** Where topic `i` sits in each shape of the Mind Constellation (window coordinates). */
function place(shape: Shape, i: number): { x: number; y: number } {
  const cx = 620;
  const cy = 350;
  const n = TOPICS.length;
  if (shape === "orbit") {
    if (i === 0) return { x: cx, y: cy };
    const r = [170, 270, 360][(i - 1) % 3];
    const a = i * 2.4;
    return { x: cx + Math.cos(a) * r * 1.5, y: cy + Math.sin(a) * r * 0.58 };
  }
  if (shape === "spiral") {
    const t = i / (n - 1);
    const a = t * Math.PI * 2.4 + 0.4;
    const r = 110 + t * 260;
    return { x: cx + Math.cos(a) * r * 1.5, y: cy + Math.sin(a) * r * 0.58 };
  }
  if (shape === "figure") {
    // A constellation figure: one long wave of stars across the sky.
    return { x: 140 + i * 78, y: cy + (i % 2 ? -1 : 1) * (90 + (i % 3) * 30) };
  }
  const centers = [{ x: 330, y: 250 }, { x: 800, y: 220 }, { x: 640, y: 490 }];
  const c = centers[i % 3];
  const k = Math.floor(i / 3);
  const a = k * 1.25 + (i % 3);
  const r = 36 + k * 24;
  return { x: c.x + Math.cos(a) * r * 1.3, y: c.y + Math.sin(a) * r };
}

/** Frame windows in which the layout morphs to the next shape (after each pill click). */
const MORPHS: [Shape, number, number][] = [["spiral", 58, 82], ["figure", 94, 118], ["cluster", 126, 150]];

function mapPos(i: number, frame: number): { x: number; y: number } {
  let { x, y } = place("orbit", i);
  for (const [shape, from, to] of MORPHS) {
    const t = ease(clamp01(frame, from, to));
    const next = place(shape, i);
    x += (next.x - x) * t;
    y += (next.y - y) * t;
  }
  return { x, y };
}

/** 03: the Mind Constellation, switching shapes and diving into a topic. */
function MindMap() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const activeShape = frame < 56 ? 0 : frame < 92 ? 1 : frame < 124 ? 2 : 3;
  const panelIn = spring({ frame: frame - 158, fps, config: { damping: 18 } });
  const hubWin = place("cluster", 0);
  const hub = at(hubWin.x, hubWin.y);
  const selected = frame >= 158;
  const ring = clamp01(frame, 4, 40);
  const dive = 1 + 0.14 * ease(clamp01(frame, 158, 195)); // the camera drifts in on the picked star
  const burst = ease(clamp01(frame, 158, 182));
  return (
    <AbsoluteFill>
      <WarpField speed={0.6} count={260} />
      <Caption eyebrow="03 · Map" title="See your whole archive." />
      <Win>
        <svg width={1640} height={668} style={{ position: "absolute", inset: 0 }}>
          <g transform={`translate(${hubWin.x} ${hubWin.y}) scale(${dive}) translate(${-hubWin.x} ${-hubWin.y})`}>
            {/* Orbit rings draw in, then fade as the stars leave them. */}
            {[170, 270, 360].map((r, i) => (
              <ellipse key={r} cx={620} cy={350} rx={r * 1.5} ry={r * 0.58} fill="none" stroke={i % 2 ? "#ffffff" : BLUE} strokeOpacity={0.22 * ring * (1 - ease(clamp01(frame, 58, 82)))} strokeWidth={1.5} strokeDasharray="6 10" />
            ))}
            {TOPICS.map((_, i) => {
              if (i === 0) return null;
              const parent = i < 4 ? 0 : i - 3;
              const from = mapPos(i, frame);
              const to = mapPos(parent, frame);
              const on = clamp01(frame, 6 + i * 3, 24 + i * 3);
              const lit = !selected || parent === 0;
              const t = (frame * 0.018 + i * 0.37) % 1; // a pulse of light travelling toward the hub
              return (
                <g key={i} opacity={lit ? 1 : 0.25}>
                  <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} pathLength={1} stroke={i % 2 ? BLUE : "#ffffff"} strokeOpacity={selected && parent === 0 ? 0.8 : 0.3} strokeWidth={selected && parent === 0 ? 2.5 : 1.5} strokeDasharray={1} strokeDashoffset={1 - on} />
                  {on >= 1 && <circle cx={from.x + (to.x - from.x) * t} cy={from.y + (to.y - from.y) * t} r={3.5} fill="#ffffff" opacity={Math.sin(t * Math.PI)} style={{ filter: `drop-shadow(0 0 6px ${BLUE})` }} />}
                </g>
              );
            })}
            {TOPICS.map((name, i) => {
              const base = mapPos(i, frame);
              const p = { x: base.x + Math.sin(frame * 0.03 + i * 1.9) * 5, y: base.y + Math.cos(frame * 0.025 + i * 1.3) * 5 };
              const born = spring({ frame: frame - 2 - i * 3, fps, config: { damping: 12 } });
              const r = (i === 0 ? 17 : 7 + ((i * 7) % 5)) * born;
              const twinkle = 1 + 0.25 * Math.sin(frame * 0.14 + i * 1.7);
              const near = i === 0 || (i >= 1 && i <= 3);
              const dim = selected && !near ? 0.3 : 1;
              return (
                <g key={name} opacity={dim}>
                  <circle cx={p.x} cy={p.y} r={r * 2.6 * twinkle} fill={BLUE} opacity={0.18 * born} style={{ filter: "blur(8px)" }} />
                  <circle cx={p.x} cy={p.y} r={r} fill="#ffffff" style={{ filter: `drop-shadow(0 0 10px ${BLUE})` }} />
                  {i === 0 && selected && <circle cx={p.x} cy={p.y} r={r + 14 + 22 * burst} fill="none" stroke={BLUE} strokeWidth={3} opacity={1 - 0.6 * burst} />}
                  <text x={p.x} y={p.y + r + 26} textAnchor="middle" fontFamily={theme.body} fontSize={i === 0 ? 26 : 21} fill="#ffffff" opacity={0.85 * born}>
                    {name}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        <div style={{ position: "absolute", left: 40, top: 26, display: "flex", gap: 10 }}>
          {MAP_SHAPES.map((name, i) => (
            <Chip key={name} on={i === activeShape} press={i === 0 ? 0 : pulse(frame, [0, 56, 92, 124][i])} style={{ width: 120, height: 48, fontSize: 22 }}>
              {name}
            </Chip>
          ))}
        </div>
        <p style={{ position: "absolute", left: 40, bottom: 20, margin: 0, fontFamily: theme.mono, fontSize: 18, color: "rgba(255,255,255,0.5)", opacity: 1 - clamp01(frame, 150, 165) }}>Scroll to dive in. Drag to move. Click a star to fly to it.</p>
        <div style={{ ...panel, position: "absolute", right: 40, top: 26, width: 380, padding: 28, opacity: panelIn, transform: `translateX(${(1 - panelIn) * 60}px)` }}>
          <p style={{ margin: 0, fontFamily: theme.display, fontSize: 40, color: theme.white }}>Gravity</p>
          <Label style={{ position: "static", display: "block", marginTop: 22, fontSize: 16 }}>Orbiting here</Label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            {["Spacetime", "Black holes", "Orbits"].map((t) => (
              <Chip key={t} on style={{ padding: "4px 16px", fontSize: 20 }}>{t}</Chip>
            ))}
          </div>
          <Label style={{ position: "static", display: "block", marginTop: 22, fontSize: 16 }}>From your posts</Label>
          {["Why Things Fall", "Curved Space", "Notes on Orbits"].map((t) => (
            <p key={t} style={{ margin: "10px 0 0", fontFamily: theme.body, fontSize: 24, color: theme.white }}>{t}</p>
          ))}
        </div>
      </Win>
      <Cursor
        keys={[
          { f: 0, x: 1560, y: 880 },
          { f: 42, ...at(230, 50) },
          { f: 58, ...at(230, 50) },
          { f: 84, ...at(360, 50) },
          { f: 94, ...at(360, 50) },
          { f: 114, ...at(490, 50) },
          { f: 126, ...at(490, 50) },
          { f: 152, x: hub.x, y: hub.y },
          { f: 172, x: hub.x + 30, y: hub.y + 120 },
        ]}
        clicks={[56, 92, 124, 156]}
      />
    </AbsoluteFill>
  );
}

/** 04: pick a format, create, play. */
function Audio() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const formats = ["Deep dive", "Brief", "Debate"];
  const picked = frame >= 22 ? 2 : 0;
  const bar = clamp01(frame, 52, 84);
  const playing = clamp01(frame, 84, 96);
  const lines = [
    { who: "A", text: "So the big idea here is that gravity is curved spacetime." },
    { who: "B", text: "Right, and orbits are just objects falling around the curve." },
    { who: "A", text: "Which she wrote about back in March, in Curved Space." },
  ];
  const active = Math.min(lines.length - 1, Math.floor(Math.max(0, frame - 92) / 24));
  return (
    <AbsoluteFill>
      <WarpField speed={0.7} count={260} />
      <Caption eyebrow="04 · Listen" title="Turn it into a conversation." />
      <Win>
        <Label style={{ left: 80, top: 36 }}>Format</Label>
        {formats.map((f, i) => (
          <Chip key={f} on={i === picked} press={i === 2 ? pulse(frame, 22) : 0} style={{ position: "absolute", left: 80 + i * 210, top: 80, width: 190, height: 56 }}>
            {f}
          </Chip>
        ))}
        <div style={{ position: "absolute", left: 80, top: 170, width: 300, height: 72, borderRadius: 999, background: BLUE, display: "grid", placeItems: "center", fontFamily: theme.body, fontWeight: 600, fontSize: 30, color: theme.white, transform: `scale(${1 - 0.06 * pulse(frame, 50)})`, boxShadow: `0 0 ${24 + pulse(frame, 50) * 40}px ${BLUE}` }}>
          {bar > 0 && bar < 1 ? "Recording..." : "Create audio"}
        </div>
        <div style={{ position: "absolute", left: 420, top: 202, width: 900 * bar, height: 6, borderRadius: 3, background: BLUE, boxShadow: `0 0 14px ${BLUE}`, opacity: bar > 0 && bar < 1 ? 1 : 0 }} />
        <div style={{ position: "absolute", left: 80, top: 290, width: 1480, height: 170, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, opacity: playing }}>
          {Array.from({ length: 64 }).map((_, i) => {
            const v = Math.abs(Math.sin(frame * 0.35 + i * 0.55) * Math.cos(frame * 0.11 + i * 0.21));
            const env = spring({ frame: frame - 90, fps, config: { damping: 20 } });
            return <div key={i} style={{ width: 14, height: 12 + v * 150 * env, borderRadius: 7, background: i % 2 ? theme.white : BLUE, boxShadow: `0 0 18px ${BLUE}` }} />;
          })}
        </div>
        <div style={{ position: "absolute", left: 80, top: 480, display: "grid", gap: 12 }}>
          {lines.map((l, i) => {
            const on = i === active;
            return (
              <div key={i} style={{ display: "flex", gap: 22, alignItems: "center", opacity: frame >= 92 + i * 24 ? (on ? 1 : 0.45) : 0, fontFamily: theme.body, fontSize: 32, color: theme.white }}>
                <span style={{ width: 46, height: 46, borderRadius: "50%", display: "grid", placeItems: "center", fontFamily: theme.mono, fontSize: 20, background: l.who === "A" ? BLUE : theme.white, color: l.who === "A" ? theme.white : theme.black, boxShadow: on ? `0 0 26px ${BLUE}` : "none" }}>{l.who}</span>
                {l.text}
              </div>
            );
          })}
        </div>
      </Win>
      <Cursor
        keys={[{ f: 0, x: 1560, y: 880 }, { f: 18, ...at(595, 108) }, { f: 30, ...at(595, 108) }, { f: 46, ...at(230, 206) }, { f: 60, ...at(230, 206) }, { f: 100, ...at(900, 560) }]}
        clicks={[22, 50]}
      />
    </AbsoluteFill>
  );
}

const VIDEO_STYLES = ["16:9 Explainer", "9:16 Short", "1:1 Square"];
const TEMPLATE_LOOKS: CSSProperties[] = [
  { background: "linear-gradient(135deg, #000, #0b1730)" },
  { background: `linear-gradient(135deg, ${BLUE}, #0a2a66)` },
  { background: "linear-gradient(135deg, #ffffff, #cfe0ff)" },
  { background: "linear-gradient(135deg, #0b1730, #217cff55)" },
];
const TEMPLATE_NAMES = ["Night", "Signal", "Paper", "Studio"];
const VOICES = ["Nora Vale", "Your voice (clone)", "+ Create a voice"];

/** 05: wizard: pick a style, a template and a voice, create. */
function VideoCreate() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const style = frame >= 34 ? 1 : 0;
  const tpl = frame >= 74 ? 1 : 0;
  const voice = frame >= 114 ? 1 : 0;
  const go = pulse(frame, 162);
  const busy = clamp01(frame, 164, 194);
  return (
    <AbsoluteFill>
      <WarpField speed={0.8} count={260} />
      <Caption eyebrow="05 · Make" title="Pick a look. Pick a voice." />
      <Win>
        <Label style={{ left: 80, top: 30 }}>Video style</Label>
        {VIDEO_STYLES.map((t, i) => (
          <Chip key={t} on={i === style} press={i === 1 ? pulse(frame, 34) : 0} style={{ position: "absolute", left: 80 + i * 250, top: 70, width: 230, height: 56 }}>
            {t}
          </Chip>
        ))}
        <Label style={{ left: 80, top: 160 }}>Template</Label>
        {TEMPLATE_NAMES.map((name, i) => {
          const s = spring({ frame: frame - 6 - i * 5, fps, config: { damping: 16 } });
          const sel = i === tpl;
          return (
            <div key={name} style={{ position: "absolute", left: 80 + i * 300, top: 200, width: 270, height: 190, borderRadius: 16, border: `2px solid ${sel ? BLUE : "rgba(255,255,255,0.14)"}`, boxShadow: sel ? `0 0 30px ${BLUE}88` : "none", overflow: "hidden", opacity: s, transform: `scale(${(0.9 + 0.1 * s) * (i === 1 ? 1 - 0.04 * pulse(frame, 74) : 1)})`, ...TEMPLATE_LOOKS[i] }}>
              <div style={{ position: "absolute", left: 20, top: 24, width: 120, height: 12, borderRadius: 6, background: i === 2 ? "#000" : "#fff", opacity: 0.9 }} />
              <div style={{ position: "absolute", left: 20, top: 52, width: 190, height: 8, borderRadius: 4, background: i === 2 ? "#000" : "#fff", opacity: 0.4 }} />
              <div style={{ position: "absolute", left: 20, bottom: 16, fontFamily: theme.body, fontSize: 22, color: i === 2 ? "#000" : "#fff" }}>{name}</div>
            </div>
          );
        })}
        <Label style={{ left: 80, top: 430 }}>Narration voice</Label>
        {VOICES.map((v, i) => (
          <Chip key={v} on={i === voice} press={i === 1 ? pulse(frame, 114) : 0} style={{ position: "absolute", left: 80 + i * 370, top: 470, width: 340, height: 64 }}>
            {i < 2 && <span style={{ marginRight: 12, color: BLUE }}>▶</span>}
            {v}
          </Chip>
        ))}
        <div style={{ position: "absolute", left: 1240, top: 560, width: 340, height: 76, borderRadius: 999, background: BLUE, display: "grid", placeItems: "center", fontFamily: theme.body, fontWeight: 600, fontSize: 30, color: theme.white, overflow: "hidden", transform: `scale(${1 - 0.06 * go})`, boxShadow: `0 0 ${24 + go * 40}px ${BLUE}` }}>
          <div style={{ position: "absolute", left: 0, bottom: 0, height: 6, width: `${busy * 100}%`, background: "#fff" }} />
          {busy > 0 ? "Making your video..." : "Create video"}
        </div>
      </Win>
      <Cursor
        keys={[
          { f: 0, x: 1560, y: 880 },
          { f: 30, ...at(450, 98) },
          { f: 38, ...at(450, 98) },
          { f: 70, ...at(515, 295) },
          { f: 78, ...at(515, 295) },
          { f: 110, ...at(630, 502) },
          { f: 118, ...at(630, 502) },
          { f: 158, ...at(1410, 598) },
          { f: 190, ...at(1410, 598) },
        ]}
        clicks={[34, 74, 114, 162]}
      />
    </AbsoluteFill>
  );
}

const SCENE_TITLES = ["Gravity is geometry", "Inverse square", "Orbits", "Try it yourself"];

/** 06: the scene editor, then render the MP4. */
function VideoEdit() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const active = frame >= 32 ? 1 : 0;
  const since = frame >= 32 ? frame - 32 : frame;
  const pop = spring({ frame: since, fps, config: { damping: 16 } });
  const render = clamp01(frame, 110, 164);
  const ready = frame >= 166;
  const tabs = ["Edit Scenes", "Images/footage", "Audio", "Settings"];
  return (
    <AbsoluteFill>
      <WarpField speed={0.7} count={260} />
      <Caption eyebrow="06 · Edit" title="Tweak any scene, then render." />
      <Win>
        {tabs.map((t, i) => (
          <span key={t} style={{ position: "absolute", left: 80 + i * 210, top: 12, width: 190, height: 48, display: "grid", placeItems: "center", borderRadius: 12, fontFamily: theme.body, fontSize: 23, color: theme.white, background: i === 0 ? `${BLUE}33` : "transparent", border: `1px solid ${i === 0 ? BLUE : "rgba(255,255,255,0.14)"}` }}>
            {t}
          </span>
        ))}
        <div style={{ position: "absolute", left: 1340, top: 10, width: 220, height: 52, borderRadius: 999, background: BLUE, display: "grid", placeItems: "center", fontFamily: theme.body, fontWeight: 600, fontSize: 24, color: theme.white, transform: `scale(${1 - 0.06 * pulse(frame, 108)})`, boxShadow: `0 0 ${20 + pulse(frame, 108) * 40}px ${BLUE}` }}>
          Download MP4
        </div>
        {SCENE_TITLES.map((t, i) => {
          const s = spring({ frame: frame - 4 - i * 5, fps, config: { damping: 16 } });
          const on = i === active;
          return (
            <div key={t} style={{ position: "absolute", left: 80, top: 80 + i * 120, width: 400, height: 106, borderRadius: 14, border: `1px solid ${on ? BLUE : "rgba(255,255,255,0.14)"}`, background: on ? `${BLUE}26` : "rgba(255,255,255,0.04)", boxShadow: on ? `0 0 24px ${BLUE}66` : "none", display: "flex", alignItems: "center", gap: 18, padding: "0 20px", opacity: s, transform: `translateX(${(1 - s) * -40}px) scale(${i === 1 ? 1 - 0.03 * pulse(frame, 32) : 1})` }}>
              <span style={{ fontFamily: theme.mono, fontSize: 22, color: BLUE }}>{i + 1}</span>
              <div style={{ width: 96, height: 60, borderRadius: 8, background: i % 2 ? `linear-gradient(135deg, ${BLUE}, #0a2a66)` : "linear-gradient(135deg, #000, #0b1730)", border: "1px solid rgba(255,255,255,0.2)" }} />
              <span style={{ fontFamily: theme.body, fontSize: 25, color: theme.white }}>{t}</span>
            </div>
          );
        })}
        <div style={{ position: "absolute", left: 520, top: 80, width: 1040, height: 560, borderRadius: 18, overflow: "hidden", border: "1px solid rgba(255,255,255,0.18)", background: `radial-gradient(70% 70% at 30% 20%, ${BLUE}33, #000 70%)`, boxShadow: `0 0 50px ${BLUE}33` }}>
          {active === 0 ? (
            <div style={{ position: "absolute", left: 70, top: 160, opacity: pop, transform: `translateY(${(1 - pop) * 30}px)` }}>
              <p style={{ margin: 0, fontFamily: theme.mono, fontSize: 22, letterSpacing: 5, color: BLUE }}>SCENE 1</p>
              <p style={{ margin: "14px 0 0", fontFamily: theme.display, fontSize: 86, lineHeight: 1.05, color: theme.white, textShadow: `0 0 30px ${BLUE}` }}>Gravity is<br />a curve.</p>
            </div>
          ) : (
            <>
              <p style={{ position: "absolute", left: 70, top: 56, margin: 0, fontFamily: theme.display, fontSize: 52, color: theme.white, opacity: pop }}>Gravity fades with distance</p>
              {[1, 0.25, 0.11].map((h, i) => (
                <div key={i} style={{ position: "absolute", left: 90 + i * 250, bottom: 90, width: 170, height: 340 * h * ease(clamp01(since, 8 + i * 7, 34 + i * 7)), borderRadius: "12px 12px 0 0", background: i === 0 ? "#ffffff" : BLUE, boxShadow: `0 0 30px ${BLUE}` }} />
              ))}
              <p style={{ position: "absolute", left: 70, bottom: 30, margin: 0, fontFamily: theme.body, fontSize: 26, color: "rgba(255,255,255,0.85)", opacity: pop }}>Double the distance and gravity drops to a quarter.</p>
            </>
          )}
          {render > 0 && (
            <div style={{ ...panel, position: "absolute", left: 270, top: 190, width: 500, padding: "28px 32px", background: "rgba(0,0,0,0.92)", opacity: clamp01(frame, 110, 118) }}>
              <p style={{ margin: 0, fontFamily: theme.body, fontSize: 30, color: theme.white }}>{ready ? "✓ Your MP4 is ready" : "Rendering MP4"}</p>
              <div style={{ marginTop: 20, height: 10, borderRadius: 5, background: "rgba(255,255,255,0.14)" }}>
                <div style={{ width: `${(ready ? 1 : render) * 100}%`, height: "100%", borderRadius: 5, background: BLUE, boxShadow: `0 0 16px ${BLUE}` }} />
              </div>
            </div>
          )}
        </div>
      </Win>
      <Cursor
        keys={[
          { f: 0, x: 1560, y: 880 },
          { f: 26, ...at(280, 373) },
          { f: 38, ...at(280, 373) },
          { f: 100, ...at(1450, 36) },
          { f: 124, ...at(1450, 36) },
          { f: 150, ...at(1250, 480) },
        ]}
        clicks={[32, 108]}
      />
    </AbsoluteFill>
  );
}

/** 07: the Launch Kit appears, then Launchpad schedules it across the week. */
function LaunchKit() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cards = [
    { label: "X THREAD", body: "Gravity is not a force. It is geometry. A thread on how Einstein changed everything." },
    { label: "LINKEDIN", body: "Most of us learned gravity wrong. Here is the picture physicists actually use." },
    { label: "SUBSTACK NOTES", body: "Mass tells space how to bend. Space tells mass how to move." },
    { label: "BLUESKY", body: "Orbits are just falling, forever, around a curve." },
  ];
  const days = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  const slots: Record<number, string> = { 0: "X", 1: "LinkedIn", 2: "Notes", 3: "Bluesky", 4: "X", 5: "LinkedIn", 6: "Notes" };
  return (
    <AbsoluteFill>
      <WarpField speed={0.9} count={260} />
      <Caption eyebrow="07 · Launch" title="A week of posts, scheduled." />
      <Win>
        {cards.map((c, i) => {
          const s = spring({ frame: frame - 8 - i * 7, fps, config: { damping: 14 } });
          return (
            <div key={c.label} style={{ position: "absolute", left: 80 + i * 390, top: 30, width: 350, height: 230, padding: 26, borderRadius: 18, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.04)", opacity: s, transform: `translateY(${(1 - s) * 140}px) rotate(${interpolate(s, [0, 1], [(i - 1.5) * 10, 0])}deg)`, display: "grid", alignContent: "start", gap: 14 }}>
              <span style={{ fontFamily: theme.mono, fontSize: 20, letterSpacing: 3, color: BLUE }}>{c.label}</span>
              <span style={{ fontFamily: theme.body, fontSize: 26, lineHeight: 1.4, color: theme.white }}>{c.body}</span>
            </div>
          );
        })}
        <Label style={{ left: 80, top: 300 }}>Launchpad</Label>
        {days.map((d, i) => {
          const lit = frame >= 76 + i * 6;
          const s = spring({ frame: frame - 76 - i * 6, fps, config: { damping: 12 } });
          return (
            <div key={d} style={{ position: "absolute", left: 80 + i * 215, top: 345, width: 195, height: 130, borderRadius: 14, border: `1px solid ${lit ? BLUE : "rgba(255,255,255,0.14)"}`, background: lit ? `${BLUE}33` : "rgba(255,255,255,0.03)", boxShadow: lit ? `0 0 22px ${BLUE}88` : "none", padding: 14, fontFamily: theme.mono, fontSize: 18, color: "rgba(255,255,255,0.6)" }}>
              {d}
              {lit && (
                <div style={{ marginTop: 22, padding: "8px 0", textAlign: "center", borderRadius: 999, background: theme.white, color: theme.black, fontFamily: theme.body, fontWeight: 600, fontSize: 21, transform: `scale(${0.6 + 0.4 * s})`, boxShadow: `0 0 14px ${BLUE}` }}>{slots[i]}</div>
              )}
            </div>
          );
        })}
        <div style={{ position: "absolute", left: 80, top: 540, display: "flex", gap: 14 }}>
          {["HOOKS", "SEO PACK", "CAROUSEL", "QUOTE CARDS"].map((t, i) => (
            <span key={t} style={{ padding: "10px 18px", border: `1px solid ${BLUE}88`, borderRadius: 999, fontFamily: theme.mono, fontSize: 20, letterSpacing: 2, color: "rgba(255,255,255,0.75)", opacity: clamp01(frame, 40 + i * 6, 50 + i * 6) }}>
              {t}
            </span>
          ))}
        </div>
        <div style={{ position: "absolute", left: 1300, top: 530, width: 280, height: 70, borderRadius: 999, background: BLUE, display: "grid", placeItems: "center", fontFamily: theme.body, fontWeight: 600, fontSize: 28, color: theme.white, transform: `scale(${1 - 0.06 * pulse(frame, 68)})`, boxShadow: `0 0 ${24 + pulse(frame, 68) * 40}px ${BLUE}` }}>
          Schedule all
        </div>
      </Win>
      <Cursor keys={[{ f: 0, x: 1560, y: 880 }, { f: 62, ...at(1440, 566) }, { f: 100, ...at(1440, 566) }, { f: 140, ...at(1100, 600) }]} clicks={[68]} />
    </AbsoluteFill>
  );
}

function Outro() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - 8, fps, config: { damping: 14 } });
  const cta = spring({ frame: frame - 30, fps, config: { damping: 18 } });
  return (
    <AbsoluteFill>
      <WarpField speed={interpolate(frame, [0, 60, 114], [0.5, 2, 12])} streak={interpolate(frame, [70, 114], [0, 1], { extrapolateLeft: "clamp" })} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", textAlign: "center", gap: 30 }}>
        {/* The navbar mark (frontend/public/logo.svg, copied to public/logo.svg). */}
        <div style={{ opacity: Math.min(1, s), transform: `scale(${0.85 + 0.15 * s})` }}>
          <Lockup size={150} />
        </div>
        <p style={{ margin: 0, fontFamily: theme.body, fontSize: 40, color: "rgba(255,255,255,0.8)", opacity: cta }}>Your knowledge, in orbit.</p>
        <p style={{ margin: 0, padding: "18px 40px", borderRadius: 999, background: BLUE, color: theme.white, fontFamily: theme.body, fontWeight: 600, fontSize: 32, opacity: cta, boxShadow: `0 0 40px ${BLUE}` }}>
          Start free at notestack.ai
        </p>
      </AbsoluteFill>
      <Flare at={20} duration={34} y={42} />
    </AbsoluteFill>
  );
}

const RENDER: Record<SceneId, () => JSX.Element> = {
  warp: Warp,
  sync: Sync,
  ask: Ask,
  map: MindMap,
  audio: Audio,
  video: VideoCreate,
  edit: VideoEdit,
  kit: LaunchKit,
  outro: Outro,
};

export function LandingDemo() {
  let cursor = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: theme.black }}>
      <SoundTrack src={staticFile("demo-vo/music.wav")} volume={musicVolume} />
      {SCENES.map((scene) => {
        const from = cursor;
        cursor += S(scene.len - XFADE);
        const Scene = RENDER[scene.id];
        return (
          <Sequence key={scene.id} from={from} durationInFrames={S(scene.len)} name={scene.id}>
            <FadeScene len={scene.len}>
              <Scene />
            </FadeScene>
            {scene.vo !== undefined && (
              <Sequence from={S(scene.vo)} name={`vo-${scene.id}`}>
                <SoundTrack src={staticFile(`demo-vo/${scene.id}.mp3`)} volume={1} />
              </Sequence>
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

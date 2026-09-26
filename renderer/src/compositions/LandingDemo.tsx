import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Audio as SoundTrack, Easing, interpolate, random, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "../theme";

/** Landing page product demo: a trip through the Notestack galaxy. 1920x1080, 30 fps, ~32 s.
 * Scenes: warp in, paste URL, posts enter orbit, cited research, audio overview, Launch Kit,
 * Launchpad, outro. Strict palette: black, #217cff, white. */

export const DEMO_FPS = 30;
const S = (seconds: number) => Math.round(seconds * DEMO_FPS);

// Scene lengths fit the narration (public/demo-vo/*.mp3, voiced by "Nora Vale, Mission Control"):
// each line starts `vo` seconds into its scene and ends with room to breathe before the crossfade.
const SCENES = [
  { id: "warp", len: 5.2, vo: 0.6 },
  { id: "paste", len: 4.6, vo: 0.4 },
  { id: "orbit", len: 7.6, vo: 0.4 },
  { id: "research", len: 5.6, vo: 0.4 },
  { id: "audio", len: 5.1, vo: 0.4 },
  { id: "launchkit", len: 7.8, vo: 0.4 },
  { id: "launchpad", len: 4.6, vo: 0.4 },
  { id: "outro", len: 4.2, vo: 0.5 },
] as const;
const XFADE = 0.5; // seconds of overlap between scenes

// Narration clip lengths (public/demo-vo/durations.json) so the music can duck under the voice.
const VO_SECONDS: Record<(typeof SCENES)[number]["id"], number> = {
  warp: 3.79, paste: 3.27, orbit: 6.3, research: 4.29, audio: 3.74, launchkit: 6.53, launchpad: 3.22, outro: 2.48,
};

/** Frame ranges where the narrator is speaking, in composition time. */
const VO_WINDOWS: [number, number][] = (() => {
  let cursor = 0;
  return SCENES.map((scene) => {
    const start = cursor + scene.vo;
    cursor += scene.len - XFADE;
    return [Math.round(start * 30), Math.round((start + VO_SECONDS[scene.id]) * 30)] as [number, number];
  });
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
function WarpField({ speed, count = 420, streak = 0 }: { speed: number; count?: number; streak?: number }) {
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
function Flare({ at, duration = 24, y = 50 }: { at: number; duration?: number; y?: number }) {
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
    <div style={{ position: "absolute", left: 140, top: 110, opacity: s, transform: `translateY(${(1 - s) * 24}px)` }}>
      <p style={{ margin: 0, fontFamily: theme.mono, fontSize: 24, letterSpacing: 6, textTransform: "uppercase", color: BLUE }}>{eyebrow}</p>
      <h2 style={{ margin: "14px 0 0", fontFamily: theme.display, fontSize: 64, lineHeight: 1.05, color: theme.white, maxWidth: 900 }}>{title}</h2>
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
          Your archive,
          <br />
          <span style={{ color: theme.white, textShadow: `0 0 30px ${BLUE}, 0 0 80px ${BLUE}` }}>in orbit.</span>
        </h1>
        <p style={{ marginTop: 40, fontFamily: theme.mono, fontSize: 30, letterSpacing: 4, color: "rgba(255,255,255,0.75)", opacity: sub }}>
          NOTESTACK
        </p>
      </AbsoluteFill>
      <Flare at={50} duration={30} y={46} />
    </AbsoluteFill>
  );
}

function Paste() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const url = typed("yourname.substack.com", frame, 18, 18);
  const press = spring({ frame: frame - 62, fps, config: { damping: 10, mass: 0.5 } });
  const ring = interpolate(frame, [64, 100], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill>
      <WarpField speed={1.2} />
      <Caption eyebrow="Step 01" title="Paste your Substack URL" />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ ...panel, display: "flex", alignItems: "center", gap: 18, padding: 14, width: 1100, borderRadius: 999, marginTop: 120 }}>
          <div style={{ flex: 1, fontFamily: theme.body, fontSize: 40, color: url ? theme.white : "rgba(255,255,255,0.4)", paddingLeft: 30 }}>
            {url || "yourname.substack.com"}
            <span style={{ opacity: frame % 30 < 15 ? 1 : 0, color: BLUE }}>|</span>
          </div>
          <div
            style={{
              position: "relative",
              padding: "24px 44px",
              borderRadius: 999,
              background: BLUE,
              color: theme.white,
              fontFamily: theme.body,
              fontWeight: 600,
              fontSize: 32,
              transform: `scale(${1 - 0.06 * Math.sin(press * Math.PI)})`,
              boxShadow: `0 0 ${30 + press * 40}px ${BLUE}`,
            }}
          >
            Launch my archive
            <div
              style={{
                position: "absolute",
                inset: -ring * 60,
                borderRadius: 999,
                border: `2px solid ${BLUE}`,
                opacity: 1 - ring,
              }}
            />
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

const POSTS = [
  "On Pricing", "Writing Every Day", "The Paid Tier", "Why I Quit Twitter", "Notes on Craft", "Letters to Readers",
  "The Long Game", "Small Audiences", "Habits Beat Talent", "Editing Myself", "A Year of Essays", "What Readers Want",
];

function Orbit() {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const cx = width / 2 + 180;
  const cy = height / 2 + 60;
  const count = Math.floor(interpolate(frame, [20, 110], [0, 142], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const planet = spring({ frame, fps, config: { damping: 20 } });
  return (
    <AbsoluteFill>
      <WarpField speed={0.8} />
      <Caption eyebrow="Step 02" title="Watch your posts come into orbit" />
      <svg width={width} height={height} style={{ position: "absolute" }}>
        <defs>
          <radialGradient id="planet" cx="40%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="35%" stopColor={BLUE} />
            <stop offset="100%" stopColor="#000000" />
          </radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r={150 * planet} fill="url(#planet)" style={{ filter: `drop-shadow(0 0 60px ${BLUE})` }} />
        {[260, 360].map((r, i) => (
          <ellipse key={r} cx={cx} cy={cy} rx={r * 1.6} ry={r * 0.45} fill="none" stroke={i ? "#ffffff" : BLUE} strokeOpacity={0.25} strokeWidth={2} />
        ))}
      </svg>
      {POSTS.map((title, i) => {
        const start = 8 + i * 6;
        const p = interpolate(frame, [start, start + 36], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
        const ring = i % 2 ? 360 : 260;
        const angle = (i / POSTS.length) * Math.PI * 2 + frame * 0.012 * (i % 2 ? 1 : -1);
        const tx = cx + Math.cos(angle) * ring * 1.6;
        const ty = cy + Math.sin(angle) * ring * 0.45;
        const fromX = width + 200;
        const fromY = random(`py${i}`) * height;
        const x = interpolate(p, [0, 1], [fromX, tx]);
        const y = interpolate(p, [0, 1], [fromY, ty]);
        const front = Math.sin(angle) > 0;
        return (
          <div
            key={title}
            style={{
              ...panel,
              position: "absolute",
              left: x,
              top: y,
              transform: `translate(-50%, -50%) scale(${front ? 1 : 0.8})`,
              padding: "12px 20px",
              borderRadius: 12,
              fontFamily: theme.body,
              fontSize: 22,
              color: theme.white,
              opacity: p * (front ? 1 : 0.55),
              zIndex: front ? 2 : 0,
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </div>
        );
      })}
      <div style={{ position: "absolute", left: 140, bottom: 120, fontFamily: theme.mono, color: theme.white }}>
        <span style={{ fontSize: 96, fontFamily: theme.display, textShadow: `0 0 30px ${BLUE}` }}>{count}</span>
        <span style={{ fontSize: 28, marginLeft: 20, color: "rgba(255,255,255,0.7)", letterSpacing: 3 }}>POSTS IN ORBIT</span>
      </div>
    </AbsoluteFill>
  );
}

function Research() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const q = typed("What have I written about pricing?", frame, 10, 30);
  const answer = spring({ frame: frame - 52, fps, config: { damping: 18 } });
  const cite = spring({ frame: frame - 92, fps, config: { damping: 16 } });
  const steps = ["Searching for pric(e|ing)|paid tier", "Reading On Pricing, lines 12 to 20", "Reading The Paid Tier, lines 4 to 9"];
  return (
    <AbsoluteFill>
      <WarpField speed={0.6} count={260} />
      <Caption eyebrow="Research" title="Ask your archive. Every answer cites you." />
      <div style={{ position: "absolute", left: 140, right: 140, top: 360, display: "grid", gridTemplateColumns: "1.25fr 1fr", gap: 40 }}>
        <div style={{ ...panel, padding: 36, display: "grid", gap: 22, alignContent: "start" }}>
          <div style={{ justifySelf: "end", padding: "14px 22px", borderRadius: "18px 18px 4px 18px", background: `${BLUE}22`, border: `1px solid ${BLUE}66`, fontFamily: theme.body, fontSize: 30, color: theme.white }}>
            {q || " "}
          </div>
          <div style={{ fontFamily: theme.mono, fontSize: 20, color: BLUE, display: "grid", gap: 6 }}>
            {steps.map((s, i) => (
              <span key={s} style={{ opacity: interpolate(frame, [26 + i * 8, 34 + i * 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
                {s}
              </span>
            ))}
          </div>
          <p style={{ margin: 0, fontFamily: theme.body, fontSize: 30, lineHeight: 1.5, color: theme.white, opacity: answer, transform: `translateY(${(1 - answer) * 16}px)` }}>
            You raised prices twice and the <b>paid tier doubled</b>{" "}
            <Marker n={1} glow={cite} /> because readers took the work more seriously{" "}
            <Marker n={2} glow={cite} />.
          </p>
        </div>
        <div style={{ ...panel, padding: 30, opacity: cite, transform: `translateX(${(1 - cite) * 60}px)`, alignSelf: "start" }}>
          <p style={{ margin: 0, fontFamily: theme.mono, fontSize: 20, color: BLUE, letterSpacing: 2 }}>[1] ON PRICING · LINES 12 TO 14</p>
          {["The paid tier doubled after I", "raised the price to ten dollars.", "Readers took the work seriously."].map((l, i) => (
            <div key={l} style={{ display: "flex", gap: 18, marginTop: 14, fontFamily: theme.body, fontSize: 26, color: theme.white, background: `${BLUE}26`, boxShadow: `inset 4px 0 0 ${BLUE}`, padding: "6px 12px", borderRadius: 8 }}>
              <span style={{ fontFamily: theme.mono, fontSize: 18, color: "rgba(255,255,255,0.5)", paddingTop: 5 }}>{12 + i}</span>
              {l}
            </div>
          ))}
        </div>
      </div>
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

function Audio() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lines = [
    { who: "A", text: "So the big idea here is that price is a signal." },
    { who: "B", text: "Right, and she has the numbers: the paid tier doubled." },
    { who: "A", text: "Which she wrote about back in March, in On Pricing." },
  ];
  const active = Math.min(lines.length - 1, Math.floor(Math.max(0, frame - 20) / 34));
  return (
    <AbsoluteFill>
      <WarpField speed={0.7} count={260} />
      <Caption eyebrow="Audio overview" title="Two hosts. Your ideas. Grounded." />
      <div style={{ position: "absolute", left: 140, right: 140, top: 380, display: "grid", gap: 40 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, height: 220 }}>
          {Array.from({ length: 64 }).map((_, i) => {
            const v = Math.abs(Math.sin(frame * 0.35 + i * 0.55) * Math.cos(frame * 0.11 + i * 0.21));
            const env = spring({ frame: frame - 6, fps, config: { damping: 20 } });
            return <div key={i} style={{ width: 14, height: 12 + v * 200 * env, borderRadius: 7, background: i % 2 ? theme.white : BLUE, boxShadow: `0 0 18px ${BLUE}` }} />;
          })}
        </div>
        <div style={{ display: "grid", gap: 14 }}>
          {lines.map((l, i) => {
            const on = i === active;
            const seen = i <= active;
            return (
              <div key={i} style={{ display: "flex", gap: 22, alignItems: "center", opacity: seen ? (on ? 1 : 0.45) : 0, fontFamily: theme.body, fontSize: 34, color: theme.white }}>
                <span style={{ width: 52, height: 52, borderRadius: "50%", display: "grid", placeItems: "center", fontFamily: theme.mono, fontSize: 22, background: l.who === "A" ? BLUE : theme.white, color: l.who === "A" ? theme.white : theme.black, boxShadow: on ? `0 0 26px ${BLUE}` : "none" }}>
                  {l.who}
                </span>
                {l.text}
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function LaunchKit() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cards = [
    { label: "X THREAD", body: "I doubled my price. My paid tier doubled too. Here is what I learned." },
    { label: "LINKEDIN", body: "Most writers underprice. I did for two years. Then I ran an experiment." },
    { label: "SUBSTACK NOTES", body: "Price is a signal. Readers told me so, with their wallets." },
    { label: "BLUESKY", body: "Raised my price to $10. Paid readers went up, not down." },
  ];
  return (
    <AbsoluteFill>
      <WarpField speed={0.9} count={260} />
      <Caption eyebrow="Launch Kit" title="One post. Every platform. Your voice." />
      <div style={{ position: "absolute", left: 140, right: 140, top: 380, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 28 }}>
        {cards.map((c, i) => {
          const s = spring({ frame: frame - 10 - i * 7, fps, config: { damping: 14 } });
          const rot = interpolate(s, [0, 1], [(i - 1.5) * 14, 0]);
          return (
            <div key={c.label} style={{ ...panel, padding: 28, minHeight: 300, opacity: s, transform: `translateY(${(1 - s) * 180}px) rotate(${rot}deg)`, display: "grid", alignContent: "start", gap: 18 }}>
              <span style={{ fontFamily: theme.mono, fontSize: 20, letterSpacing: 3, color: BLUE }}>{c.label}</span>
              <span style={{ fontFamily: theme.body, fontSize: 28, lineHeight: 1.4, color: theme.white }}>{c.body}</span>
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 140, bottom: 90, display: "flex", gap: 16, fontFamily: theme.mono, fontSize: 22, color: "rgba(255,255,255,0.7)", letterSpacing: 2 }}>
        {["HOOKS", "SEO PACK", "CAROUSEL", "QUOTE CARDS"].map((t, i) => (
          <span key={t} style={{ padding: "10px 18px", border: `1px solid ${BLUE}88`, borderRadius: 999, opacity: interpolate(frame, [50 + i * 6, 60 + i * 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
            {t}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
}

function Launchpad() {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const lit = [2, 5, 9, 12, 16, 19, 23, 26];
  const rocket = interpolate(frame, [70, 112], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) });
  return (
    <AbsoluteFill>
      <WarpField speed={0.8} count={260} />
      <Caption eyebrow="Launchpad" title="Schedule it. Watch it lift off." />
      <div style={{ position: "absolute", left: 140, top: 360, display: "grid", gridTemplateColumns: "repeat(7, 120px)", gap: 12 }}>
        {Array.from({ length: 28 }).map((_, i) => {
          const on = lit.includes(i) && frame > 8 + lit.indexOf(i) * 6;
          return (
            <div key={i} style={{ height: 88, borderRadius: 12, border: `1px solid ${on ? BLUE : "rgba(255,255,255,0.14)"}`, background: on ? `${BLUE}33` : "rgba(0,0,0,0.5)", boxShadow: on ? `0 0 22px ${BLUE}88` : "none", padding: 10, fontFamily: theme.mono, fontSize: 16, color: "rgba(255,255,255,0.6)" }}>
              {i + 1}
              {on && <div style={{ marginTop: 18, height: 10, borderRadius: 5, background: theme.white, boxShadow: `0 0 12px ${BLUE}` }} />}
            </div>
          );
        })}
      </div>
      <svg width={width} height={height} style={{ position: "absolute" }}>
        <defs>
          <linearGradient id="trail" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor={BLUE} stopOpacity="0" />
            <stop offset="70%" stopColor={BLUE} stopOpacity="0.8" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="1" />
          </linearGradient>
        </defs>
        {(() => {
          // A launch arc from the lower right: curved trail, hot head, exhaust sparks.
          const pt = (u: number) => ({ x: 1360 + 300 * u + 120 * u * u, y: 1000 - 1050 * u + 120 * u * (1 - u) });
          const head = pt(rocket);
          const tail = pt(Math.max(0, rocket - 0.35));
          const path = Array.from({ length: 24 }, (_, i) => pt(Math.max(0, rocket - 0.35) + ((rocket - Math.max(0, rocket - 0.35)) * i) / 23));
          return (
            <>
              <circle cx={1360} cy={1000} r={140 * Math.min(1, rocket * 4)} fill={BLUE} opacity={0.25 * (1 - rocket)} style={{ filter: "blur(30px)" }} />
              {rocket > 0 && (
                <polyline points={path.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke="url(#trail)" strokeWidth={10} strokeLinecap="round" style={{ filter: `drop-shadow(0 0 18px ${BLUE})` }} />
              )}
              {rocket > 0 &&
                Array.from({ length: 16 }).map((_, i) => {
                  const u = Math.max(0, rocket - random(`s${i}`) * 0.3);
                  const q = pt(u);
                  const jitter = (random(`j${i}`) - 0.5) * 60;
                  return <circle key={i} cx={q.x + jitter} cy={q.y + 20} r={2 + random(`k${i}`) * 3} fill="#ffffff" opacity={0.3 + 0.5 * random(`o${i}`)} />;
                })}
              {rocket > 0 && <circle cx={head.x} cy={head.y} r={16} fill="#ffffff" style={{ filter: `drop-shadow(0 0 28px ${BLUE}) drop-shadow(0 0 8px #ffffff)` }} />}
              {rocket === 0 && <circle cx={tail.x} cy={tail.y} r={10} fill="#ffffff" opacity={interpolate(frame, [30, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} style={{ filter: `drop-shadow(0 0 16px ${BLUE})` }} />}
            </>
          );
        })()}
      </svg>
      <div style={{ position: "absolute", left: 1180, top: 400, fontFamily: theme.mono, color: theme.white, opacity: interpolate(frame, [20, 40], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
        <p style={{ margin: 0, fontSize: 22, letterSpacing: 4, color: BLUE }}>NEXT LAUNCH</p>
        <p style={{ margin: "10px 0 0", fontFamily: theme.display, fontSize: 88, textShadow: `0 0 30px ${BLUE}` }}>
          T-{String(Math.max(0, 10 - Math.floor(frame / 7))).padStart(2, "0")}
        </p>
        <p style={{ margin: "6px 0 0", fontSize: 22, color: "rgba(255,255,255,0.7)", letterSpacing: 2 }}>X · LINKEDIN · BLUESKY</p>
      </div>
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
        <div style={{ width: 120, height: 120, borderRadius: 30, background: theme.white, display: "grid", placeItems: "center", opacity: s, transform: `scale(${s})`, boxShadow: `0 0 80px ${BLUE}` }}>
          <div style={{ width: 44, height: 44, borderRadius: "50%", background: theme.black, boxShadow: `18px -18px 0 -10px ${theme.black}` }} />
        </div>
        <h1 style={{ margin: 0, fontFamily: theme.display, fontSize: 120, color: theme.white, opacity: s, textShadow: `0 0 40px ${BLUE}` }}>Notestack</h1>
        <p style={{ margin: 0, fontFamily: theme.body, fontSize: 40, color: "rgba(255,255,255,0.8)", opacity: cta }}>Your archive, in orbit.</p>
        <p style={{ margin: 0, padding: "18px 40px", borderRadius: 999, background: BLUE, color: theme.white, fontFamily: theme.body, fontWeight: 600, fontSize: 32, opacity: cta, boxShadow: `0 0 40px ${BLUE}` }}>
          Free during early access
        </p>
      </AbsoluteFill>
      <Flare at={20} duration={34} y={42} />
    </AbsoluteFill>
  );
}

const RENDER: Record<(typeof SCENES)[number]["id"], () => JSX.Element> = {
  warp: Warp,
  paste: Paste,
  orbit: Orbit,
  research: Research,
  audio: Audio,
  launchkit: LaunchKit,
  launchpad: Launchpad,
  outro: Outro,
};

export function LandingDemo() {
  let cursor = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: theme.black }}>
      <SoundTrack src={staticFile("demo-vo/music.wav")} volume={musicVolume} />
      {SCENES.map((scene, i) => {
        const from = cursor;
        cursor += S(scene.len - XFADE);
        const Scene = RENDER[scene.id];
        return (
          <Sequence key={scene.id} from={from} durationInFrames={S(scene.len)} name={scene.id}>
            <FadeScene len={scene.len}>
              <Scene />
            </FadeScene>
            <Sequence from={S(scene.vo)} name={`vo-${scene.id}`}>
              <SoundTrack src={staticFile(`demo-vo/${scene.id}.mp3`)} volume={1} />
            </Sequence>
            {i === 0 && null}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}

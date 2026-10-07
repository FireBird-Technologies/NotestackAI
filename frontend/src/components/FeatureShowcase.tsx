import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";

/** Landing page feature tour: one full section per feature, alternating sides, each with a small
 * product visual that animates when the section arrives (the parent adds .arrived via Landing's observer). */

type Feature = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  visual: ReactNode;
};

function ChatVisual() {
  return (
    <div className="fx fx-chat">
      <div className="fx-bubble fx-q">What have I written about pricing?</div>
      <div className="fx-steps mono">
        <span>Searching for pric(e|ing)|paid tier</span>
        <span>Reading On Pricing, lines 12 to 20</span>
      </div>
      <p className="fx-answer">
        You raised prices twice and the <b>paid tier doubled</b>
        <span className="fx-cite">1</span>, because readers took the work more seriously<span className="fx-cite">2</span>.
      </p>
      <div className="fx-source">
        <span className="mono">[1] On Pricing · lines 12 to 14</span>
        <span className="fx-line">The paid tier doubled after I raised the price to ten dollars.</span>
      </div>
    </div>
  );
}

const SHAPES = ["Orbit", "Spiral", "Figure", "Cluster"];
const SHAPE_MS = 3500; // how long each shape is shown on its own
const MORPH_MS = 1300;

/** Where the four outer topics sit in each shape (the hub, Gravity, stays put so the dive lines up). */
const LAYOUTS: [number, number][][] = [
  [[74, 30], [20, 24], [26, 82], [78, 76]], // orbit: around the hub
  [[55, 56], [42, 74], [16, 62], [18, 30]], // spiral: winding out
  [[56, 36], [72, 48], [66, 68], [84, 78]], // figure: one long chain of stars
  [[72, 28], [84, 36], [20, 76], [30, 86]], // cluster: two tight groups
];

/** Cycles the shape on a timer while the visual is on screen. Clicking a pill jumps to that shape and pauses
 * the cycle for a while. With reduced motion the shape only changes when the reader clicks. */
function useShapeCycle(ref: RefObject<HTMLElement>) {
  const [view, setView] = useState({ shape: 0, prev: 0, p: 1, t: 0 });
  const go = useRef<(i: number) => void>(() => undefined);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let last = 0;
    let shape = 0;
    let prev = 0;
    let t0 = -MORPH_MS;
    let nextAuto = 0;
    const show = (now: number) => setView({ shape, prev, p: Math.min(1, (now - t0) / MORPH_MS), t: now / 1000 });
    const jump = (i: number, now: number) => {
      if (i === shape) return;
      prev = shape;
      shape = i;
      t0 = now;
    };
    go.current = (i) => {
      const now = performance.now();
      jump(i, now);
      nextAuto = now + 9000;
      show(now);
      if (still) setTimeout(() => show(performance.now() + MORPH_MS), MORPH_MS);
    };
    const tick = (now: number) => {
      if (now >= nextAuto) {
        jump((shape + 1) % SHAPES.length, now);
        nextAuto = now + SHAPE_MS;
      }
      if (now - last > 33) {
        last = now;
        show(now);
      }
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([entry]) => {
      cancelAnimationFrame(raf);
      if (entry.isIntersecting && !still) {
        nextAuto = performance.now() + SHAPE_MS;
        raf = requestAnimationFrame(tick);
      }
    });
    io.observe(node);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ref]);
  return { view, go };
}

function MapVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const { view, go } = useShapeCycle(ref);
  const e = view.p < 0.5 ? 2 * view.p * view.p : 1 - (-2 * view.p + 2) ** 2 / 2;
  // Three levels of depth: topics, the sub-topics inside Gravity, and the posts behind each sub-topic.
  const hub = { x: 38, y: 52, r: 9, label: "Gravity" };
  const names = ["Quantum", "Entropy", "Optics", "Relativity"];
  const outer = names.map((label, i) => {
    const [fx, fy] = LAYOUTS[view.prev][i];
    const [tx, ty] = LAYOUTS[view.shape][i];
    return { label, r: [7, 6, 6, 7][i], x: fx + (tx - fx) * e, y: fy + (ty - fy) * e };
  });
  const topics = [hub, ...outer];
  const links = [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
    [1, 4],
    [2, 3],
  ];
  const subs = [
    { x: 52, y: 40, label: "Spacetime", posts: [[59, 35], [58, 45], [47, 35]] },
    { x: 24, y: 62, label: "Black holes", posts: [[17, 66], [22, 70], [17, 57]] },
    { x: 50, y: 67, label: "Orbits", posts: [[58, 70], [46, 73], [56, 62]] },
  ];
  return (
    <div className="fx fx-map" ref={ref}>
      <div className="fx-pills mono" role="group" aria-label="Shape of the map">
        {SHAPES.map((name, i) => (
          <button key={name} type="button" className={i === view.shape ? "on" : ""} onClick={() => go.current(i)}>
            {name}
          </button>
        ))}
      </div>
      <div className="fx-crumb mono">
        <span>Archive</span>
        <span className="fx-crumb-deep"> › Gravity › Spacetime</span>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <g className="fx-cam">
          <g className="fx-dim">
            {links.map(([a, b], i) => (
              <line key={i} className="fx-edge" style={{ ["--d" as string]: `${i * 0.15}s` }} x1={topics[a].x} y1={topics[a].y} x2={topics[b].x} y2={topics[b].y} />
            ))}
            {links.map(([a, b], i) => {
              const u = (view.t * 0.3 + i * 0.37) % 1; // a pulse of light travelling along the link
              return <circle key={`p${i}`} className="fx-pulse" r="1" fill="#fff" fillOpacity={Math.sin(u * Math.PI)} cx={topics[b].x + (topics[a].x - topics[b].x) * u} cy={topics[b].y + (topics[a].y - topics[b].y) * u} />;
            })}
            {outer.map((n, i) => (
              <g key={n.label}>
                {[0, 1, 2].map((k) => {
                  const angle = i * 1.7 + k * 2.1;
                  return <circle key={k} className="fx-sat" cx={n.x + Math.cos(angle) * (n.r + 6)} cy={n.y + Math.sin(angle) * (n.r + 6)} r="1.1" />;
                })}
                <g className="fx-node" style={{ ["--d" as string]: `${0.5 + i * 0.12}s` }}>
                  <circle cx={n.x} cy={n.y} r={n.r * 0.9} className="fx-halo" style={{ ["--t" as string]: `${(i + 1) * 0.7}s` }} />
                  <circle cx={n.x} cy={n.y} r={n.r * 0.3} fill="#fff" />
                  <text x={n.x} y={n.y + n.r * 0.9 + 5} textAnchor="middle">
                    {n.label}
                  </text>
                </g>
              </g>
            ))}
          </g>
          <g className="fx-deep">
            <ellipse className="fx-ring" cx={hub.x} cy={hub.y} rx="15" ry="12.5" />
            {subs.map((sub) => (
              <g key={sub.label}>
                <line className="fx-deep-edge" x1={hub.x} y1={hub.y} x2={sub.x} y2={sub.y} />
                {sub.posts.map(([px, py]) => (
                  <g key={`${px}-${py}`}>
                    <line className="fx-deep-edge" x1={sub.x} y1={sub.y} x2={px} y2={py} />
                    <circle className="fx-post" cx={px} cy={py} r="0.9" />
                  </g>
                ))}
                <circle className="fx-halo" cx={sub.x} cy={sub.y} r="3.4" />
                <circle cx={sub.x} cy={sub.y} r="1.5" fill="#fff" />
                <text className="fx-sub" x={sub.x} y={sub.y + 5.4} textAnchor="middle">
                  {sub.label}
                </text>
              </g>
            ))}
          </g>
          <g className="fx-node" style={{ ["--d" as string]: "0.3s" }}>
            <circle cx={hub.x} cy={hub.y} r={hub.r * 0.9} className="fx-halo" />
            <circle cx={hub.x} cy={hub.y} r={hub.r * 0.3} fill="#fff" />
            <text x={hub.x} y={hub.y - hub.r * 0.9 - 2} textAnchor="middle">
              {hub.label}
            </text>
          </g>
        </g>
        <g className="fx-panel">
          <rect x="68" y="12" width="30" height="34" rx="2" />
          <text className="fx-panel-h" x="71" y="19">
            Gravity
          </text>
          <text className="fx-panel-k" x="71" y="26">
            FROM YOUR POSTS
          </text>
          {["Why Things Fall", "Curved Space", "Notes on Orbits"].map((title, i) => (
            <text key={title} className="fx-panel-t" x="71" y={32 + i * 5}>
              {title}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}

function AudioVisual() {
  return (
    <div className="fx fx-audio">
      <div className="fx-wave" aria-hidden="true">
        {Array.from({ length: 36 }).map((_, i) => (
          <span key={i} style={{ ["--d" as string]: `${(i % 9) * 0.09}s`, ["--h" as string]: `${30 + ((i * 37) % 60)}%` }} />
        ))}
      </div>
      <div className="fx-lines">
        <p>
          <span className="fx-host a">A</span>So the big idea is that price is a signal.
        </p>
        <p>
          <span className="fx-host b">B</span>And she has the numbers: the paid tier doubled.
        </p>
      </div>
    </div>
  );
}

function VideoVisual() {
  const scenes = ["Price is a signal", "The numbers", "Why it worked"];
  return (
    <div className="fx fx-video">
      <div className="fx-scenes">
        {scenes.map((title, i) => (
          <span key={title} className={i === 1 ? "on" : ""}>
            <i className="mono">{i + 1}</i>
            {title}
          </span>
        ))}
      </div>
      <div className="fx-frame v169">
        <span className="mono">Live preview</span>
        <b>Paid readers, doubled</b>
      </div>
      <div className="fx-render mono">
        <i /> Rendering MP4
      </div>
    </div>
  );
}

function MemoryVisual() {
  const notes = [
    ["audience", "I write for indie founders"],
    ["tone", "Short sentences, no jargon"],
    ["avoid", "Never name competitors"],
  ];
  return (
    <div className="fx fx-memory">
      {notes.map(([key, value]) => (
        <div key={key} className="fx-profile">
          <span className="mono">{key}</span>
          <p>{value}</p>
        </div>
      ))}
      <div className="fx-clone mono">
        <span className="fx-rec" /> Saved from your last chat
      </div>
    </div>
  );
}

function HelpVisual() {
  return (
    <div className="fx fx-help">
      <div className="fx-bubble">How do I make a video from one post?</div>
      <p className="fx-answer">Open Create, choose Video, then pick the post, a template and a voice. You can edit every scene before you render.</p>
      <div className="fx-source">
        <span className="mono">Still stuck?</span>
        <span className="fx-line">Send it to the team. We will email you back.</span>
      </div>
    </div>
  );
}

function KitVisual() {
  const cards = [
    ["X thread", "I doubled my price. My paid tier doubled too."],
    ["LinkedIn", "Most writers underprice. I did for two years."],
    ["Notes", "Price is a signal. Readers told me so."],
    ["Bluesky", "Raised my price to $10. Paid went up."],
  ];
  return (
    <div className="fx fx-kit">
      {cards.map(([label, body], i) => (
        <div key={label} className="fx-card" style={{ ["--d" as string]: `${i * 0.12}s`, ["--r" as string]: `${(i - 1.5) * 4}deg` }}>
          <span className="mono">{label}</span>
          <p>{body}</p>
        </div>
      ))}
    </div>
  );
}

function VoiceVisual() {
  const sliders = [
    ["Stability", 62],
    ["Similarity", 80],
    ["Style", 28],
  ] as const;
  return (
    <div className="fx fx-voice">
      <div className="fx-profile">
        <span className="mono">Your voice</span>
        <p>Warm, direct, short paragraphs. Opens with a number. Never uses jargon.</p>
      </div>
      {sliders.map(([label, v], i) => (
        <div key={label} className="fx-slider" style={{ ["--v" as string]: `${v}%`, ["--d" as string]: `${0.2 + i * 0.15}s` }}>
          <span>{label}</span>
          <i />
        </div>
      ))}
      <div className="fx-clone mono">
        <span className="fx-rec" /> Recording take 2 · 1:24
      </div>
    </div>
  );
}

function PadVisual() {
  const lit = [2, 5, 9, 12, 16, 19];
  return (
    <div className="fx fx-pad">
      <div className="fx-cal">
        {Array.from({ length: 21 }).map((_, i) => (
          <span key={i} className={lit.includes(i) ? "on" : ""} style={{ ["--d" as string]: `${lit.indexOf(i) * 0.12}s` }}>
            {i + 1}
          </span>
        ))}
      </div>
      <div className="fx-launch mono">
        <span>X</span>
        <span>LinkedIn</span>
        <span>Bluesky</span>
        <span>Notes reminder</span>
      </div>
    </div>
  );
}

const FEATURES: Feature[] = [
  {
    id: "research",
    eyebrow: "Research notebook",
    title: "Ask your archive anything. It answers with receipts.",
    body: "Notestack reads your posts the way a careful researcher would: it searches, opens the right post, and cites the exact lines. If you never wrote it, it tells you so instead of guessing.",
    points: ["Every sentence links to the lines it came from", "Chats are saved per notebook", "Thumbs up or down on any answer"],
    visual: <ChatVisual />,
  },
  {
    id: "memory",
    eyebrow: "Memory",
    title: "It remembers who you write for.",
    body: "Notestack keeps short notes about your audience, tone and preferences, learned as you chat, and uses them in every answer and draft. Read, edit or delete any note in Settings.",
    points: ["Notes saved from your conversations", "Edit or delete any note, anytime", "Shared across your notebooks"],
    visual: <MemoryVisual />,
  },
  {
    id: "map",
    eyebrow: "Mind Constellation",
    title: "Fly through the galaxy of your ideas.",
    body: "Open a notebook as a constellation: topics orbit the ideas they share, and every star lists the posts it comes from. Switch the shape, dive in and see what you keep coming back to.",
    points: ["Orbit, spiral, figure or cluster layouts", "Scroll to dive in, click a star to fly to it", "Every star lists the posts behind it"],
    visual: <MapVisual />,
  },
  {
    id: "audio",
    eyebrow: "Audio overview",
    title: "Two hosts talk through your ideas.",
    body: "Turn a post or a whole notebook into a natural conversation, voiced by ElevenLabs. Pick two hosts from a library of voices, or use a voice you made yourself.",
    points: ["Deep dive, brief or debate formats", "Every line grounded in your posts", "Square audiograms from any overview"],
    visual: <AudioVisual />,
  },
  {
    id: "video",
    eyebrow: "Video studio",
    title: "Narrated videos from one post, edited scene by scene.",
    body: "Pick a post or paste a link, choose a template, style and voice, and Notestack writes the script, narrates it and builds the scenes. Edit any scene and watch the live preview update, then render an MP4.",
    points: ["Landscape for YouTube, vertical for Reels and TikTok", "Templates, stock footage, captions and 16 languages", "Square audiograms from any audio overview"],
    visual: <VideoVisual />,
  },
  {
    id: "voice",
    eyebrow: "Voices",
    title: "Sounds like you, on the page and out loud.",
    body: "Notestack learns your writing voice from your own posts. For narration, describe a voice, pick its options, or record a couple of minutes to clone your own, then reuse it in every audio overview and video.",
    points: ["Describe it, pick options or clone yours", "Fine tune stability, similarity and style", "Consented cloning you can revoke anytime"],
    visual: <VoiceVisual />,
  },
  {
    id: "kit",
    eyebrow: "Launch Kit",
    title: "One post becomes a launch on every platform.",
    body: "Hooks, an X thread, a LinkedIn post, Substack Notes, a Bluesky thread, an SEO pack, a carousel and quote cards, all written in your voice from claims the post actually makes.",
    points: ["Edit anything, copy in one click", "Character counts per platform", "Quote cards rendered and ready"],
    visual: <KitVisual />,
  },
  {
    id: "help",
    eyebrow: "Help",
    title: "Stuck? Ask Notestack.",
    body: "A help assistant in the app answers how-to questions about every screen. If it can't, send the question to the team and we will email you back.",
    points: ["Answers about any feature, in plain words", "Hand off to a person in one click", "Always one click away"],
    visual: <HelpVisual />,
  },
  {
    id: "pad",
    eyebrow: "Launchpad",
    title: "Schedule the countdown. We handle liftoff.",
    body: "Plan every post on one calendar. Notestack publishes to X, LinkedIn and Bluesky on time, emails you Substack Notes to paste, and tracks the clicks that follow.",
    points: ["Auto posting with connected accounts", "Tracked links and engagement", "Resurface evergreen posts when they matter"],
    visual: <PadVisual />,
  },
];

export default function FeatureShowcase() {
  return (
    <div className="showcase">
      {FEATURES.map((f, i) => (
        <section key={f.id} id={`feature-${f.id}`} className={`showcase-row arrive${i % 2 ? " flip" : ""}`}>
          <div className="showcase-copy">
            <p className="eyebrow">
              <span className="mono showcase-n">{String(i + 1).padStart(2, "0")}</span> {f.eyebrow}
            </p>
            <h3>{f.title}</h3>
            <p className="muted">{f.body}</p>
            <ul>
              {f.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            {i === FEATURES.length - 1 && (
              <Link to="/auth?mode=signup" className="btn btn-primary">
                Start Exploring
              </Link>
            )}
          </div>
          <div className="showcase-visual card">{f.visual}</div>
        </section>
      ))}
    </div>
  );
}

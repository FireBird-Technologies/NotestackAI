import type { ReactNode } from "react";
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

function MapVisual() {
  const nodes = [
    { x: 50, y: 48, r: 14, label: "Pricing" },
    { x: 22, y: 30, r: 9, label: "Habits" },
    { x: 78, y: 26, r: 10, label: "Audience" },
    { x: 30, y: 76, r: 8, label: "Craft" },
    { x: 74, y: 74, r: 11, label: "Paid tier" },
  ];
  const edges = [
    [0, 1],
    [0, 2],
    [0, 4],
    [1, 3],
    [2, 4],
  ];
  return (
    <div className="fx fx-map">
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        {edges.map(([a, b], i) => (
          <line key={i} className="fx-edge" style={{ ["--d" as string]: `${i * 0.15}s` }} x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y} />
        ))}
        {nodes.map((n, i) => (
          <g key={n.label} className="fx-node" style={{ ["--d" as string]: `${0.3 + i * 0.12}s` }}>
            <circle cx={n.x} cy={n.y} r={n.r * 0.9} className="fx-halo" />
            <circle cx={n.x} cy={n.y} r={n.r * 0.3} fill="#fff" />
            <text x={n.x} y={n.y + n.r * 0.9 + 5} textAnchor="middle">
              {n.label}
            </text>
          </g>
        ))}
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
  return (
    <div className="fx fx-video">
      <div className="fx-frame v916">
        <span className="mono">9:16</span>
        <b>I doubled my price.</b>
      </div>
      <div className="fx-frame v169">
        <span className="mono">16:9</span>
        <b>Why price is a signal</b>
      </div>
      <div className="fx-frame v11">
        <span className="mono">1:1</span>
        <i className="fx-mini-wave" />
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
    points: ["Every sentence links to the lines it came from", "Chats are saved per notebook", "Summaries of whole notebooks, cited"],
    visual: <ChatVisual />,
  },
  {
    id: "map",
    eyebrow: "Topic map",
    title: "See the constellations in your writing.",
    body: "Every post is tagged with what it is really about, then linked to the topics it travels with. Zoom through years of work and spin any topic into a notebook.",
    points: ["Topics merge automatically as you publish", "Spot the themes you keep coming back to", "One click from a topic to a notebook"],
    visual: <MapVisual />,
  },
  {
    id: "audio",
    eyebrow: "Audio overview",
    title: "Two hosts talk through your ideas.",
    body: "Turn a post or a whole notebook into a natural conversation, voiced by ElevenLabs. Pick from a library of commercial voices, or clone your own with consent.",
    points: ["Deep dive, brief or debate formats", "Every line grounded in your posts", "Your cloned voice as host, if you want"],
    visual: <AudioVisual />,
  },
  {
    id: "video",
    eyebrow: "Video studio",
    title: "Shorts, explainers and audiograms, from one post.",
    body: "Notestack storyboards the post, narrates it and renders it with word by word captions and your brand colors. Vertical for Reels and TikTok, wide for YouTube, square for feeds.",
    points: ["9:16 shorts with a hook in two seconds", "16:9 explainers and 1:1 audiograms", "Your logo and accent color on every frame"],
    visual: <VideoVisual />,
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
    id: "voice",
    eyebrow: "Voice profile",
    title: "Sounds like you, on the page and out loud.",
    body: "Notestack learns your tone from your own posts, so drafts read like you wrote them. For audio, tune two hosts or record a couple of minutes to clone your voice.",
    points: ["Editable writing voice", "Commercially licensed voice library", "Consented cloning you can revoke anytime"],
    visual: <VoiceVisual />,
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
                Launch my archive
              </Link>
            )}
          </div>
          <div className="showcase-visual card">{f.visual}</div>
        </section>
      ))}
    </div>
  );
}

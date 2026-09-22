import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import SkyCanvas from "../components/SkyCanvas";
import PricingTiers from "../components/PricingTiers";
import { PublicFooter, PublicNav } from "../components/PublicChrome";
import { blogPosts } from "../content/blogPosts";
import { useAuth } from "../hooks/useAuth";
import {
  ArrowRightIcon,
  HelmetIcon,
  LaunchWindowIcon,
  LaunchpadIcon,
  RocketIcon,
  SignalIcon,
  TelescopeIcon,
} from "../components/icons/Icons";

export const PENDING_SOURCE_KEY = "ns_pending_source";

const FEATURES = [
  {
    icon: TelescopeIcon,
    label: "Research chat",
    title: "Ask your archive anything",
    body: "Every answer cites the exact passage it came from. If you never wrote it, Notestack says so.",
  },
  {
    icon: SignalIcon,
    label: "Audio overview",
    title: "Two hosts, your ideas",
    body: "Turn a post or a whole notebook into a natural two host conversation, voiced by ElevenLabs.",
  },
  {
    icon: LaunchWindowIcon,
    label: "Video",
    title: "Shorts, explainers, audiograms",
    body: "Storyboards generated from your post, rendered with accurate captions in 9:16, 16:9 or 1:1.",
  },
  {
    icon: RocketIcon,
    label: "Launch Kit",
    title: "One post, every platform",
    body: "Threads, LinkedIn, Substack Notes, hooks, quote cards and an SEO pack in one click.",
  },
  {
    icon: HelmetIcon,
    label: "Voice profile",
    title: "Sounds like you",
    body: "Notestack learns your tone from your own posts and scores every draft against it.",
  },
  {
    icon: LaunchpadIcon,
    label: "Launchpad",
    title: "Schedule the countdown",
    body: "Plan every launch on one calendar and resurface evergreen posts when they matter again.",
  },
];

const STEPS = [
  { n: "01", title: "Paste your Substack URL", body: "We find your feed and pull in your posts." },
  { n: "02", title: "Watch them come into orbit", body: "Posts are cleaned, indexed and embedded in minutes." },
  { n: "03", title: "Launch", body: "Ask, listen, render and publish, all grounded in what you wrote." },
];

export default function Landing() {
  const [url, setUrl] = useState("");
  const navigate = useNavigate();
  const { user } = useAuth();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value) return;
    try {
      sessionStorage.setItem(PENDING_SOURCE_KEY, value);
    } catch {
      /* ignore */
    }
    navigate(user ? "/app" : "/auth?mode=signup");
  };

  return (
    <div className="page">
      <SkyCanvas />
      <PublicNav />

      <main>
        <section className="hero">
          <div className="container hero-inner">
            <p className="eyebrow">For Substack writers</p>
            <h1 className="hero-title">
              Your archive,
              <br />
              <span className="glow-text">in orbit.</span>
            </h1>
            <p className="hero-sub muted">
              Notestack turns your posts into a research notebook you can question, podcasts you can publish and
              launch kits for every platform. Every word traced back to what you actually wrote.
            </p>
            <form className="hero-form" onSubmit={onSubmit}>
              <label htmlFor="hero-url" className="sr-only">
                Your Substack URL
              </label>
              <input
                id="hero-url"
                className="input"
                placeholder="yourname.substack.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoComplete="url"
                inputMode="url"
              />
              <button type="submit" className="btn btn-primary">
                Launch my archive
                <ArrowRightIcon size={18} />
              </button>
            </form>
            <p className="mono hero-meta">Free during early access. 20+ posts indexed in under 3 minutes.</p>
          </div>
          <div className="horizon" aria-hidden="true" />
        </section>

        <section className="section demo">
          <div className="container">
            <div className="demo-frame card">
              <div className="demo-bar mono">
                <span>T-minus 00:42</span>
                <span className="muted">Rendering: vertical short</span>
              </div>
              <div className="demo-body">
                <div className="orbit-loader" aria-hidden="true">
                  <span />
                </div>
                <p className="muted">Product demo video lands here.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="section">
          <div className="container">
            <p className="eyebrow">What you get</p>
            <h2 className="section-title">Everything your writing can become</h2>
            <div className="feature-grid">
              {FEATURES.map(({ icon: Icon, label, title, body }) => (
                <article key={label} className="card feature">
                  <div className="feature-label">
                    <Icon />
                    <span className="mono">{label}</span>
                  </div>
                  <h3>{title}</h3>
                  <p className="muted">{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="container">
            <p className="eyebrow">How it works</p>
            <h2 className="section-title">Three steps to liftoff</h2>
            <ol className="steps">
              {STEPS.map((s) => (
                <li key={s.n} className="step">
                  <span className="step-n mono">{s.n}</span>
                  <h3>{s.title}</h3>
                  <p className="muted">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="pricing" className="section">
          <div className="container">
            <p className="eyebrow">Pricing</p>
            <h2 className="section-title">Pick your trajectory</h2>
            <PricingTiers />
          </div>
        </section>

        <section className="section">
          <div className="container">
            <p className="eyebrow">From the blog</p>
            <h2 className="section-title">Field notes</h2>
            <div className="blog-grid">
              {blogPosts.slice(0, 3).map((p) => (
                <Link key={p.slug} to={`/blogs/${p.slug}`} className="card blog-card">
                  <span className="mono muted">
                    {p.category} · {p.readTime}
                  </span>
                  <h3>{p.title}</h3>
                  <p className="muted">{p.description}</p>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className="section final-cta">
          <div className="container">
            <h2 className="section-title">Clear skies ahead.</h2>
            <p className="muted">Paste your URL above or start with an empty notebook.</p>
            <Link to="/auth?mode=signup" className="btn btn-primary">
              Start free
            </Link>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}

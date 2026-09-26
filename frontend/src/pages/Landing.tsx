import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import SkyCanvas from "../components/SkyCanvas";
import FeatureShowcase from "../components/FeatureShowcase";
import PricingTiers from "../components/PricingTiers";
import "../styles/showcase.css";
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

/** The narrated demo. Browsers only autoplay muted, so a button turns the captain's log on. */
function DemoVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (muted) {
      v.currentTime = 0; // start the narration from the top
      v.muted = false;
      void v.play();
    } else {
      v.muted = true;
    }
    setMuted(!muted);
  };
  return (
    <div className="demo-frame card arrive">
      <div className="demo-bar mono">
        <span>Mission log · 00:41</span>
        <button type="button" className="demo-sound" onClick={toggle} aria-pressed={!muted}>
          {muted ? "Play with sound" : "Mute"}
        </button>
      </div>
      <div className="demo-stage">
        <video
          ref={ref}
          className="demo-video"
          src="/demo.mp4"
          poster="/demo-poster.jpg"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-label="Notestack product demo, narrated: paste your Substack, ask your archive, hear an audio overview and launch posts"
        />
        {muted && (
          <button type="button" className="demo-unmute" onClick={toggle} aria-label="Play the demo with sound">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 9v6h4l5 4V5L8 9H4z" />
              <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
            </svg>
            Hear the captain's log
          </button>
        )}
      </div>
    </div>
  );
}

/** Sections drift in out of the depth as they reach the viewport, like planets on approach. */
function useArrivals() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".arrive"));
    if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      els.forEach((el) => el.classList.add("arrived"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("arrived");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.35, rootMargin: "0px 0px -12% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

export default function Landing() {
  const [url, setUrl] = useState("");
  const navigate = useNavigate();
  const { user } = useAuth();
  useArrivals();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Always go to sign in / sign up. A pasted URL rides along and starts connecting after signup
    // (Welcome picks it up); signed in writers go straight to Mission Control, which does the same.
    const value = url.trim();
    if (value) {
      try {
        sessionStorage.setItem(PENDING_SOURCE_KEY, value);
      } catch {
        /* ignore */
      }
    }
    navigate(user ? "/app" : "/auth?mode=signup");
  };

  return (
    <div className="page">
      <SkyCanvas travel />
      <PublicNav />

      <main>
        <section className="hero">
          <div className="container hero-inner">
            <p className="eyebrow">For Substack writers</p>
            <h1 className="hero-title">
              Your archive,
              <br />
              <span className="glow-text shimmer">in orbit.</span>
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
          <div className="horizon" aria-hidden="true">
            <span className="horizon-flare" />
            <span className="horizon-glint g1" />
            <span className="horizon-glint g2" />
            <span className="horizon-glint g3" />
          </div>
          <div className="hero-sweep" aria-hidden="true" />
        </section>

        <section className="section demo">
          <div className="container">
            <DemoVideo />
          </div>
        </section>

        <section id="features" className="section">
          <div className="container">
            <p className="eyebrow">What you get</p>
            <h2 className="section-title">Everything your writing can become</h2>
            <div className="feature-grid">
              {FEATURES.map(({ icon: Icon, label, title, body }, i) => (
                <article key={label} className="card feature arrive" style={{ ["--i" as string]: i % 3 }}>
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

        <section id="tour" className="section tour">
          <div className="container">
            <p className="eyebrow">The tour</p>
            <h2 className="section-title">Seven stops across your archive</h2>
            <FeatureShowcase />
          </div>
        </section>

        <section className="section">
          <div className="container">
            <p className="eyebrow">How it works</p>
            <h2 className="section-title">Three steps to liftoff</h2>
            <ol className="steps">
              {STEPS.map((s, i) => (
                <li key={s.n} className="step arrive" style={{ ["--i" as string]: i }}>
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
              {blogPosts.slice(0, 3).map((p, i) => (
                <Link key={p.slug} to={`/blogs/${p.slug}`} className="card blog-card arrive" style={{ ["--i" as string]: i }}>
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

        <section className="section final-cta arrive">
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

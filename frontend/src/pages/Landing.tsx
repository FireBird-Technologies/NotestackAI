import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import SkyCanvas from "../components/SkyCanvas";
import FeatureShowcase from "../components/FeatureShowcase";
import PricingTiers from "../components/PricingTiers";
import "../styles/showcase.css";
import { PublicFooter, PublicNav } from "../components/PublicChrome";
import { SocialBrandIcon, type SocialBrand } from "../components/SocialBrandIcon";
import AppBanner from "../components/AppBanner";
import { blogPosts } from "@notestack/shared/content/blogPosts";
import { FEATURES, STEPS, type FeatureLabel } from "@notestack/shared/content/marketing";
import { useAuth } from "../hooks/useAuth";
import { SourceUrlHint, useSourceUrlCheck } from "../components/SourceUrlCheck";
import {
  ArrowRightIcon,
  CheckIcon,
  ConstellationIcon,
  EyeIcon,
  HelmetIcon,
  LaunchWindowIcon,
  LaunchpadIcon,
  OrbitIcon,
  RocketIcon,
  SignalIcon,
  TelescopeIcon,
} from "../components/icons/Icons";

export const PENDING_SOURCE_KEY = "ns_pending_source";
// Bump after re-rendering public/demo.mp4 so browsers and the CDN fetch the new file.
const DEMO_VERSION = 5;

/** Each feature's icon, by its label in the shared copy. */
const FEATURE_ICONS: Record<FeatureLabel, typeof TelescopeIcon> = {
  "Research chat": TelescopeIcon,
  "Mind Constellation": ConstellationIcon,
  "Audio overview": SignalIcon,
  Video: LaunchWindowIcon,
  "Launch Kit": RocketIcon,
  Voices: HelmetIcon,
  Memory: OrbitIcon,
  Launchpad: LaunchpadIcon,
};

const LAUNCH_CHANNELS: { brand: SocialBrand; label: string }[] = [
  { brand: "x", label: "X" },
  { brand: "facebook", label: "Facebook" },
  { brand: "instagram", label: "Instagram" },
  { brand: "threads", label: "Threads" },
  { brand: "linkedin", label: "LinkedIn" },
];

const LAUNCH_STEPS = [
  { label: "Create campaign", body: "Turn one source into posts tailored for every connected channel.", icon: RocketIcon },
  { label: "Edit and preview", body: "Polish the copy, check character counts and attach media before it goes out.", icon: EyeIcon },
  { label: "Schedule and measure", body: "Plan the calendar, publish automatically or get a reminder, then track clicks.", icon: LaunchpadIcon },
] as const;

/** A product-like preview of the Launchpad, kept concrete so visitors can see both what they can make and where it goes. */
function LaunchArea({ signedIn }: { signedIn: boolean }) {
  const [activeStep, setActiveStep] = useState(0);
  const selectedStep = LAUNCH_STEPS[activeStep];
  return (
    <section id="launch" className="section landing-launch">
      <div className="container">
        <div className="landing-launch-heading arrive">
          <div>
            <p className="eyebrow">Launch from Notestack</p>
            <h2 className="section-title">Turn one idea into a full campaign.</h2>
          </div>
          <p className="muted">
            Start with one post. Create platform-ready posts, then choose where and when each one goes out.
          </p>
        </div>

        <div className="landing-launch-layout">
          <div className="card launch-console arrive" style={{ ["--i" as string]: 0 }}>
            <header className="launch-console-bar">
              <span className="launch-console-brand"><LaunchpadIcon size={19} /> Launchpad</span>
              <span className="mono launch-console-status"><i /> 5 channels ready</span>
            </header>

            <div className="launch-console-body">
              <aside className="launch-source">
                <span className="mono muted">SOURCE POST</span>
                <div className="launch-source-thumb" aria-hidden="true">
                  <span /><span /><span />
                </div>
                <strong>Why price is a signal</strong>
                <p className="muted">Every draft stays grounded in the claims from your original post.</p>
                <span className="launch-grounded"><CheckIcon size={14} /> Source checked</span>
              </aside>

              <div className="launch-output-panel">
                <div className="launch-output-head">
                  <div>
                    <span className="mono muted">PUBLISH TO</span>
                    <h3>Choose one or more</h3>
                  </div>
                  <span className="launch-ready-pill">1 selected</span>
                </div>
                <div className="lp-channel-picker landing-channel-picker" role="list" aria-label="Publishing channels">
                  {LAUNCH_CHANNELS.map(({ brand, label }) => (
                    <div key={brand} role="listitem" className={`lp-channel-button connected${brand === "linkedin" ? " on" : ""}`}>
                      <span className={`lp-channel-icon brand-${brand}`}>
                        <SocialBrandIcon brand={brand} size={23} />
                        <i className="lp-channel-live" aria-hidden="true" />
                      </span>
                      <span className="lp-channel-name">{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <footer className="launch-console-footer">
              <div className="launch-benefits" aria-label="Launchpad publishing features">
                <span><CheckIcon size={14} /> Schedule ahead</span>
                <span><CheckIcon size={14} /> Auto publish</span>
                <span><CheckIcon size={14} /> Track links</span>
              </div>
              <span className="mono muted">One calendar · five channels</span>
            </footer>
          </div>

          <aside className="card launch-actions arrive" style={{ ["--i" as string]: 1 }}>
            <div className="launch-actions-brand">
              <LaunchpadIcon />
              <strong>Launch workflow</strong>
            </div>
            <nav className="launch-action-nav" aria-label="Launch workflow">
              {LAUNCH_STEPS.map(({ label, icon: Icon }, i) => (
                <button key={label} type="button" className={`launch-action${activeStep === i ? " active" : ""}`}
                        aria-pressed={activeStep === i} onClick={() => setActiveStep(i)}>
                  <Icon />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
            <div className="launch-action-detail" aria-live="polite">
              <span className="mono muted">STEP {String(activeStep + 1).padStart(2, "0")}</span>
              <strong>{selectedStep.label}</strong>
              <p className="muted">{selectedStep.body}</p>
            </div>
            <Link to={signedIn ? "/app/launchpad" : "/auth?mode=signup"} className="btn btn-primary launch-cta">
              {signedIn ? "Open Launchpad" : "Build your first launch"}
              <ArrowRightIcon size={18} />
            </Link>
          </aside>
        </div>
      </div>
    </section>
  );
}

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
        <span>Mission log · 00:46</span>
        <button type="button" className="demo-sound" onClick={toggle} aria-pressed={!muted}>
          {muted ? "Play with sound" : "Mute"}
        </button>
      </div>
      <div className="demo-stage">
        <video
          ref={ref}
          className="demo-video"
          src={`/demo.mp4?v=${DEMO_VERSION}`}
          poster={`/demo-poster.jpg?v=${DEMO_VERSION}`}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          aria-label="Notestack product demo, narrated: connect any blog, site or markdown, ask your archive, hear an audio overview and launch posts"
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

/** /#pricing, /#features: scroll to that section on arrival and whenever the hash changes (the router does not). */
function useHashScroll() {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    // After this frame's layout, so the section is where it will stay
    const id = requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
    return () => cancelAnimationFrame(id);
  }, [hash]);
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
  useHashScroll();
  const { check, modal } = useSourceUrlCheck();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (url.trim() && !(await check(url))) return;
    // Always go to sign in / sign up. A pasted URL rides along and starts connecting after signup
    // (Welcome picks it up); signed in writers go to /app/start, which connects it and opens All posts.
    const value = url.trim();
    if (value) {
      try {
        sessionStorage.setItem(PENDING_SOURCE_KEY, value);
      } catch {
        /* ignore */
      }
    }
    navigate(user ? "/app/start" : "/auth?mode=signup");
  };

  return (
    <div className="page">
      <SkyCanvas travel />
      <AppBanner />
      <PublicNav connectAi />

      <main>
        <section className="hero">
          <div className="container hero-inner">
            <p className="eyebrow">
              <Link to="/notebooklm-alternative" className="eyebrow-link">
                The ultimate NotebookLM alternative
              </Link>{" "}
              for writers, bloggers and newsletters
            </p>
            <h1 className="hero-title">
              Your knowledge,
              <br />
              <span className="glow-text shimmer">in orbit.</span>
            </h1>
            <p className="hero-sub muted">
              Notestack turns your blog, newsletter, site or markdown files into a research notebook you can question,
              podcasts you can publish and launch kits for every platform. Every word traced back to what you actually wrote.
            </p>
            <form className="hero-form" onSubmit={onSubmit}>
              <label htmlFor="hero-url" className="sr-only">
                Your blog, newsletter or site URL
              </label>
              <input
                id="hero-url"
                className="input"
                placeholder="yourblog.com or yourname.substack.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoComplete="url"
                inputMode="url"
              />
              <button type="submit" className="btn btn-primary">
                Start Exploring
                <ArrowRightIcon size={18} />
              </button>
            </form>
            <SourceUrlHint url={url} />
            {modal}
            <p className="mono hero-meta">
              Works with Substack, Ghost, WordPress, Medium, any RSS feed or site, and markdown files.{" "}
              <Link to="/auth?mode=signup">Upload files instead</Link>
            </p>
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

        <LaunchArea signedIn={Boolean(user)} />

        <section id="features" className="section">
          <div className="container">
            <p className="eyebrow">What you get</p>
            <h2 className="section-title">Everything your writing can become</h2>
            <div className="feature-grid">
              {FEATURES.map(({ label, title, body }, i) => {
                const Icon = FEATURE_ICONS[label];
                return (
                <article key={label} className="card feature arrive" style={{ ["--i" as string]: i % 3 }}>
                  <div className="feature-label">
                    <Icon />
                    <span className="mono">{label}</span>
                  </div>
                  <h3>{title}</h3>
                  <p className="muted">{body}</p>
                </article>
                );
              })}
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

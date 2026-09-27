import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import SkyCanvas from "../components/SkyCanvas";
import { PublicFooter, PublicNav } from "../components/PublicChrome";
import { blogPosts, getPost } from "../content/blogPosts";
import type { BlogPost, Mission } from "../content/seoTypes";
import "../styles/blog.css";

function useMeta(title: string, description: string, canonical?: string) {
  useEffect(() => {
    document.title = title;
    const set = (selector: string, attr: string, value: string, create: () => HTMLElement) => {
      let el = document.head.querySelector(selector) as HTMLElement | null;
      if (!el) {
        el = create();
        document.head.appendChild(el);
      }
      el.setAttribute(attr, value);
    };
    set('meta[name="description"]', "content", description, () => {
      const m = document.createElement("meta");
      m.setAttribute("name", "description");
      return m;
    });
    set('link[rel="canonical"]', "href", `${window.location.origin}${canonical ?? window.location.pathname}`, () => {
      const l = document.createElement("link");
      l.setAttribute("rel", "canonical");
      return l;
    });
  }, [title, description, canonical]);
}

const fmtDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/** Posts are numbered as missions in publishing order: the oldest post is Mission 01. */
const missionNumber = (post: BlogPost) => {
  const ordered = [...blogPosts].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  return String(ordered.findIndex((p) => p.slug === post.slug) + 1).padStart(2, "0");
};

const missionOf = (post: BlogPost): Mission =>
  post.mission ?? { question: post.title.endsWith("?") ? post.title : `${post.heroTitle}?`, answer: post.description };

const INLINE = /(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)/g;

/** Inline [text](url) links and **bold** inside post copy. External links open in a new tab and stay followed. */
function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, link, bold] = m;
    if (link) {
      const label = link.slice(1, link.indexOf("]("));
      const href = link.slice(link.indexOf("](") + 2, -1);
      out.push(
        href.startsWith("/") ? (
          <Link key={i++} to={href}>
            {label}
          </Link>
        ) : (
          <a key={i++} href={href} target="_blank" rel="noopener">
            {label}
          </a>
        ),
      );
    } else if (bold) {
      out.push(<strong key={i++}>{bold.slice(2, -2)}</strong>);
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

const plain = (text: string) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");

export function Blog() {
  useMeta("Blog | Notestack", "Field notes on research, deep writing and turning your archive into audio, video and launches.");
  const posts = [...blogPosts].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return (
    <div className="page">
      <SkyCanvas intensity={0.7} travel />
      <PublicNav />
      <main className="container blog-index">
        <p className="eyebrow">Mission log</p>
        <h1 className="section-title">Every post is a search for an answer</h1>
        <p className="muted blog-lede">
          Pick a question. Each mission follows it through a few waypoints until the answer comes into view: research, deep writing,
          audio, video and distribution.
        </p>
        <ol className="mission-grid">
          {posts.map((p) => {
            const m = missionOf(p);
            return (
              <li key={p.slug}>
                <Link to={`/blogs/${p.slug}`} className="card mission-card">
                  <span className="mission-meta mono">
                    <span className="mission-no">Mission {missionNumber(p)}</span>
                    <span>{p.category}</span>
                  </span>
                  <span className="mission-q">{m.question}</span>
                  <h2 className="blog-card-title">{p.title}</h2>
                  <span className="mission-foot mono muted">
                    {p.sections.length} waypoints · {p.readTime}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </main>
      <PublicFooter />
    </div>
  );
}

/** Tracks which waypoint the reader is at and how far along the flight path they are. */
function useFlight(count: number) {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const pathRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [reached, setReached] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.idx);
          if (e.isIntersecting) {
            setActive(idx);
            setReached((r) => (r.has(idx) ? r : new Set(r).add(idx)));
          }
        }
      },
      { rootMargin: "-35% 0px -55% 0px" },
    );
    refs.current.forEach((el) => el && io.observe(el));
    const onScroll = () => {
      const el = pathRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const total = rect.height - window.innerHeight * 0.4;
      setProgress(Math.max(0, Math.min(1, (window.innerHeight * 0.45 - rect.top) / Math.max(total, 1))));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, [count]);

  return { refs, pathRef, active, reached, progress };
}

export function BlogPostPage() {
  const { slug = "" } = useParams();
  const post = getPost(slug);
  useMeta(post ? `${post.title} | Notestack` : "Not found | Notestack", post?.description ?? "", post?.canonicalPath);
  const flight = useFlight(post?.sections.length ?? 0);

  if (!post) {
    return (
      <div className="page">
        <SkyCanvas intensity={0.5} />
        <PublicNav />
        <main className="container empty-state">
          <h1>Lost in space</h1>
          <p className="muted">That post drifted out of range.</p>
          <Link to="/blogs" className="btn">
            Back to the mission log
          </Link>
        </main>
      </div>
    );
  }

  const mission = missionOf(post);
  const number = missionNumber(post);
  const related = post.relatedPaths
    .map((path) => blogPosts.find((p) => `/blogs/${p.slug}` === path))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.publishedAt,
    keywords: [post.primaryKeyword, post.keywordVariant].join(", "),
    author: { "@type": "Organization", name: "Notestack" },
  };
  const faqLd = post.faq.length
    ? {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: post.faq.map((f) => ({
          "@type": "Question",
          name: f.question,
          acceptedAnswer: { "@type": "Answer", text: plain(f.answer) },
        })),
      }
    : null;

  const goTo = (i: number) => flight.refs.current[i]?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="page">
      <SkyCanvas intensity={0.6} travel />
      <PublicNav />
      <main className="container post mission">
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
        {faqLd && <script type="application/ld+json">{JSON.stringify(faqLd)}</script>}
        <Link to="/blogs" className="mono muted post-back">
          Mission log / {post.category}
        </Link>

        <header className="mission-head">
          <p className="eyebrow">
            Mission {number} · {post.heroEyebrow}
          </p>
          <div className="transmission incoming">
            <span className="mono tx-label">Incoming query</span>
            <p className="tx-query">{mission.question}</p>
          </div>
          <h1 className="post-title">{post.title}</h1>
          <p className="post-lede muted">{post.heroDescription}</p>
          <p className="mono muted small">
            {fmtDate(post.publishedAt)} · {post.readTime} · {post.sections.length} waypoints
          </p>
          <div className="answer-box">
            <span className="mono tx-label">Short answer</span>
            <p>
              <Inline text={mission.answer} />
            </p>
          </div>
          {post.heroImage && <img src={post.heroImage} alt={post.heroImageAlt ?? ""} className="post-hero" />}
        </header>

        <div className="flight">
          <nav className="flight-map" aria-label="Waypoints">
            <p className="mono tx-label">Flight plan</p>
            <ol>
              {post.sections.map((s, i) => (
                <li key={s.heading} className={`${flight.active === i ? "on" : ""}${flight.reached.has(i) ? " done" : ""}`}>
                  <button type="button" onClick={() => goTo(i)}>
                    <span className="mono">{String(i + 1).padStart(2, "0")}</span>
                    {s.heading}
                  </button>
                </li>
              ))}
              <li className={flight.progress > 0.97 ? "on done" : ""}>
                <button type="button" onClick={() => document.getElementById("destination")?.scrollIntoView({ behavior: "smooth" })}>
                  <span className="mono">*</span>
                  Answer found
                </button>
              </li>
            </ol>
          </nav>

          <article className="post-body flight-path" ref={flight.pathRef}>
            <div className="path-line" aria-hidden="true">
              <div className="path-fill" style={{ height: `${flight.progress * 100}%` }} />
              <div className="path-ship" style={{ top: `${flight.progress * 100}%` }} />
            </div>

            {post.sections.map((s, i) => (
              <section
                key={s.heading}
                data-idx={i}
                ref={(el) => (flight.refs.current[i] = el)}
                className={`waypoint${flight.reached.has(i) ? " reached" : ""}`}
              >
                <span className="waypoint-node" aria-hidden="true" />
                <p className="mono waypoint-label">Waypoint {String(i + 1).padStart(2, "0")}</p>
                <h2>{s.heading}</h2>
                {s.paragraphs.map((para, j) => (
                  <p key={j}>
                    <Inline text={para} />
                  </p>
                ))}
                {s.bullets && (
                  <ul>
                    {s.bullets.map((b) => (
                      <li key={b}>
                        <Inline text={b} />
                      </li>
                    ))}
                  </ul>
                )}
                {s.callout && (
                  <blockquote className="transmission">
                    <span className="mono tx-label">Transmission</span>
                    <Inline text={s.callout} />
                  </blockquote>
                )}
              </section>
            ))}

            <section id="destination" className="waypoint destination">
              <span className="waypoint-node" aria-hidden="true" />
              <p className="mono waypoint-label">Destination</p>
              <h2>Answer found</h2>
              <div className="answer-box final">
                <span className="mono tx-label">{mission.question}</span>
                <p>
                  <Inline text={mission.answer} />
                </p>
              </div>
            </section>

            {post.faq.length > 0 && (
              <section className="debrief">
                <p className="mono waypoint-label">Mission debrief</p>
                <h2>Questions from other travellers</h2>
                {post.faq.map((f) => (
                  <details key={f.question} className="faq">
                    <summary>{f.question}</summary>
                    <p className="muted">
                      <Inline text={f.answer} />
                    </p>
                  </details>
                ))}
              </section>
            )}
          </article>
        </div>

        <aside className="card post-cta">
          <h3>Put your knowledge in orbit</h3>
          <p className="muted">Connect any blog, newsletter or site, or upload markdown, and get grounded answers, audio and launch kits.</p>
          <Link to="/auth?mode=signup" className="btn btn-primary">
            Start free
          </Link>
        </aside>

        {related.length > 0 && (
          <section className="post-related">
            <p className="eyebrow">Next missions</p>
            <div className="blog-grid">
              {related.map((p) => (
                <Fragment key={p.slug}>
                  <Link to={`/blogs/${p.slug}`} className="card blog-card">
                    <span className="mono mission-no">Mission {missionNumber(p)}</span>
                    <h3>{p.title}</h3>
                    <p className="muted">{missionOf(p).question}</p>
                  </Link>
                </Fragment>
              ))}
            </div>
          </section>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}

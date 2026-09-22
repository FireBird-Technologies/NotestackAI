import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import SkyCanvas from "../components/SkyCanvas";
import { PublicFooter, PublicNav } from "../components/PublicChrome";
import { blogPosts, getPost } from "../content/blogPosts";

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

export function Blog() {
  useMeta("Blog | Notestack", "Field notes on turning your writing into research, audio, video and launches.");
  return (
    <div className="page">
      <SkyCanvas intensity={0.6} />
      <PublicNav />
      <main className="container blog-index">
        <p className="eyebrow">Blog</p>
        <h1 className="section-title">Field notes</h1>
        <p className="muted blog-lede">
          Guides for writers who want their archive to work harder: research, audio, video and distribution.
        </p>
        <div className="blog-grid">
          {blogPosts.map((p) => (
            <Link key={p.slug} to={`/blogs/${p.slug}`} className="card blog-card">
              {p.heroImage && <img src={p.heroImage} alt={p.heroImageAlt ?? ""} className="blog-cover" loading="lazy" />}
              <span className="mono muted">
                {p.category} · {fmtDate(p.publishedAt)} · {p.readTime}
              </span>
              <h2 className="blog-card-title">{p.title}</h2>
              <p className="muted">{p.description}</p>
            </Link>
          ))}
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}

export function BlogPostPage() {
  const { slug = "" } = useParams();
  const post = getPost(slug);
  useMeta(post ? `${post.title} | Notestack` : "Not found | Notestack", post?.description ?? "", post?.canonicalPath);

  if (!post) {
    return (
      <div className="page">
        <SkyCanvas intensity={0.5} />
        <PublicNav />
        <main className="container empty-state">
          <h1>Lost in space</h1>
          <p className="muted">That post drifted out of range.</p>
          <Link to="/blogs" className="btn">
            Back to the blog
          </Link>
        </main>
      </div>
    );
  }

  const related = post.relatedPaths
    .map((path) => blogPosts.find((p) => `/blogs/${p.slug}` === path))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.publishedAt,
    author: { "@type": "Organization", name: "Notestack" },
  };
  const faqLd = post.faq.length
    ? {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: post.faq.map((f) => ({
          "@type": "Question",
          name: f.question,
          acceptedAnswer: { "@type": "Answer", text: f.answer },
        })),
      }
    : null;

  return (
    <div className="page">
      <SkyCanvas intensity={0.5} />
      <PublicNav />
      <main className="container post">
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
        {faqLd && <script type="application/ld+json">{JSON.stringify(faqLd)}</script>}
        <Link to="/blogs" className="mono muted post-back">
          Blog / {post.category}
        </Link>
        <p className="eyebrow">{post.heroEyebrow}</p>
        <h1 className="post-title">{post.heroTitle}</h1>
        <p className="post-lede muted">{post.heroDescription}</p>
        <p className="mono muted">
          {fmtDate(post.publishedAt)} · {post.readTime}
        </p>
        {post.heroImage && <img src={post.heroImage} alt={post.heroImageAlt ?? ""} className="post-hero" />}

        <article className="post-body">
          {post.sections.map((s) => (
            <section key={s.heading}>
              <h2>{s.heading}</h2>
              {s.paragraphs.map((para, i) => (
                <p key={i}>{para}</p>
              ))}
              {s.bullets && (
                <ul>
                  {s.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              {s.callout && <blockquote>{s.callout}</blockquote>}
            </section>
          ))}

          {post.faq.length > 0 && (
            <section>
              <h2>Questions</h2>
              {post.faq.map((f) => (
                <details key={f.question} className="faq">
                  <summary>{f.question}</summary>
                  <p className="muted">{f.answer}</p>
                </details>
              ))}
            </section>
          )}
        </article>

        <aside className="card post-cta">
          <h3>Put your archive in orbit</h3>
          <p className="muted">Paste your Substack URL and get grounded answers, audio and launch kits.</p>
          <Link to="/auth?mode=signup" className="btn btn-primary">
            Start free
          </Link>
        </aside>

        {related.length > 0 && (
          <section className="post-related">
            <p className="eyebrow">Keep reading</p>
            <div className="blog-grid">
              {related.map((p) => (
                <Link key={p.slug} to={`/blogs/${p.slug}`} className="card blog-card">
                  <h3>{p.title}</h3>
                  <p className="muted">{p.description}</p>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}

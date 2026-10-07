import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { blogPosts } from "../content/blogPosts";
import { tools } from "../content/tools";
import Logo from "./Logo";

export function PublicNav() {
  const { user } = useAuth();
  return (
    <header className="nav">
      <div className="container nav-inner">
        <Link to="/" className="nav-brand" aria-label="Notestack home">
          <Logo />
        </Link>
        <nav className="nav-links" aria-label="Main">
          <NavLink to="/#features">Features</NavLink>
          <NavLink to="/pricing">Pricing</NavLink>
          <NavLink to="/tools">Free tools</NavLink>
          <NavLink to="/blogs">Blog</NavLink>
        </nav>
        {user ? (
          <Link to="/app" className="btn btn-primary nav-cta">
            Mission Control
          </Link>
        ) : (
          <div className="nav-auth">
            <Link to="/auth" className="nav-signin">
              Sign in
            </Link>
            <Link to="/auth?mode=signup" className="btn btn-primary nav-cta">
              Start free
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div className="footer-brand">
          <Logo />
          <p className="muted">Your knowledge, in orbit.</p>
        </div>
        <div className="footer-cols">
          <div>
            <p className="eyebrow">Product</p>
            <Link to="/#features">Features</Link>
            <Link to="/notebooklm-alternative">NotebookLM alternative</Link>
            <Link to="/pricing">Pricing</Link>
            <Link to="/blogs">Blog</Link>
            <Link to="/auth">Sign in</Link>
          </div>
          <div>
            <p className="eyebrow">Free tools</p>
            {tools.map((t) => (
              <Link key={t.slug} to={`/tools/${t.slug}`}>
                {t.eyebrow}
              </Link>
            ))}
          </div>
          <div>
            <p className="eyebrow">From the blog</p>
            {blogPosts.slice(0, 3).map((p) => (
              <Link key={p.slug} to={`/blogs/${p.slug}`}>
                {p.title.split(":")[0]}
              </Link>
            ))}
          </div>
          <div>
            <p className="eyebrow">More from Firebird</p>
            <a href="https://blog2video.app" target="_blank" rel="noopener" title="Turn blogs, URLs and PDFs into videos">
              Blog2Video: blog to video
            </a>
            <a href="https://pdf2vid.com" target="_blank" rel="noopener" title="Turn any PDF into a narrated video">
              PDF2Video: PDF to video
            </a>
            <a href="https://bloghub.app" target="_blank" rel="noopener" title="Free blog and newsletter directory">
              BlogHub: blog directory
            </a>
          </div>
          <div>
            <p className="eyebrow">Company</p>
            <a href="mailto:hello@notestack.ai">Contact</a>
          </div>
        </div>
      </div>
      <div className="container footer-base mono">
        <span>&copy; {new Date().getFullYear()} Firebird Technologies</span>
        <span>Made under a dark sky</span>
      </div>
    </footer>
  );
}

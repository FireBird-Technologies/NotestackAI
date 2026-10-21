import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { blogPosts } from "../content/blogPosts";
import { tools } from "../content/tools";
import { MenuIcon } from "./icons/Icons";
import Logo from "./Logo";
import MenuSheet from "./MenuSheet";

const NAV_LINKS = [
  { to: "/#features", label: "Features" },
  { to: "/#pricing", label: "Pricing" },
  { to: "/tools", label: "Free tools" },
  { to: "/blogs", label: "Blog" },
];

/** Features is a hash on the home page, so it only counts as active when that hash is in the URL. */
function isLinkActive(to: string, pathname: string, hash: string) {
  const [path, anchor] = to.split("#");
  if (anchor) return pathname === path && hash === `#${anchor}`;
  return pathname === path || pathname.startsWith(`${path}/`);
}

function MobileMenu({ signedIn, onClose }: { signedIn: boolean; onClose: () => void }) {
  const { pathname, hash } = useLocation();
  return (
    <MenuSheet id="nav-menu" className="nav-menu-backdrop" onClose={onClose}>
      <nav className="nav-menu-links" aria-label="Main">
        {NAV_LINKS.map((l) => {
          const active = isLinkActive(l.to, pathname, hash);
          return (
            <Link
              key={l.to}
              to={l.to}
              className={active ? "active" : undefined}
              aria-current={active ? "page" : undefined}
              onClick={onClose}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
      {!signedIn && (
        <Link to="/auth" className="btn nav-menu-signin" onClick={onClose}>
          Sign in
        </Link>
      )}
    </MenuSheet>
  );
}

export function PublicNav() {
  const { user } = useAuth();
  const { pathname, hash } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);

  // Navigating anywhere (including the browser back button) closes the menu.
  useEffect(() => setMenuOpen(false), [pathname, hash]);

  const toggle = (
    <button
      type="button"
      className="nav-toggle"
      onClick={() => setMenuOpen(true)}
      aria-label="Open menu"
      aria-expanded={menuOpen}
      aria-controls="nav-menu"
    >
      <MenuIcon size={22} />
    </button>
  );

  return (
    <header className="nav">
      <div className="container nav-inner">
        <Link to={user ? "/app/notebooks" : "/"} className="nav-brand" aria-label={user ? "Your notebooks" : "Notestack home"}>
          <Logo />
        </Link>
        <nav className="nav-links" aria-label="Main">
          {NAV_LINKS.map((l) => (
            <NavLink key={l.to} to={l.to}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        {user ? (
          <div className="nav-auth">
            {toggle}
            <Link to="/app/notebooks" className="btn btn-primary nav-cta">
              Your notebooks
            </Link>
          </div>
        ) : (
          <div className="nav-auth">
            {toggle}
            <Link to="/auth" className="nav-signin">
              Sign in
            </Link>
            <Link to="/auth?mode=signup" className="btn btn-primary nav-cta">
              Start free
            </Link>
          </div>
        )}
      </div>
      {menuOpen && <MobileMenu signedIn={!!user} onClose={closeMenu} />}
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
            <Link to="/#pricing">Pricing</Link>
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
            <Link to="/support">Support</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
            <a href="mailto:arslan@firebird-technologies.com">Contact</a>
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

import { useEffect, useState, type CSSProperties } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { blogPosts } from "@notestack/shared/content/blogPosts";
import { tools } from "@notestack/shared/content/tools";
import { MenuIcon } from "./icons/Icons";
import { ConnectorSetup } from "./ConnectorModal";
import Logo from "./Logo";
import MenuSheet from "./MenuSheet";
import { Modal, Tabs } from "./ui";

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

const CONNECT_AI_DESTINATION = "/app/connector?tab=apps";
const EXTERNAL_TOOLS_DESTINATION = "/app/connector?tab=tools";
const EXTERNAL_APPS = [
  { name: "Notion", logo: "notion" },
  { name: "Canva", logo: "canva" },
  { name: "Gmail", logo: "gmail" },
  { name: "Slack", logo: "slack" },
  { name: "Google Drive", logo: "googledrive" },
  { name: "Outlook", logo: "outlook" },
  { name: "Google Calendar", logo: "googlecalendar" },
  { name: "Google Docs", logo: "googledocs" },
  { name: "Google Sheets", logo: "googlesheets" },
  { name: "GitHub", logo: "github" },
  { name: "Linear", logo: "linear" },
  { name: "HubSpot", logo: "hubspot" },
  { name: "Airtable", logo: "airtable" },
  { name: "Jira", logo: "jira" },
  { name: "Figma", logo: "figma" },
  { name: "Microsoft Teams", logo: "microsoft_teams" },
  { name: "OneDrive", logo: "one_drive" },
  { name: "Trello", logo: "trello" },
] as const;
const FEATURED_EXTERNAL_APPS = EXTERNAL_APPS.slice(0, 12);

function AppOrbitRing({ apps, ring }: {
  apps: readonly (typeof EXTERNAL_APPS)[number][];
  ring: "outer" | "inner";
}) {
  return (
    <div className={`public-orbit-ring ${ring}`}>
      {apps.map((app, index) => {
        const angle = -90 + (360 / apps.length) * index;
        return (
          <div
            className="public-orbit-app"
            style={{
              "--orbit-angle": `${angle}deg`,
              "--orbit-counter-angle": `${-angle}deg`,
            } as CSSProperties}
            key={app.name}
            role="listitem"
            aria-label={app.name}
          >
            <span className="public-external-icon" data-label={app.name} aria-hidden="true">
              <img src={`https://logos.composio.dev/api/${app.logo}`} alt="" />
            </span>
          </div>
        );
      })}
    </div>
  );
}

function MobileMenu({ signedIn, onClose, onConnectAi }: {
  signedIn: boolean;
  onClose: () => void;
  onConnectAi?: () => void;
}) {
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
      {onConnectAi && (
        <button type="button" className="btn nav-menu-connect" onClick={onConnectAi}>
          Connect with AI
        </button>
      )}
      {!signedIn && (
        <Link to="/auth" className="btn nav-menu-signin" onClick={onClose}>
          Sign in
        </Link>
      )}
    </MenuSheet>
  );
}

function ConnectAiModal({ signedIn, onClose }: { signedIn: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"ai" | "tools">("ai");
  const destination = tab === "ai" ? CONNECT_AI_DESTINATION : EXTERNAL_TOOLS_DESTINATION;
  const signin = `/auth?${new URLSearchParams({ next: destination })}`;
  const action = signedIn ? destination : signin;
  return (
    <Modal title="Connect with Notestack" onClose={onClose} wide>
      <Tabs
        label="Connection type"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "ai", label: "Use Notestack in Claude or ChatGPT" },
          { id: "tools", label: "External tools" },
        ]}
      />
      {tab === "ai" ? (
        <ConnectorSetup compact />
      ) : (
        <div className="public-external-tools">
          <div className="public-external-heading">
            <div>
              <span className="connector-section-kicker mono">POPULAR CONNECTIONS</span>
              <h3>Bring your work into Notestack</h3>
            </div>
            <p className="muted small">
              Let Notestack research across your notes, email, files and team conversations. You choose each app and
              exactly which tools it may use.
            </p>
          </div>
          <div className="public-app-orbit" role="list" aria-label="Available external apps">
            <div className="public-orbit-system">
              <svg className="public-orbit-constellation" viewBox="0 0 390 390" aria-hidden="true">
                <g className="public-constellation-track outer">
                  <circle className="public-constellation-orbit" cx="195" cy="195" r="170" />
                  {[[195, 25], [328, 89], [361, 233], [269, 348], [121, 348], [29, 233], [62, 89]]
                    .map(([cx, cy]) => <circle className="public-constellation-node" cx={cx} cy={cy} r="3" key={`${cx}-${cy}`} />)}
                </g>
                <g className="public-constellation-track inner">
                  <circle className="public-constellation-orbit" cx="195" cy="195" r="100" />
                  {[[195, 95], [282, 245], [108, 245]]
                    .map(([cx, cy]) => <circle className="public-constellation-node" cx={cx} cy={cy} r="3" key={`${cx}-${cy}`} />)}
                </g>
              </svg>
              <AppOrbitRing apps={FEATURED_EXTERNAL_APPS.slice(0, 7)} ring="outer" />
              <AppOrbitRing apps={FEATURED_EXTERNAL_APPS.slice(7, 10)} ring="inner" />
              <div className="public-orbit-hub">
                <Logo size={42} withWordmark={false} />
                <strong>Notestack</strong>
              </div>
            </div>
          </div>
          <div className="public-external-more">
            <strong>More connections available</strong>
            <span className="muted small">Search the full app catalog after signing in</span>
          </div>
        </div>
      )}
      {tab === "tools" ? (
        <div className="public-connect-footer">
          <Link to={action} className="btn btn-primary" onClick={onClose}>
            {signedIn ? "Open external tools" : "Sign in to connect"}
          </Link>
        </div>
      ) : null}
    </Modal>
  );
}

export function PublicNav({ connectAi = false }: { connectAi?: boolean }) {
  const { user } = useAuth();
  const { pathname, hash } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  const openConnect = () => {
    setMenuOpen(false);
    setConnectOpen(true);
  };

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
            {connectAi && <button type="button" className="btn nav-connect-ai" onClick={openConnect}>Connect with AI</button>}
            <Link to="/app/notebooks" className="btn btn-primary nav-cta">
              Your notebooks
            </Link>
          </div>
        ) : (
          <div className="nav-auth">
            {toggle}
            {connectAi && <button type="button" className="btn nav-connect-ai" onClick={openConnect}>Connect with AI</button>}
            <Link to="/auth" className="nav-signin">
              Sign in
            </Link>
            <Link to="/auth?mode=signup" className="btn btn-primary nav-cta">
              Start free
            </Link>
          </div>
        )}
      </div>
      {menuOpen && <MobileMenu signedIn={!!user} onClose={closeMenu} onConnectAi={connectAi ? openConnect : undefined} />}
      {connectOpen && <ConnectAiModal signedIn={!!user} onClose={() => setConnectOpen(false)} />}
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

import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, Navigate, useLocation, useOutletContext } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { UpgradeProvider } from "../hooks/useUpgrade";
import Logo from "./Logo";
import { useMedia } from "./PaneResizer";
import { FuelGauge, NudgeDock } from "./Nudges";
import SkyCanvas from "./SkyCanvas";
import UpgradeModal from "./UpgradeModal";
import {
  ConnectorIcon,
  LaunchpadIcon,
  LibraryIcon,
  MicIcon,
  PanelMenuIcon,
  GearIcon,
  PlanetIcon,
  SatelliteDishIcon,
} from "./icons/Icons";

// Keep the primary navigation focused; related pages remain reachable through these destinations.
const NAV: { to: string; label: string; icon: typeof PlanetIcon; end?: boolean; also?: string[] }[] = [
  { to: "/app/notebooks", label: "Notebooks", icon: PlanetIcon },
  { to: "/app/sources", label: "Sources", icon: SatelliteDishIcon, also: ["/app/map"] },
  { to: "/app/archive", label: "Library", icon: LibraryIcon, also: ["/app/videos"] },
  { to: "/app/launchpad", label: "Launchpad", icon: LaunchpadIcon, also: ["/app/resurface", "/app/launch-kit"] },
  { to: "/app/voices", label: "Manage voices", icon: MicIcon },
];

const COLLAPSED_KEY = "ns_sidebar_collapsed";

type ShellContext = { setCrumb: (name: string | null) => void };

/** Phones: a page names what is open after the tab in the top bar ("Notebooks / Resume"), until it unmounts. */
export function useTopbarCrumb(name: string | null | undefined) {
  const { setCrumb } = useOutletContext<ShellContext>();
  useEffect(() => {
    setCrumb(name ?? null);
    return () => setCrumb(null);
  }, [name, setCrumb]);
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export default function AppShell() {
  const { user, loading, signingOut, logout } = useAuth();
  const location = useLocation();
  const notebookFocus = /^\/app\/notebooks\/[^/]+$/.test(location.pathname);
  const [collapsedPref, setCollapsed] = useState(readCollapsed);
  // Phones: the whole sidebar is a drawer from the left, opened from the top bar's menu button
  const phone = useMedia("(max-width: 899px)");
  const collapsed = collapsedPref && !phone; // the drawer always shows everything
  const [menuOpen, setMenuOpen] = useState(false);
  const [crumb, setCrumb] = useState<string | null>(null);
  // Navigating anywhere (including the browser back button) closes the drawer; so does growing past phone size.
  useEffect(() => setMenuOpen(false), [location.pathname, phone]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        /* private mode: remember for this visit only */
      }
      return !c;
    });
  if (loading) return <div className="boot"><div className="orbit-loader"><span /></div></div>;
  if (!user) return <Navigate to="/" replace />;

  const isActive = (to: string, also?: string[]) =>
    location.pathname === to || location.pathname.startsWith(`${to}/`) || !!also?.some((p) => location.pathname.startsWith(p));
  // The phone top bar names the tab you are on
  const current = [...NAV, { to: "/app/connector", label: "Connector" }, { to: "/app/settings", label: "Settings" }]
    .find((n) => isActive(n.to, "also" in n ? n.also : undefined));

  return (
    <UpgradeProvider>
      {/* A notebook hides the app sidebar, so it never takes the collapsed sidebar's column */}
      <div className={`shell${collapsed && !notebookFocus ? " collapsed" : ""}${notebookFocus ? " notebook-focus" : ""}`}>
        <SkyCanvas intensity={0.35} />
        {/* Phones: the menu button and the tab you are on */}
        <header className="app-topbar">
          <button type="button" className="app-topbar-menu" onClick={() => setMenuOpen(true)} aria-label="Open menu"
                  aria-expanded={menuOpen} aria-controls="app-sidebar">
            <PanelMenuIcon size={22} strokeWidth={1.8} />
          </button>
          <Link to="/app/notebooks" className="app-topbar-logo" aria-label="Notestack home">
            <Logo size={26} withWordmark={false} />
          </Link>
          <span className="app-topbar-title">
            {crumb && current ? <Link to={current.to}>{current.label}</Link> : current?.label ?? "Notestack"}
            {crumb && <span className="app-topbar-crumb"> / {crumb}</span>}
          </span>
        </header>
        {menuOpen && <div className="app-drawer-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
        <aside id="app-sidebar" className={`sidebar${menuOpen ? " open" : ""}`}>
          <div className="sidebar-top">
            {collapsed ? (
              <button type="button" className="sidebar-brand sidebar-brand-btn" onClick={toggle} aria-label="Expand sidebar" title="Expand sidebar">
                <Logo size={28} withWordmark={false} />
              </button>
            ) : (
              <NavLink to="/app/notebooks" end className="sidebar-brand" aria-label="Your notebooks">
                <Logo size={28} />
              </NavLink>
            )}
            <button
              type="button"
              className="icon-btn sidebar-toggle"
              onClick={toggle}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
                <path d="M9 4.5v15" />
                <path d={collapsed ? "M13 10l2 2-2 2" : "M15 10l-2 2 2 2"} />
              </svg>
            </button>
            <button type="button" className="app-drawer-close" onClick={() => setMenuOpen(false)} aria-label="Close menu" title="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <nav aria-label="App">
            {NAV.map(({ to, label, icon: Icon, end, also }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                title={collapsed ? label : undefined}
                className={({ isActive }) => `side-link${isActive || also?.some((p) => location.pathname.startsWith(p)) ? " active" : ""}`}
              >
                <Icon />
                <span className="side-label">{label}</span>
              </NavLink>
            ))}
            <NavLink
              to="/app/connector"
              className={({ isActive }) => `side-link connector-side-link${isActive ? " active" : ""}`}
              title={collapsed ? "Connector" : undefined}
            >
              <ConnectorIcon />
              <span className="side-label">Connector</span>
              <span className="connector-side-rotator side-label" aria-hidden="true">
                <span className="connector-side-track">
                  <span className="connector-side-app"><img className="openai" src="/openai.png" alt="" /></span>
                  <span className="connector-side-app"><img src="/anthropic.svg" alt="" /></span>
                  <span className="connector-side-app"><img className="openai" src="/openai.png" alt="" /></span>
                </span>
              </span>
            </NavLink>
          </nav>
          <FuelGauge collapsed={collapsed} />
          <NavLink to="/app/settings" title={collapsed ? "Settings" : undefined} className={({ isActive }) => `side-link side-settings${isActive ? " active" : ""}`}>
            <GearIcon />
            <span className="side-label">Settings</span>
          </NavLink>
          <div className="sidebar-user">
            <span className="mono muted side-label">{user.email}</span>
            <button className="link-btn" onClick={logout} disabled={signingOut} title="Sign out">
              Sign out
            </button>
          </div>
        </aside>
        <main className="shell-main">
          <Outlet context={{ setCrumb } satisfies ShellContext} />
        </main>
      </div>
      {/* Outside .shell: its children get position: relative, and these are fixed overlays. */}
      <NudgeDock />
      <UpgradeModal />
    </UpgradeProvider>
  );
}

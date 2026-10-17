import { useEffect, useState } from "react";
import { NavLink, Outlet, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { UpgradeProvider } from "../hooks/useUpgrade";
import type { User } from "../api/auth";
import Logo from "./Logo";
import { Modal } from "./ui";
import { FuelGauge, NudgeDock } from "./Nudges";
import SkyCanvas from "./SkyCanvas";
import UpgradeModal from "./UpgradeModal";
import {
  ConnectorIcon,
  LaunchpadIcon,
  ChevronIcon,
  LibraryIcon,
  MenuIcon,
  MicIcon,
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

/** Phones: the account, behind the hamburger. Who is signed in, the plan and what is left on it, and Sign out. */
function AccountModal({ user, signingOut, logout, onClose }: {
  user: User; signingOut: boolean; logout: () => void; onClose: () => void;
}) {
  const name = user.name?.trim() || user.email;
  return (
    <Modal title="Account" onClose={onClose}>
      <div className="stack account-modal">
        <div className="app-menu-profile">
          {user.avatar_url ? (
            <img className="app-menu-avatar" src={user.avatar_url} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span className="app-menu-avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
          )}
          <span className="app-menu-who">
            <strong>{name}</strong>
            {user.name?.trim() && <span className="muted small">{user.email}</span>}
          </span>
        </div>
        <FuelGauge collapsed={false} />
        <button type="button" className="btn app-menu-signout" onClick={logout} disabled={signingOut}>
          {signingOut ? "Signing out..." : "Sign out"}
        </button>
      </div>
    </Modal>
  );
}

const COLLAPSED_KEY = "ns_sidebar_collapsed";

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
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [menuOpen, setMenuOpen] = useState(false); // small screens: the other tabs fold away under the current one
  const [accountOpen, setAccountOpen] = useState(false); // small screens: profile, plan and Sign out, behind the hamburger
  // Navigating anywhere (including the browser back button) closes the menu.
  useEffect(() => setMenuOpen(false), [location.pathname]);
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
  // Small screens show only the tab you are on; its chevron unfolds the rest.
  const current = [...NAV, { to: "/app/connector", label: "Connector", icon: ConnectorIcon }, { to: "/app/settings", label: "Settings", icon: GearIcon }]
    .find((n) => isActive(n.to, "also" in n ? n.also : undefined));
  const CurrentIcon = current?.icon;

  return (
    <UpgradeProvider>
      <div className={`shell${collapsed ? " collapsed" : ""}${notebookFocus ? " notebook-focus" : ""}`}>
        <SkyCanvas intensity={0.35} />
        <aside className="sidebar">
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
            <button type="button" className="nav-toggle app-account-btn" onClick={() => setAccountOpen(true)}
                    aria-label="Account" aria-haspopup="dialog">
              <MenuIcon size={22} />
            </button>
          </div>
          <button type="button" className="side-link active app-current" onClick={() => setMenuOpen((o) => !o)}
                  aria-expanded={menuOpen} aria-controls="app-nav">
            {CurrentIcon && <CurrentIcon />}
            <span className="side-label">{current?.label ?? "Menu"}</span>
            <ChevronIcon size={18} className={`icon app-current-chev${menuOpen ? " open" : ""}`} />
          </button>
          <nav id="app-nav" className={menuOpen ? "open" : undefined} aria-label="App">
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
            {/* Phones: Settings is one of the tabs (wide screens pin it to the sidebar's foot) */}
            <NavLink to="/app/settings" className={({ isActive }) => `side-link app-nav-settings${isActive ? " active" : ""}`}>
              <GearIcon />
              <span className="side-label">Settings</span>
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
          <Outlet />
        </main>
      </div>
      {accountOpen && <AccountModal user={user} signingOut={signingOut} logout={logout} onClose={() => setAccountOpen(false)} />}
      {/* Outside .shell: its children get position: relative, and these are fixed overlays. */}
      <NudgeDock />
      <UpgradeModal />
    </UpgradeProvider>
  );
}

import { useState } from "react";
import { NavLink, Outlet, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { UpgradeProvider } from "../hooks/useUpgrade";
import Logo from "./Logo";
import { FuelGauge, NudgeDock } from "./Nudges";
import SkyCanvas from "./SkyCanvas";
import UpgradeModal from "./UpgradeModal";
import {
  LaunchpadIcon,
  LibraryIcon,
  MicIcon,
  OrbitIcon,
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
              <NavLink to="/" className="sidebar-brand">
                <Logo size={28} withWordmark={false} />
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
          </nav>
          <FuelGauge collapsed={collapsed} />
          <NavLink to="/app/settings" title={collapsed ? "Settings" : undefined} className={({ isActive }) => `side-link side-settings${isActive ? " active" : ""}`}>
            <OrbitIcon />
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
      {/* Outside .shell: its children get position: relative, and these are fixed overlays. */}
      <NudgeDock />
      <UpgradeModal />
    </UpgradeProvider>
  );
}

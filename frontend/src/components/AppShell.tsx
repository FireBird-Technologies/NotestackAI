import { useState } from "react";
import { NavLink, Outlet, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import Logo from "./Logo";
import SkyCanvas from "./SkyCanvas";
import {
  AsteroidIcon,
  CometIcon,
  ConstellationIcon,
  HelmetIcon,
  LaunchpadIcon,
  LaunchWindowIcon,
  OrbitIcon,
  PlanetIcon,
  RadarIcon,
  RocketIcon,
  SatelliteDishIcon,
} from "./icons/Icons";

// Theme in the icon, clarity in the label: the plain label always shows.
const NAV = [
  { to: "/app", label: "Mission Control", icon: RadarIcon, end: true },
  { to: "/app/notebooks", label: "Notebooks", icon: PlanetIcon },
  { to: "/app/sources", label: "Sources", icon: SatelliteDishIcon },
  { to: "/app/map", label: "Topic map", icon: ConstellationIcon },
  { to: "/app/voice", label: "Voice profile", icon: HelmetIcon },
  { to: "/app/studio", label: "Video and audio", icon: LaunchWindowIcon },
  { to: "/app/launch-kit", label: "Launch Kit", icon: RocketIcon },
  { to: "/app/launchpad", label: "Launchpad", icon: LaunchpadIcon },
  { to: "/app/archive", label: "Archive", icon: AsteroidIcon },
  { to: "/app/resurface", label: "Resurfacing", icon: CometIcon },
  { to: "/app/settings", label: "Settings", icon: OrbitIcon },
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
  const { user, loading, logout } = useAuth();
  const location = useLocation();
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
  if (!user) {
    const next = new URLSearchParams({ next: location.pathname + location.search });
    return <Navigate to={`/auth?${next}`} replace />;
  }

  return (
    <div className={`shell${collapsed ? " collapsed" : ""}`}>
      <SkyCanvas intensity={0.35} />
      <aside className="sidebar">
        <div className="sidebar-top">
          <NavLink to="/" className="sidebar-brand">
            <Logo size={28} />
          </NavLink>
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
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} title={collapsed ? label : undefined} className={({ isActive }) => `side-link${isActive ? " active" : ""}`}>
              <Icon />
              <span className="side-label">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-user">
          <span className="mono muted side-label">{user.email}</span>
          <button className="link-btn" onClick={logout} title="Sign out">
            Sign out
          </button>
        </div>
      </aside>
      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  );
}

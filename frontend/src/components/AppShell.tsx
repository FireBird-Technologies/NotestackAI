import { NavLink, Outlet, Navigate } from "react-router-dom";
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

export default function AppShell() {
  const { user, loading, logout } = useAuth();
  if (loading) return <div className="boot"><div className="orbit-loader"><span /></div></div>;
  if (!user) return <Navigate to="/auth" replace />;

  return (
    <div className="shell">
      <SkyCanvas intensity={0.35} />
      <aside className="sidebar">
        <NavLink to="/" className="sidebar-brand">
          <Logo size={28} />
        </NavLink>
        <nav aria-label="App">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `side-link${isActive ? " active" : ""}`}>
              <Icon />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-user">
          <span className="mono muted">{user.email}</span>
          <button className="link-btn" onClick={logout}>
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

export function ComingSoon({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="empty-state">
      <svg width="120" height="90" viewBox="0 0 120 90" fill="none" aria-hidden="true" className="empty-art">
        <circle cx="84" cy="30" r="16" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="78" cy="26" r="3" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
        <circle cx="90" cy="36" r="2" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
        <path d="M20 70l14-8 6 10-14 8z" stroke="currentColor" strokeWidth="1.5" />
        <path d="M34 62l10-6M26 80l-6 6" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="20" r="1" fill="currentColor" />
        <circle cx="50" cy="12" r="1" fill="currentColor" />
        <circle cx="108" cy="72" r="1" fill="currentColor" />
      </svg>
      <h1>{title}</h1>
      <p className="muted">This part of the station comes online in {phase}.</p>
      <NavLink to="/app" className="btn">
        Back to Mission Control
      </NavLink>
    </div>
  );
}

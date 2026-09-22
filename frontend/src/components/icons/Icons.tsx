import type { ReactNode, SVGProps } from "react";

/** Custom icon set. One stroke weight (1.5), currentColor: white by default, #217cff + glow when
 * the parent has .active (see .icon in app.css). Always pair with a plain text label. */

type P = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const RadarIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <path d="M12 12l6-6" />
    <circle cx="15.5" cy="9" r="0.8" fill="currentColor" />
  </Icon>
);

export const PlanetIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="6" />
    <ellipse cx="12" cy="12" rx="10.5" ry="3.5" transform="rotate(-20 12 12)" />
  </Icon>
);

export const SatelliteDishIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 10a8 8 0 0 0 10 10L4 10z" />
    <path d="M9 15l4-4" />
    <path d="M14 4a6 6 0 0 1 6 6" />
    <path d="M14 7.5a2.5 2.5 0 0 1 2.5 2.5" />
    <path d="M6 21h6" />
  </Icon>
);

export const TelescopeIcon = (p: P) => (
  <Icon {...p}>
    <path d="M3 13l12-6 2 4-12 6z" />
    <path d="M15 7l3-1.5 2 4L17 11" />
    <path d="M10 15l-3 6M10 15l3 6" />
  </Icon>
);

export const ConstellationIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5 18l5-6 4 3 5-9" opacity="0.6" />
    <circle cx="5" cy="18" r="1.2" fill="currentColor" />
    <circle cx="10" cy="12" r="1.2" fill="currentColor" />
    <circle cx="14" cy="15" r="1.2" fill="currentColor" />
    <circle cx="19" cy="6" r="1.2" fill="currentColor" />
  </Icon>
);

export const HelmetIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 14a8 8 0 1 1 16 0v3a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" />
    <rect x="7" y="9" width="10" height="6" rx="3" />
    <path d="M14.5 11l1 1" />
  </Icon>
);

export const SignalIcon = (p: P) => (
  <Icon {...p}>
    <path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4M21 12h0" />
  </Icon>
);

export const LaunchWindowIcon = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="M16 10l5-3v10l-5-3" />
    <path d="M9.5 15v-5.5l1.5-1.5 1.5 1.5V15" />
  </Icon>
);

export const RocketIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12 2c3 2.5 4.5 6 4.5 10L14 16h-4l-2.5-4C7.5 8 9 4.5 12 2z" />
    <circle cx="12" cy="9" r="1.6" />
    <path d="M7.5 12L5 15l3 1M16.5 12l2.5 3-3 1" />
    <path d="M10.5 19l1.5 3 1.5-3" />
  </Icon>
);

export const LaunchpadIcon = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 9h18M8 3v4M16 3v4" />
    <path d="M12 12v6M10 16l2 2 2-2" />
  </Icon>
);

export const AsteroidIcon = (p: P) => (
  <Icon {...p}>
    <path d="M7 5l6-1 5 4 1 6-4 5-7 0-4-5 1-6z" />
    <circle cx="10" cy="10" r="1.2" />
    <circle cx="14.5" cy="14" r="1.6" />
  </Icon>
);

export const CometIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="16" cy="8" r="3" />
    <path d="M13.5 10.5L3 21M14 12l-6 6M12 9l-6 3" opacity="0.7" />
  </Icon>
);

export const OrbitIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="2.5" />
    <circle cx="12" cy="12" r="8.5" strokeDasharray="2 3" />
    <circle cx="20.5" cy="12" r="1.2" fill="currentColor" />
  </Icon>
);

export const ArrowRightIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

export const CheckIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const SparkleIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12 3l1.8 7.2L21 12l-7.2 1.8L12 21l-1.8-7.2L3 12l7.2-1.8z" />
  </Icon>
);

import type { SVGProps } from "react";
import type { Platform } from "@notestack/shared/types";

export type SocialBrand = Platform;

type Props = SVGProps<SVGSVGElement> & {
  brand: SocialBrand;
  size?: number;
};

/** A connected account's profile picture, with account initials instead of a
 * platform logo when the provider has no picture. */
export function SocialAccountAvatar({ avatarUrl, handle }: { avatarUrl?: string | null; handle: string }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt={`${handle} profile`} />;
  }

  const words = handle.replace(/^@/, "").trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? `${words[0][0]}${words[words.length - 1][0]}` : words[0]?.slice(0, 1) || "?").toUpperCase();
  return <span className="lp-preview-avatar" aria-label={`${handle} profile`}>{initials}</span>;
}

/** Official social marks, kept as local SVG so the composer never waits on a third-party image host. */
export function SocialBrandIcon({ brand, size = 22, ...props }: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    "aria-hidden": true,
    focusable: false,
    ...props,
  } as const;

  if (brand === "x") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
      </svg>
    );
  }

  if (brand === "facebook") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M13.7 22v-9h3l.5-3.5h-3.5V7.3c0-1 .3-1.7 1.8-1.7h1.9V2.5c-.3 0-1.5-.1-2.8-.1-2.8 0-4.7 1.7-4.7 4.8v2.3H6.8V13h3.1v9h3.8Z" />
      </svg>
    );
  }

  if (brand === "instagram") {
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4.1" />
        <circle cx="17.4" cy="6.7" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (brand === "threads") {
    return (
      <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18.2 8.3C17.4 4.8 15.2 3 12 3 7.9 3 5.2 6.1 5.2 11.9c0 5.7 2.6 9.1 7 9.1 3.9 0 6.7-2.2 6.7-5.5 0-3-2.3-4.8-6.1-4.8-3.1 0-5.1 1.5-5.1 3.7 0 1.8 1.4 3.1 3.5 3.1 3 0 5.1-2.4 5.1-6.1 0-3.5-1.7-5.6-4.6-5.6-2.1 0-3.5 1.1-4.1 2.6" />
      </svg>
    );
  }

  if (brand === "linkedin") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M5.2 7.8H1.6V22h3.6V7.8ZM3.4 2A2.1 2.1 0 1 0 3.4 6.2 2.1 2.1 0 0 0 3.4 2ZM22.4 13.9c0-4.3-2.3-6.4-5.4-6.4a4.7 4.7 0 0 0-4.3 2.4V7.8H9.1V22h3.6v-7c0-1.9.4-3.7 2.7-3.7 2.3 0 2.3 2.1 2.3 3.8V22h3.7l1-8.1Z" />
      </svg>
    );
  }

  if (brand === "bluesky") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M12 10.8c-.9-1.7-3.4-4.9-5.8-6.6C3.9 2.6 3 2.9 2.4 3.2 1.7 3.5 1.5 4.5 1.5 5c0 .5.3 4.4.5 5 .7 2.4 3.1 3.2 5.3 2.9-3.8.6-7.1 2.1-2.7 7 4.8 5 6.5-1.1 7.4-4.2.9 3.1 1.9 9 6.7 4.2 4.3-4.4 1.2-6.2-2.7-7 2.2.3 4.6-.5 5.3-2.9.2-.6.5-4.5.5-5 0-.5-.2-1.5-.9-1.8-.6-.3-1.5-.6-3.8 1-2.4 1.7-4.9 4.9-5.8 6.6Z" />
      </svg>
    );
  }

  if (brand === "substack_notes") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M4 3h16v2H4V3Zm0 4h16v2H4V7Zm0 4h16v10l-8-4.5L4 21V11Z" />
      </svg>
    );
  }

  return (
    <svg {...common} fill="currentColor">
      <path d="M5.2 4.3h13.6A2.2 2.2 0 0 1 21 6.5v11a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.5v-11a2.2 2.2 0 0 1 2.2-2.2Zm2.3 4.1v7.2h2V9.8l5 5.8h2V8.4h-2v5.8l-5-5.8h-2Z" />
    </svg>
  );
}


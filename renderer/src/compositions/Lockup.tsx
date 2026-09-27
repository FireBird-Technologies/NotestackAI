import { Img, staticFile } from "remotion";
import { theme } from "../theme";

/** The navbar logo: the mark (public/logo.svg, copied from frontend/public/logo.svg) with the
 * "Notestack" wordmark beside it, in the same proportions as the site (32 px mark, 10 px gap,
 * Space Grotesk 600 at 18 px). `suffix` adds a word after it in blue, such as "AI". */
export function Lockup({ size, suffix, glow = 1 }: { size: number; suffix?: string; glow?: number }) {
  const text = (size * 18) / 32;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: (size * 10) / 32 }}>
      <Img
        src={staticFile("logo.svg")}
        width={size}
        height={size}
        style={{ borderRadius: (size * 9) / 32, boxShadow: `0 0 ${size * 0.6 * glow}px ${theme.blue}, 0 0 ${size * 0.2 * glow}px ${theme.white}` }}
      />
      <span style={{ fontFamily: theme.display, fontWeight: 600, fontSize: text, letterSpacing: "0.01em", lineHeight: 1, color: theme.white, textShadow: glow ? `0 0 ${text * 0.5 * glow}px ${theme.blue}` : undefined }}>
        Notestack
        {suffix && <span style={{ color: theme.blue, marginLeft: text * 0.28 }}>{suffix}</span>}
      </span>
    </div>
  );
}

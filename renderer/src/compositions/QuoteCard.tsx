import { AbsoluteFill } from "remotion";
import type { QuoteCardProps } from "../schema";
import { theme } from "../theme";
import { Starfield } from "./Starfield";

export function QuoteCard({ quote, author, publication, brand }: QuoteCardProps) {
  const accent = brand.accent ?? theme.blue;
  return (
    <AbsoluteFill>
      <Starfield count={90} accent={accent} />
      <AbsoluteFill style={{ padding: 110, justifyContent: "center" }}>
        <div style={{ width: 80, height: 4, background: accent, boxShadow: `0 0 20px ${accent}`, marginBottom: 48 }} />
        <p style={{ fontFamily: theme.display, fontSize: quote.length > 200 ? 48 : 62, lineHeight: 1.25, color: theme.white }}>
          {quote}
        </p>
        <p style={{ fontFamily: theme.mono, fontSize: 28, marginTop: 48, color: "rgba(255,255,255,0.72)" }}>
          {author}
          {publication ? ` · ${publication}` : ""}
        </p>
      </AbsoluteFill>
      {brand.logoUrl && (
        <img src={brand.logoUrl} style={{ position: "absolute", right: 60, bottom: 60, width: 72, height: 72 }} />
      )}
    </AbsoluteFill>
  );
}

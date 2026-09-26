import { AbsoluteFill } from "remotion";
import type { CarouselSlideProps } from "../schema";
import { theme } from "../theme";
import { Logo } from "./shared";
import { Starfield } from "./Starfield";

/** One 4:5 carousel slide (LinkedIn / Instagram). The renderer produces one PNG per slide. */
export function CarouselSlide({ heading, body, index, total, brand }: CarouselSlideProps) {
  const accent = brand.accent ?? theme.blue;
  const cover = index === 1;
  return (
    <AbsoluteFill>
      <Starfield count={80} accent={accent} />
      <AbsoluteFill style={{ padding: 100, justifyContent: cover ? "center" : "flex-start", paddingTop: cover ? 100 : 160 }}>
        <div style={{ width: 90, height: 5, background: accent, boxShadow: `0 0 20px ${accent}`, marginBottom: 48 }} />
        <h1
          style={{
            fontFamily: theme.display,
            fontSize: cover ? 96 : heading.length > 60 ? 62 : 74,
            lineHeight: 1.08,
            color: theme.white,
            textShadow: cover ? `0 0 40px ${accent}88` : undefined,
          }}
        >
          {heading}
        </h1>
        {body && (
          <p style={{ fontFamily: theme.body, fontSize: body.length > 280 ? 36 : 42, lineHeight: 1.4, marginTop: 44, color: "rgba(255,255,255,0.86)" }}>
            {body}
          </p>
        )}
      </AbsoluteFill>
      <p style={{ position: "absolute", left: 100, bottom: 70, fontFamily: theme.mono, fontSize: 28, color: "rgba(255,255,255,0.6)" }}>
        {brand.name ? `${brand.name} · ` : ""}
        {index} / {total}
      </p>
      <Logo url={brand.logoUrl} size={72} inset={60} />
    </AbsoluteFill>
  );
}

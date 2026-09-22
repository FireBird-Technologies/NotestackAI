import { Composition, Still } from "remotion";
import { QuoteCard } from "./compositions/QuoteCard";
import { ShortVertical, shortVerticalDuration } from "./compositions/ShortVertical";
import { FPS, quoteCardSchema, shortVerticalSchema, type ShortVerticalProps } from "./schema";

const sampleShort: ShortVerticalProps = {
  hook: "Your archive already is a podcast",
  scenes: [
    { type: "section", onScreenText: "You have written hundreds of thousands of words.", narration: "", durationS: 3 },
    { type: "pull_quote", onScreenText: "If a host says it, you wrote it.", narration: "", durationS: 3, citation: "Notestack blog" },
    { type: "outro", onScreenText: "Paste your Substack URL. Launch.", narration: "", durationS: 2.5 },
  ],
  captions: [],
  brand: {},
};

export function Root() {
  return (
    <>
      <Composition
        id="ShortVertical"
        component={ShortVertical}
        schema={shortVerticalSchema}
        width={1080}
        height={1920}
        fps={FPS}
        durationInFrames={shortVerticalDuration(sampleShort)}
        defaultProps={sampleShort}
        calculateMetadata={({ props }) => ({ durationInFrames: shortVerticalDuration(props) })}
      />
      <Still
        id="QuoteCard"
        component={QuoteCard}
        schema={quoteCardSchema}
        width={1080}
        height={1080}
        defaultProps={{ quote: "Every sentence, traceable.", author: "Notestack", brand: {} }}
      />
    </>
  );
}

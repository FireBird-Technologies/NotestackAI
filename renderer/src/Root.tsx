import { Composition, Still } from "remotion";
import { AudiogramSquare, audiogramDuration } from "./compositions/AudiogramSquare";
import { CarouselSlide } from "./compositions/CarouselSlide";
import { ExplainerLong, explainerDuration } from "./compositions/ExplainerLong";
import { QuoteCard } from "./compositions/QuoteCard";
import { ShortVertical, shortVerticalDuration } from "./compositions/ShortVertical";
import {
  FPS,
  audiogramSquareSchema,
  carouselSlideSchema,
  explainerLongSchema,
  quoteCardSchema,
  shortVerticalSchema,
  type AudiogramSquareProps,
  type ExplainerLongProps,
  type ShortVerticalProps,
} from "./schema";

const sampleScenes: ShortVerticalProps["scenes"] = [
  { type: "section", onScreenText: "You have written hundreds of thousands of words.", narration: "", durationS: 3 },
  { type: "pull_quote", onScreenText: "If a host says it, you wrote it.", narration: "", durationS: 3, citation: "Notestack blog" },
  { type: "outro", onScreenText: "Paste your Substack URL. Launch.", narration: "", durationS: 2.5 },
];

const sampleShort: ShortVerticalProps = {
  hook: "Your archive already is a podcast",
  scenes: sampleScenes,
  captions: [],
  brand: {},
};

const sampleExplainer: ExplainerLongProps = { title: "Why your archive is an asset", scenes: sampleScenes, captions: [], brand: {} };

const sampleAudiogram: AudiogramSquareProps = {
  title: "Audio overview",
  audioUrl: "https://cdn.jsdelivr.net/npm/@remotion/example-videos@1.0.0/audio.mp3",
  durationS: 8,
  segments: [{ speaker: "host_a", text: "Welcome back to the archive.", startMs: 0, endMs: 4000 }],
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
      <Composition
        id="ExplainerLong"
        component={ExplainerLong}
        schema={explainerLongSchema}
        width={1920}
        height={1080}
        fps={FPS}
        durationInFrames={explainerDuration(sampleExplainer)}
        defaultProps={sampleExplainer}
        calculateMetadata={({ props }) => ({ durationInFrames: explainerDuration(props) })}
      />
      <Composition
        id="AudiogramSquare"
        component={AudiogramSquare}
        schema={audiogramSquareSchema}
        width={1080}
        height={1080}
        fps={FPS}
        durationInFrames={audiogramDuration(sampleAudiogram)}
        defaultProps={sampleAudiogram}
        calculateMetadata={({ props }) => ({ durationInFrames: audiogramDuration(props) })}
      />
      <Still
        id="QuoteCard"
        component={QuoteCard}
        schema={quoteCardSchema}
        width={1080}
        height={1080}
        defaultProps={{ quote: "Every sentence, traceable.", author: "Notestack", brand: {} }}
      />
      <Still
        id="CarouselSlide"
        component={CarouselSlide}
        schema={carouselSlideSchema}
        width={1080}
        height={1350}
        defaultProps={{ heading: "Your archive is a launch engine", body: "", index: 1, total: 6, brand: {} }}
      />
    </>
  );
}
